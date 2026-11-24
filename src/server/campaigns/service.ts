/**
 * Kampanjer på automaternas skärm (Automater → Kampanjer): läsa, skapa, skicka till Awish,
 * stänga av och försöka igen.
 *
 * Behörighet: ägare, admin och läsare läser (som användaren med RLS). Bara ägare och admin
 * skapar och stänger av; rollen kontrolleras mot databasen före varje skrivning. Skrivningen
 * görs sedan som systemrollen för just den organisationen (tabellerna har inga
 * skrivrättigheter för klienter), och anropen till Awish görs bara efter användarens
 * bekräftelse i appen, eller av den schemalagda körningen för en kampanj som användaren
 * har bekräftat med en senare start.
 */

import "server-only";

import { createHash, randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { getServiceDb, type Db, type Tx } from "@/db/client";
import type { IsoDate } from "@/domain";
import type { FileStore } from "@/import/file-store";
import { businessDateOf } from "@/import/zoned";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { ECONOMY_ROLES, OPERATOR_ROLES } from "@/server/data/core/types";
import { recordJobOutcome } from "@/server/monitoring/failures";

import { AwishApiError, type AwishMarketingApi } from "../awish/grpc-client";
import { recordPathResult } from "../awish/health";
import {
  AwishNotConnectedError,
  awishSourceOf,
  linkedMachines,
  marketingClient,
  marketingConnectUntil,
  type LinkedMachine,
  type MarketingConnect,
} from "../awish/marketing";
import { campaignImagePath, campaignImageStore, campaignPublicUrl } from "./images";
import {
  CAMPAIGN_IMAGE_MAX_BYTES,
  CampaignError,
  campaignState,
  campaignWindow,
  findCreatedBanner,
  findExistingBanner,
  sniffCampaignImage,
  suggestCampaigns,
  unixSeconds,
  type CampaignImageType,
  type CampaignInput,
  type CampaignState,
  type CampaignSuggestion,
  type MachineRunStatus,
} from "./model";

type Row = Record<string, unknown>;
type Env = Readonly<Record<string, string | undefined>>;

async function query<T extends Row>(db: Db | Tx, q: ReturnType<typeof sql>): Promise<T[]> {
  return Array.from(await db.execute(q)) as T[];
}

/** Tidpunkt som parameter (postgres.js tar inte Date i råa frågor). */
function tsParam(d: Date | null) {
  return d === null ? sql`null::timestamptz` : sql`${d.toISOString()}::timestamptz`;
}

export interface CampaignDeps {
  readonly db?: Db;
  readonly connect?: MarketingConnect;
  readonly store?: FileStore;
  readonly env?: Env;
  readonly now?: () => Date;
}

const dbOf = (deps: CampaignDeps) => deps.db ?? getServiceDb();
const nowOf = (deps: CampaignDeps) => (deps.now ?? (() => new Date()))();

/** Felet till användaren: Awish text eller vårt eget, aldrig hela felet. */
function shortError(error: unknown): string {
  if (error instanceof AwishApiError || error instanceof CampaignError) return error.message;
  if (error instanceof AwishNotConnectedError) return error.message;
  return "Awish svarade inte som väntat.";
}

// ---------------------------------------------------------------------------
// Läsa
// ---------------------------------------------------------------------------

export interface CampaignMachineView {
  readonly machineId: string;
  readonly code: string;
  readonly name: string;
  readonly status: MachineRunStatus;
  readonly error: string | null;
}

export interface CampaignView {
  readonly id: string;
  readonly title: string;
  readonly titleId: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly stoppedAt: string | null;
  readonly state: CampaignState;
  readonly createdBy: string | null;
  readonly machines: CampaignMachineView[];
}

export interface CampaignPageData {
  /** Organisationen har en Awish API-källa med uppgifter. */
  readonly connected: boolean;
  readonly linked: LinkedMachine[];
  /** Visas nu, planerade och de som inte kom fram (inte slut). */
  readonly current: CampaignView[];
  /** Slut eller avstängda (de senaste 10). */
  readonly past: CampaignView[];
  readonly suggestions: CampaignSuggestion[];
  /** Bilder som redan använts (senaste först, en per bild). */
  readonly library: { campaignId: string; title: string }[];
}

const iso = (v: unknown): string =>
  new Date(String(v instanceof Date ? v.toISOString() : v)).toISOString();

export async function loadCampaignPageFor(
  viewer: Viewer,
  deps: CampaignDeps = {},
): Promise<CampaignPageData> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  const now = nowOf(deps);
  const today = businessToday(now, viewer.organization.timezone);
  const db = dbOf(deps);
  const [linked, connected] = await Promise.all([
    linkedMachines(db, orgId),
    query<{ ok: boolean }>(
      db,
      sql`select exists (select 1 from public.data_sources ds
            where ds.organization_id = ${orgId}::uuid and ds.provider = 'awish_grpc'
              and ds.archived_at is null and ds.secret_ref is not null) as ok`,
    ).then((r) => r[0]?.ok === true),
  ]);

  return withUserDbFor(viewer.user, async (tx) => {
    const campaigns = await query<{
      id: string;
      title: string;
      title_id: string | null;
      starts_at: Date;
      ends_at: Date;
      stopped_at: Date | null;
      created_at: Date;
      created_by_name: string | null;
    }>(
      tx,
      sql`select c.id, c.title, c.title_id, c.starts_at, c.ends_at, c.stopped_at, c.created_at,
                 (select p.display_name from public.profiles p
                   where p.organization_id = c.organization_id and p.user_id = c.created_by
                   limit 1) as created_by_name
          from public.campaigns c
          where c.organization_id = ${orgId}::uuid
          order by c.created_at desc
          limit 60`,
    );
    const ids = campaigns.map((c) => c.id);
    const machineRows = ids.length
      ? await query<{
          campaign_id: string;
          machine_id: string;
          code: string;
          name: string;
          status: MachineRunStatus;
          error: string | null;
        }>(
          tx,
          sql`select cm.campaign_id, cm.machine_id, m.code, m.name, cm.status, cm.error
              from public.campaign_machines cm
              join public.machines m on m.organization_id = cm.organization_id and m.id = cm.machine_id
              where cm.organization_id = ${orgId}::uuid
                and cm.campaign_id = any (${`{${ids.join(",")}}`}::uuid[])
              order by m.code`,
        )
      : [];
    const byCampaign = new Map<string, CampaignMachineView[]>();
    for (const r of machineRows) {
      const list = byCampaign.get(r.campaign_id) ?? [];
      list.push({
        machineId: r.machine_id,
        code: r.code,
        name: r.name,
        status: r.status,
        error: r.error,
      });
      byCampaign.set(r.campaign_id, list);
    }
    const views: CampaignView[] = campaigns.map((c) => {
      const machines = byCampaign.get(c.id) ?? [];
      const startsAt = new Date(iso(c.starts_at));
      const endsAt = new Date(iso(c.ends_at));
      const stoppedAt = c.stopped_at ? new Date(iso(c.stopped_at)) : null;
      return {
        id: c.id,
        title: c.title,
        titleId: c.title_id,
        startsAt: startsAt.toISOString(),
        endsAt: endsAt.toISOString(),
        stoppedAt: stoppedAt?.toISOString() ?? null,
        state: campaignState({ startsAt, endsAt, stoppedAt }, machines, now),
        createdBy: c.created_by_name,
        machines,
      };
    });

    const library: { campaignId: string; title: string }[] = [];
    const seen = new Set<string>();
    const paths = await query<{ id: string; title: string; image_path: string }>(
      tx,
      sql`select id, title, image_path from public.campaigns
          where organization_id = ${orgId}::uuid order by created_at desc limit 60`,
    );
    for (const p of paths) {
      if (seen.has(p.image_path) || library.length >= 8) continue;
      seen.add(p.image_path);
      library.push({ campaignId: p.id, title: p.title });
    }

    // Första dagen i flottan = tidigaste av sortimentet och första försäljningen (testköp
    // räknas inte), om perioden gäller i dag och vad som finns i automaten nu.
    const firstStocked = await query<{
      title_id: string;
      title_name: string;
      machine_id: string;
      first_on: string;
      first_sale: string | null;
      current: boolean;
      on_hand: number | null;
    }>(
      tx,
      sql`select ms.title_id, t.name as title_name, ms.machine_id,
                 min(ms.valid_from)::text as first_on,
                 (select min(o.business_date)::text from public.orders o
                   where o.organization_id = ms.organization_id and o.machine_id = ms.machine_id
                     and o.title_id = ms.title_id and o.test_purchase_at is null) as first_sale,
                 bool_or(ms.valid_to is null or ms.valid_to >= ${today}::date) as current,
                 (select sum(sl.quantity)::int from public.stock_levels sl
                   join public.stock_locations l
                     on l.organization_id = sl.organization_id and l.id = sl.location_id
                   where sl.organization_id = ms.organization_id and l.machine_id = ms.machine_id
                     and sl.title_id = ms.title_id and l.archived_at is null) as on_hand
          from public.machine_slots ms
          join public.titles t on t.organization_id = ms.organization_id and t.id = ms.title_id
          where ms.organization_id = ${orgId}::uuid and ms.slots > 0
            and t.archived_at is null and t.merged_into_id is null
          group by ms.organization_id, ms.title_id, t.name, ms.machine_id`,
    );
    const suggestions = suggestCampaigns({
      firstStocked: firstStocked.map((r) => ({
        titleId: r.title_id,
        titleName: r.title_name,
        machineId: r.machine_id,
        firstOn: r.first_on as IsoDate,
        firstSale: (r.first_sale ?? null) as IsoDate | null,
        current: r.current !== false,
        onHand: r.on_hand === null || r.on_hand === undefined ? null : Number(r.on_hand),
      })),
      campaigned: campaigns
        .filter((c) => c.title_id !== null)
        .map((c) => ({
          titleId: c.title_id!,
          createdOn: businessDateOf(
            new Date(iso(c.created_at)),
            viewer.organization.timezone,
          ) as IsoDate,
        })),
      linkedMachineIds: linked.map((m) => m.machineId),
      today,
    });

    const isPast = (v: CampaignView) => v.state === "ended" || v.state === "stopped";
    return {
      connected,
      linked,
      current: views.filter((v) => !isPast(v)),
      past: views.filter(isPast).slice(0, 10),
      suggestions,
      library,
    };
  });
}

/** Visningar och tryck i Awish per kampanj (bara de som visas). Fel = null, inte ett fel. */
export async function loadCampaignStatsFor(
  viewer: Viewer,
  deps: CampaignDeps = {},
): Promise<Record<string, { views: number; hits: number } | null>> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  const db = dbOf(deps);
  const rows = await query<{
    campaign_id: string;
    awish_machine_id: string;
    awish_banner_id: string;
  }>(
    db,
    sql`select cm.campaign_id, cm.awish_machine_id, cm.awish_banner_id
        from public.campaign_machines cm
        join public.campaigns c on c.organization_id = cm.organization_id and c.id = cm.campaign_id
        where cm.organization_id = ${orgId}::uuid and cm.status = 'shown'
          and cm.awish_banner_id is not null and c.stopped_at is null and c.ends_at > now()`,
  );
  const out: Record<string, { views: number; hits: number } | null> = {};
  if (rows.length === 0) return out;
  let api: AwishMarketingApi;
  try {
    api = await marketingClient(db, orgId, deps.connect);
  } catch {
    return out;
  }
  try {
    const machines = [...new Set(rows.map((r) => r.awish_machine_id))];
    const lists = await Promise.all(
      machines.map((m) =>
        api.banners(m).then(
          (list) => [m, list] as const,
          () => [m, null] as const,
        ),
      ),
    );
    const byMachine = new Map(lists);
    for (const r of rows) {
      const list = byMachine.get(r.awish_machine_id);
      const prev = out[r.campaign_id];
      if (list === null || list === undefined || prev === null) {
        out[r.campaign_id] = null;
        continue;
      }
      const b = list.find((x) => x.id === r.awish_banner_id);
      out[r.campaign_id] = {
        views: (prev?.views ?? 0) + (b?.viewsCount ?? 0),
        hits: (prev?.hits ?? 0) + (b?.hitCount ?? 0),
      };
    }
    return out;
  } finally {
    api.close();
  }
}

/** Bilden för appens bildväg: bara om kampanjen finns i användarens organisation (RLS). */
export async function readCampaignImageFor(
  viewer: Viewer,
  campaignId: string,
  deps: CampaignDeps = {},
): Promise<{ bytes: Uint8Array; type: CampaignImageType } | null> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  const [row] = await withUserDbFor(viewer.user, (tx) =>
    query<{ image_path: string; image_type: CampaignImageType }>(
      tx,
      sql`select image_path, image_type from public.campaigns
          where organization_id = ${orgId}::uuid and id = ${campaignId}::uuid`,
    ),
  );
  if (!row) return null;
  const store = deps.store ?? campaignImageStore(deps.env);
  let bytes: Uint8Array;
  try {
    bytes = await store.get(row.image_path);
  } catch {
    return null;
  }
  // Kontrollera innehållet igen: bara bildtyperna skickas till webbläsaren.
  if (sniffCampaignImage(bytes) !== row.image_type) return null;
  return { bytes, type: row.image_type };
}

// ---------------------------------------------------------------------------
// Skicka till Awish
// ---------------------------------------------------------------------------

type PendingRow = {
  id: string;
  campaign_id: string;
  awish_machine_id: string;
  title: string;
  image_url: string;
  ends_at: Date;
};

/**
 * Skickar kampanjens planerade automater (eller alla förfallna i organisationen) till
 * Awish. Varje rad tas med ett villkorat byte scheduled → sending, så att två körningar
 * aldrig skickar samma rad. Resultatet per rad: shown (med Awish id om det syns) eller
 * failed med Awish meddelande.
 */
export async function publishDue(
  db: Db,
  orgId: string,
  opts: {
    campaignId?: string;
    connect?: MarketingConnect;
    now: Date;
    /** Ingen ny automat påbörjas efter den här tiden (ms); resten skickas nästa körning. */
    deadlineAt?: number;
  },
): Promise<{ shown: number; failed: number }> {
  const due = await query<PendingRow>(
    db,
    sql`select cm.id, cm.campaign_id, cm.awish_machine_id, c.title, c.image_url, c.ends_at
        from public.campaign_machines cm
        join public.campaigns c on c.organization_id = cm.organization_id and c.id = cm.campaign_id
        where cm.organization_id = ${orgId}::uuid and cm.status = 'scheduled'
          and c.stopped_at is null and c.starts_at <= ${tsParam(opts.now)} and c.ends_at > ${tsParam(opts.now)}
          ${opts.campaignId ? sql`and c.id = ${opts.campaignId}::uuid` : sql``}
        order by c.starts_at, cm.created_at`,
  );
  if (due.length === 0) return { shown: 0, failed: 0 };
  let api: AwishMarketingApi;
  try {
    api = await marketingClient(db, orgId, opts.connect);
  } catch (error) {
    const message = shortError(error);
    for (const r of due) {
      await db.execute(
        sql`update public.campaign_machines
            set status = 'failed', error = ${message}, ${nextRetrySql(opts.now)}
            where organization_id = ${orgId}::uuid and id = ${r.id}::uuid and status = 'scheduled'`,
      );
    }
    return { shown: 0, failed: due.length };
  }
  let shown = 0;
  let failed = 0;
  let firstError: unknown = null;
  try {
    for (const r of due) {
      // Tiden är slut: raden står kvar som planerad och skickas nästa körning.
      if (opts.deadlineAt !== undefined && Date.now() + CAMPAIGN_MIN_MACHINE_MS > opts.deadlineAt) {
        break;
      }
      const claimed = await query<{ id: string }>(
        db,
        sql`update public.campaign_machines set status = 'sending', error = null
            where organization_id = ${orgId}::uuid and id = ${r.id}::uuid and status = 'scheduled'
            returning id`,
      );
      if (claimed.length === 0) continue;
      const expiredAt = unixSeconds(new Date(iso(r.ends_at)));
      const wanted = { coverImage: r.image_url, title: r.title };
      try {
        // Listan före skapandet är skyddet mot dubbla kampanjer: utan den går det inte att
        // se om ett avbrutet CreateBanner ändå skapade kampanjen. Går den inte att läsa
        // skickas ingenting (raden blir failed och försöks igen automatiskt).
        const before = await api.banners(r.awish_machine_id);
        // Ett tidigare försök (som såg ut att misslyckas, eller stoppades mitt i) gick ändå
        // fram: kampanjen finns redan. Den räknas som visad och skickas inte igen.
        const existing = findExistingBanner(before, { ...wanted, expiredAt });
        if (existing) {
          await db.execute(
            sql`update public.campaign_machines
                set status = 'shown', awish_banner_id = ${existing.id}, sent_at = ${tsParam(opts.now)}
                where organization_id = ${orgId}::uuid and id = ${r.id}::uuid`,
          );
          shown += 1;
          continue;
        }
        try {
          await api.createBanner({
            machineId: r.awish_machine_id,
            coverImage: r.image_url,
            title: r.title,
            expiredAt,
          });
        } catch (error) {
          // Ett avbrutet svar kan ändå ha skapat kampanjen i Awish. Finns den nu räknas den
          // som visad, så att "Försök igen" inte lägger upp den två gånger.
          const again = await api.banners(r.awish_machine_id).catch(() => null);
          if (!again || !findCreatedBanner(before, again, wanted)) throw error;
        }
        const after = await api.banners(r.awish_machine_id).catch(() => []);
        const banner = findCreatedBanner(before, after, wanted);
        await db.execute(
          sql`update public.campaign_machines
              set status = 'shown', awish_banner_id = ${banner?.id ?? null}, sent_at = ${tsParam(opts.now)}
              where organization_id = ${orgId}::uuid and id = ${r.id}::uuid`,
        );
        shown += 1;
      } catch (error) {
        firstError ??= error;
        await db.execute(
          sql`update public.campaign_machines
              set status = 'failed', error = ${shortError(error)}, ${nextRetrySql(opts.now)}
              where organization_id = ${orgId}::uuid and id = ${r.id}::uuid`,
        );
        failed += 1;
      }
    }
  } finally {
    api.close();
  }
  await recordCampaignHealth(db, orgId, shown + failed > 0, failed === 0, firstError, opts.now);
  return { shown, failed };
}

/** En automat påbörjas bara med minst så här lång tid kvar (lista, skapa, lista). */
const CAMPAIGN_MIN_MACHINE_MS = 5_000;
/** En rad som har stått som "skickas" så här länge stoppades mitt i (funktionen dog). */
export const CAMPAIGN_STUCK_SENDING_MS = 10 * 60_000;

/**
 * Väntan (minuter) före automatiskt försök 1, 2 och 3 med en automat där kampanjen inte kom
 * fram. Därefter inga fler automatiska försök ("Försök igen" finns kvar).
 */
export const CAMPAIGN_RETRY_MIN: readonly number[] = [5, 15, 60];

/** `next_retry_at` efter ett misslyckande, räknat på radens retry_count. */
function nextRetrySql(now: Date) {
  const steps = CAMPAIGN_RETRY_MIN.map(
    (m, i) => sql`when ${i} then ${tsParam(new Date(now.getTime() + m * 60_000))}`,
  );
  return sql`next_retry_at = case retry_count ${sql.join(steps, sql` `)} else null::timestamptz end`;
}

/** Hälsan för vägen "campaigns" (Datakällor, vakten). Kastar aldrig. */
async function recordCampaignHealth(
  db: Db,
  orgId: string,
  contacted: boolean,
  ok: boolean,
  error: unknown,
  now: Date,
): Promise<void> {
  if (!contacted) return;
  try {
    const source = await awishSourceOf(db, orgId);
    if (!source) return;
    await recordPathResult(db, {
      organizationId: orgId,
      dataSourceId: source.id,
      path: "campaigns",
      route: ok ? "open_api" : "ingen",
      ok,
      ...(ok ? {} : { error }),
      now,
    });
  } catch (e) {
    console.error("[kampanjer] hälsan kunde inte sparas", e instanceof Error ? e.name : "fel");
  }
}

/**
 * Automater där kampanjen inte kom fram och väntetiden har gått (CAMPAIGN_RETRY_MIN): de
 * läggs tillbaka som planerade, så att körningen nedan skickar dem igen med samma skydd mot
 * dubbla kampanjer. Högst 3 automatiska försök per automat. Kastar inte.
 */
export async function requeueFailedCampaigns(db: Db, now: Date): Promise<number> {
  try {
    // Rader som stoppades mitt i en sändning (funktionen dog): de blir misslyckade med ett
    // nytt försök, och försöket ser i Awish om kampanjen ändå kom fram (ingen dubblett).
    await db.execute(
      sql`update public.campaign_machines
          set status = 'failed', error = 'Sändningen avbröts. Försöker igen.', ${nextRetrySql(now)}
          where status = 'sending'
            and updated_at < ${tsParam(new Date(now.getTime() - CAMPAIGN_STUCK_SENDING_MS))}`,
    );
    const rows = await query<{ id: string }>(
      db,
      sql`update public.campaign_machines cm
          set status = 'scheduled', error = null, retry_count = cm.retry_count + 1,
              next_retry_at = null
          from public.campaigns c, public.organizations o
          where c.organization_id = cm.organization_id and c.id = cm.campaign_id
            and o.id = cm.organization_id and o.archived_at is null and not o.is_demo
            and cm.status = 'failed' and cm.next_retry_at is not null
            and cm.next_retry_at <= ${tsParam(now)}
            and cm.retry_count < ${CAMPAIGN_RETRY_MIN.length}
            and c.stopped_at is null and c.ends_at > ${tsParam(now)}
          returning cm.id`,
    );
    return rows.length;
  } catch (error) {
    console.error("[kampanjer] nya försök kunde inte planeras", shortError(error));
    return 0;
  }
}

/** Den schemalagda körningen: alla organisationers kampanjer vars start har passerat. */
export async function publishAllDueCampaigns(deps: {
  db: Db;
  connect?: MarketingConnect;
  now?: Date;
  /**
   * Ingen ny organisation eller automat påbörjas efter den här tiden (ms), och varje anrop
   * till Awish kortas till den. Det som inte hinns med skickas nästa körning.
   */
  deadlineAt?: number;
}): Promise<{ organizations: number; shown: number; failed: number }> {
  const now = deps.now ?? new Date();
  // Automater där kampanjen inte kom fram tidigare och vars väntetid har gått.
  await requeueFailedCampaigns(deps.db, now);
  const orgs = await query<{ organization_id: string }>(
    deps.db,
    sql`select distinct cm.organization_id
        from public.campaign_machines cm
        join public.campaigns c on c.organization_id = cm.organization_id and c.id = cm.campaign_id
        join public.organizations o on o.id = cm.organization_id
        where cm.status = 'scheduled' and c.stopped_at is null and o.archived_at is null
          and not o.is_demo
          and c.starts_at <= ${tsParam(now)} and c.ends_at > ${tsParam(now)}`,
  );
  let shown = 0;
  let failed = 0;
  const connect =
    deps.connect ??
    (deps.deadlineAt !== undefined ? marketingConnectUntil(deps.deadlineAt) : undefined);
  for (const o of orgs) {
    if (deps.deadlineAt !== undefined && Date.now() + CAMPAIGN_MIN_MACHINE_MS > deps.deadlineAt) {
      break;
    }
    // En kampanj som inte startade ska höras (larmet job:kampanjer), inte bara loggas.
    let problem: Error | null = null;
    try {
      const r = await publishDue(deps.db, o.organization_id, {
        connect,
        now,
        ...(deps.deadlineAt !== undefined ? { deadlineAt: deps.deadlineAt } : {}),
      });
      shown += r.shown;
      failed += r.failed;
      if (r.failed > 0) {
        problem = new Error(
          `Kampanjen startade inte i ${r.failed} ${r.failed === 1 ? "automat" : "automater"}.`,
        );
      }
    } catch (error) {
      console.error("[kampanjer] schemalagd kampanj kunde inte skickas", shortError(error));
      problem = new Error(shortError(error));
    }
    if (problem) {
      await recordJobOutcome(
        { db: deps.db, now },
        {
          organizationId: o.organization_id,
          job: "kampanjer",
          error: problem,
          severity: "warning",
        },
      );
    }
  }
  await resolveCampaignAlerts(deps.db, now);
  return { organizations: orgs.length, shown, failed };
}

/**
 * Stänger larmet job:kampanjer i organisationer där ingen pågående kampanj längre har en
 * automat som misslyckades (ägaren har försökt igen under Kampanjer, eller stängt av
 * kampanjen). Kastar inte.
 */
export async function resolveCampaignAlerts(db: Db, now: Date = new Date()): Promise<number> {
  try {
    const rows = await query<{ id: string }>(
      db,
      sql`update public.alerts a
          set status = 'closed', closed_at = ${tsParam(now)}
          where a.status = 'open' and a.alert_group = 'system' and a.incident_key = 'job:kampanjer'
            and not exists (
              select 1 from public.campaign_machines cm
              join public.campaigns c
                on c.organization_id = cm.organization_id and c.id = cm.campaign_id
              where cm.organization_id = a.organization_id and cm.status = 'failed'
                and c.stopped_at is null and c.ends_at > ${tsParam(now)})
          returning a.id`,
    );
    return rows.length;
  } catch (error) {
    console.error("[kampanjer] larmet kunde inte stängas", shortError(error));
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Skapa, stänga av, försöka igen
// ---------------------------------------------------------------------------

export interface CreatedCampaign {
  readonly campaignId: string;
  readonly machines: number;
  readonly shown: number;
  readonly failed: number;
  readonly scheduled: boolean;
}

/**
 * Skapar kampanjen efter bekräftelsen: bilden sparas (eller en tidigare bild återanvänds),
 * raderna skrivs och, om starten är nu, skickas kampanjen direkt till Awish.
 */
export async function createCampaignFor(
  viewer: Viewer,
  input: CampaignInput,
  image: Uint8Array | null,
  deps: CampaignDeps = {},
): Promise<CreatedCampaign> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const db = dbOf(deps);
  const now = nowOf(deps);
  const timeZone = viewer.organization.timezone;
  const today = businessToday(now, timeZone);
  const window = campaignWindow(input, { now, today, timeZone });

  const linked = await linkedMachines(db, orgId);
  if (linked.length === 0) {
    throw new CampaignError("Ingen automat är kopplad till Awish. Koppla dem under Datakällor.");
  }
  const targets =
    input.machineIds.length === 0
      ? linked
      : input.machineIds.map((id) => {
          const m = linked.find((x) => x.machineId === id);
          if (!m) throw new CampaignError("En vald automat är inte kopplad till Awish.");
          return m;
        });
  const unique = [...new Map(targets.map((t) => [t.machineId, t])).values()];

  if (input.titleId) {
    const [t] = await query<{ id: string }>(
      db,
      sql`select id from public.titles where organization_id = ${orgId}::uuid and id = ${input.titleId}::uuid`,
    );
    if (!t) throw new CampaignError("Okänd titel.");
  }

  const campaignId = randomUUID();
  let picture: { path: string; url: string; type: CampaignImageType; bytes: number };
  if (input.reuseImageFrom) {
    const [prev] = await query<{
      image_path: string;
      image_url: string;
      image_type: CampaignImageType;
      image_bytes: number;
    }>(
      db,
      sql`select image_path, image_url, image_type, image_bytes from public.campaigns
          where organization_id = ${orgId}::uuid and id = ${input.reuseImageFrom}::uuid`,
    );
    if (!prev) throw new CampaignError("Bilden finns inte längre. Välj en ny.");
    picture = {
      path: prev.image_path,
      url: prev.image_url,
      type: prev.image_type,
      bytes: Number(prev.image_bytes),
    };
  } else {
    if (!image || image.byteLength === 0) throw new CampaignError("Välj en bild.");
    if (image.byteLength > CAMPAIGN_IMAGE_MAX_BYTES) {
      throw new CampaignError("Bilden är för stor (högst 3 MB).");
    }
    const type = sniffCampaignImage(image);
    if (!type) throw new CampaignError("Bilden måste vara PNG, JPG eller WebP.");
    const sha = createHash("sha256").update(image).digest("hex");
    const path = campaignImagePath(orgId, sha, type);
    await (deps.store ?? campaignImageStore(deps.env)).put(path, image, type);
    picture = {
      path,
      url: campaignPublicUrl(path, campaignId, deps.env),
      type,
      bytes: image.byteLength,
    };
  }

  await db.transaction(async (tx) => {
    await tx.execute(
      sql`insert into public.campaigns
            (id, organization_id, title, title_id, image_path, image_url, image_type, image_bytes,
             starts_at, ends_at, created_by)
          values (${campaignId}::uuid, ${orgId}::uuid, ${input.title}, ${input.titleId}::uuid,
                  ${picture.path}, ${picture.url}, ${picture.type}, ${picture.bytes},
                  ${tsParam(window.startsAt)}, ${tsParam(window.endsAt)}, ${viewer.user.userId}::uuid)`,
    );
    for (const m of unique) {
      await tx.execute(
        sql`insert into public.campaign_machines
              (organization_id, campaign_id, machine_id, awish_machine_id, created_by)
            values (${orgId}::uuid, ${campaignId}::uuid, ${m.machineId}::uuid, ${m.awishMachineId},
                    ${viewer.user.userId}::uuid)`,
      );
    }
  });

  if (!window.startsNow) {
    return { campaignId, machines: unique.length, shown: 0, failed: 0, scheduled: true };
  }
  const r = await publishDue(db, orgId, { campaignId, connect: deps.connect, now });
  return { campaignId, machines: unique.length, ...r, scheduled: false };
}

/** Försöker igen med automaterna som inte fick kampanjen. */
export async function retryCampaignFor(
  viewer: Viewer,
  campaignId: string,
  deps: CampaignDeps = {},
): Promise<{ shown: number; failed: number }> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const db = dbOf(deps);
  const now = nowOf(deps);
  const reset = await query<{ id: string }>(
    db,
    sql`update public.campaign_machines cm
        set status = 'scheduled', error = null, retry_count = 0, next_retry_at = null
        from public.campaigns c
        where cm.organization_id = ${orgId}::uuid and cm.campaign_id = ${campaignId}::uuid
          and c.organization_id = cm.organization_id and c.id = cm.campaign_id
          and c.stopped_at is null and c.ends_at > ${tsParam(now)} and cm.status = 'failed'
        returning cm.id`,
  );
  if (reset.length === 0) throw new CampaignError("Inget att försöka igen.");
  return publishDue(db, orgId, { campaignId, connect: deps.connect, now });
}

/**
 * Stänger av kampanjen: Awish utgångstid sätts till nu på varje automat där den visas.
 * Kampanjen räknas som avstängd när alla automater är avstängda; annars visas felet.
 */
export async function stopCampaignFor(
  viewer: Viewer,
  campaignId: string,
  deps: CampaignDeps = {},
): Promise<{ stopped: number; failed: number }> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const db = dbOf(deps);
  const now = nowOf(deps);
  const [campaign] = await query<{ title: string; image_url: string; stopped_at: Date | null }>(
    db,
    sql`select title, image_url, stopped_at from public.campaigns
        where organization_id = ${orgId}::uuid and id = ${campaignId}::uuid`,
  );
  if (!campaign) throw new CampaignError("Kampanjen finns inte.");
  if (campaign.stopped_at) return { stopped: 0, failed: 0 };

  // Planerade och misslyckade: inget finns i Awish.
  await db.execute(
    sql`update public.campaign_machines set status = 'stopped', stopped_at = ${tsParam(now)}
        where organization_id = ${orgId}::uuid and campaign_id = ${campaignId}::uuid
          and status in ('scheduled', 'failed')`,
  );
  const shown = await query<{
    id: string;
    awish_machine_id: string;
    awish_banner_id: string | null;
  }>(
    db,
    sql`select id, awish_machine_id, awish_banner_id from public.campaign_machines
        where organization_id = ${orgId}::uuid and campaign_id = ${campaignId}::uuid
          and status in ('shown', 'sending')`,
  );
  let stopped = 0;
  let failed = 0;
  if (shown.length > 0) {
    const api = await marketingClient(db, orgId, deps.connect);
    try {
      for (const r of shown) {
        try {
          let bannerId = r.awish_banner_id;
          if (!bannerId) {
            const list = await api.banners(r.awish_machine_id);
            bannerId =
              findCreatedBanner([], list, { coverImage: campaign.image_url, title: campaign.title })
                ?.id ?? null;
          }
          if (!bannerId) throw new CampaignError("Hittar inte kampanjen i Awish.");
          await api.updateBanner({
            id: bannerId,
            machineId: r.awish_machine_id,
            coverImage: campaign.image_url,
            title: campaign.title,
            expiredAt: unixSeconds(now),
          });
          await db.execute(
            sql`update public.campaign_machines
                set status = 'stopped', stopped_at = ${tsParam(now)}, awish_banner_id = ${bannerId}, error = null
                where organization_id = ${orgId}::uuid and id = ${r.id}::uuid`,
          );
          stopped += 1;
        } catch (error) {
          await db.execute(
            sql`update public.campaign_machines set error = ${shortError(error)}
                where organization_id = ${orgId}::uuid and id = ${r.id}::uuid`,
          );
          failed += 1;
        }
      }
    } finally {
      api.close();
    }
  }
  if (failed === 0) {
    await db.execute(
      sql`update public.campaigns set stopped_at = ${tsParam(now)}, stopped_by = ${viewer.user.userId}::uuid
          where organization_id = ${orgId}::uuid and id = ${campaignId}::uuid`,
    );
  }
  return { stopped, failed };
}
