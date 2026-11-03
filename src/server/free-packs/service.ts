/**
 * Gratis-pack (Automater → Gratis-pack): koder i Awish som ger ett pack gratis, för
 * kompensation, giveaways och belöningar till butikspersonal.
 *
 * Flödet: välj automat → servern läser automatens fack i Awish (Products, bara läsning) →
 * välj titel, antal, giltighet och skäl → bekräfta → koderna skapas i Awish
 * (CreatePickupCode) och läses tillbaka (PickupCodes) → koderna visas stora med QR.
 *
 * Varje skapande loggas i free_pack_batches (vem, varför, till vem, kostnad) INNAN Awish
 * anropas (status sending), och uppdateras efteråt (created eller failed). Ett lås per
 * automat gör att två samtidiga skapanden inte kan blanda ihop varandras koder.
 *
 * Behörighet: ägare, admin och läsare ser listan och kostnaden; koderna ser bara ägare och
 * admin (RLS). Bara ägare och admin skapar. Skrivningar som systemrollen efter rollkontroll.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { getServiceDb, type Db, type Tx } from "@/db/client";
import { addDays, monthOf, type IsoDate } from "@/domain";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { ECONOMY_ROLES, OPERATOR_ROLES } from "@/server/data/core/types";

import { AwishApiError } from "../awish/grpc-client";
import {
  AwishNotConnectedError,
  linkedMachines,
  marketingClient,
  type LinkedMachine,
  type MarketingConnect,
} from "../awish/marketing";
import {
  createdCodes,
  freePackCost,
  freePackOptions,
  FreePackError,
  type FreePackInput,
  type FreePackOption,
  type FreePackReason,
} from "./model";

type Row = Record<string, unknown>;

async function query<T extends Row>(db: Db | Tx, q: ReturnType<typeof sql>): Promise<T[]> {
  return Array.from(await db.execute(q)) as T[];
}

/** Tidpunkt som parameter (postgres.js tar inte Date i råa frågor). */
function tsParam(d: Date | null) {
  return d === null ? sql`null::timestamptz` : sql`${d.toISOString()}::timestamptz`;
}

export interface FreePackDeps {
  readonly db?: Db;
  readonly connect?: MarketingConnect;
  readonly now?: () => Date;
}

const dbOf = (deps: FreePackDeps) => deps.db ?? getServiceDb();
const nowOf = (deps: FreePackDeps) => (deps.now ?? (() => new Date()))();

function shortError(error: unknown): string {
  if (
    error instanceof AwishApiError ||
    error instanceof FreePackError ||
    error instanceof AwishNotConnectedError
  ) {
    return error.message;
  }
  return "Awish svarade inte som väntat.";
}

/** Ett val i listan: varan i automaten, kopplad till vår titel och dagens inköpspris. */
export interface FreePackChoice extends FreePackOption {
  readonly titleId: string | null;
  readonly titleName: string | null;
  readonly unitCostOre: number | null;
}

/** Titlar för varornas namn (alias, följer sammanslagningar), utan att skapa något. */
async function titlesFor(
  db: Db | Tx,
  orgId: string,
  names: readonly string[],
): Promise<Map<string, { id: string; name: string }>> {
  if (names.length === 0) return new Map();
  const found = await query<{ raw: string; title_id: string | null; name: string | null }>(
    db,
    sql`
      with recursive input as (
        select r.raw,
               lower(btrim(regexp_replace(normalize(r.raw, NFKC), '\\s+', ' ', 'g'))) as normalized
        from jsonb_array_elements_text(${JSON.stringify(names)}::jsonb) as r(raw)
      ),
      hit as (
        select i.raw, a.title_id, 0 as depth
        from input i
        join public.title_aliases a
          on a.organization_id = ${orgId}::uuid and a.alias_normalized = i.normalized
      ),
      chain as (
        select raw, title_id, depth from hit
        union all
        select c.raw, t.merged_into_id, c.depth + 1
        from chain c
        join public.titles t on t.organization_id = ${orgId}::uuid and t.id = c.title_id
        where t.merged_into_id is not null and c.depth < 20
      ),
      resolved as (
        select distinct on (raw) raw, title_id from chain order by raw, depth desc
      )
      select i.raw, r.title_id, t.name
      from input i
      left join resolved r on r.raw = i.raw
      left join public.titles t on t.organization_id = ${orgId}::uuid and t.id = r.title_id`,
  );
  const out = new Map<string, { id: string; name: string }>();
  for (const r of found) if (r.title_id && r.name) out.set(r.raw, { id: r.title_id, name: r.name });
  return out;
}

/** Inköpspriset som gäller dagen (purchase_price_periods), per titel. */
async function pricesOn(
  db: Db | Tx,
  orgId: string,
  titleIds: readonly string[],
  day: IsoDate,
): Promise<Map<string, number>> {
  if (titleIds.length === 0) return new Map();
  const rows = await query<{ title_id: string; unit_cost_ore: string | number }>(
    db,
    sql`select title_id, unit_cost_ore from public.purchase_price_periods
        where organization_id = ${orgId}::uuid
          and title_id = any (${`{${titleIds.join(",")}}`}::uuid[])
          and valid_from <= ${day}::date and (valid_to is null or valid_to >= ${day}::date)`,
  );
  return new Map(rows.map((r) => [r.title_id, Number(r.unit_cost_ore)]));
}

async function linkedMachine(db: Db, orgId: string, machineId: string): Promise<LinkedMachine> {
  const m = (await linkedMachines(db, orgId)).find((x) => x.machineId === machineId);
  if (!m) throw new FreePackError("Automaten är inte kopplad till Awish.");
  return m;
}

/** Automatens varor (läses i Awish nu) med titel och inköpspris. Ägare och admin. */
export async function freePackChoicesFor(
  viewer: Viewer,
  machineId: string,
  deps: FreePackDeps = {},
): Promise<FreePackChoice[]> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const db = dbOf(deps);
  const machine = await linkedMachine(db, orgId, machineId);
  const api = await marketingClient(db, orgId, deps.connect);
  let options: FreePackOption[];
  try {
    const products = await api.products(machine.awishMachineId);
    options = freePackOptions(products);
  } finally {
    api.close();
  }
  const today = businessToday(nowOf(deps), viewer.organization.timezone);
  const titles = await titlesFor(
    db,
    orgId,
    options.map((o) => o.goodName),
  );
  const prices = await pricesOn(
    db,
    orgId,
    [...new Set([...titles.values()].map((t) => t.id))],
    today,
  );
  return options.map((o) => {
    const t = titles.get(o.goodName) ?? null;
    return {
      ...o,
      titleId: t?.id ?? null,
      titleName: t?.name ?? null,
      unitCostOre: t ? (prices.get(t.id) ?? null) : null,
    };
  });
}

export interface CreatedFreePacks {
  readonly batchId: string;
  readonly codes: string[];
  readonly goodName: string;
  readonly machine: { code: string; name: string };
  readonly expiresOn: IsoDate;
  readonly costOre: number | null;
}

/**
 * Skapar koderna efter bekräftelsen. Facket kontrolleras mot Awish igen (det kan ha ändrats
 * sedan valet visades). Kastar FreePackError med ett svenskt meddelande om något går fel;
 * försöket finns då kvar i loggen som "misslyckat" utan kostnad.
 */
export async function createFreePacksFor(
  viewer: Viewer,
  input: FreePackInput,
  deps: FreePackDeps = {},
): Promise<CreatedFreePacks> {
  const orgId = viewer.organization.id;
  await requireRoleFor(viewer.user, orgId, OPERATOR_ROLES);
  const db = dbOf(deps);
  const now = nowOf(deps);
  const today = businessToday(now, viewer.organization.timezone);
  const machine = await linkedMachine(db, orgId, input.machineId);
  const expiresOn = addDays(today, input.days);
  // Koden gäller hela sista dagen (till midnatt UTC efter, i sekunder till Awish).
  const expiresAt = new Date(`${addDays(expiresOn, 1)}T00:00:00Z`);

  const api = await marketingClient(db, orgId, deps.connect);
  try {
    const products = await api.products(machine.awishMachineId);
    const slot = products.find((p) => p.id === input.productId);
    const goodName = slot?.goodName?.trim();
    if (!slot || !goodName) throw new FreePackError("Titeln finns inte längre i automaten.");
    if (slot.currentInventory < 1) throw new FreePackError("Facket är tomt. Välj en annan titel.");

    const title = (await titlesFor(db, orgId, [goodName])).get(goodName) ?? null;
    const unit = title
      ? ((await pricesOn(db, orgId, [title.id], today)).get(title.id) ?? null)
      : null;
    const cost = freePackCost(unit, input.quantity);

    const [batch] = await query<{ id: string }>(
      db,
      sql`insert into public.free_pack_batches
            (organization_id, machine_id, title_id, good_name, awish_machine_id, awish_product_id,
             quantity, reason, recipient, note, unit_cost_ore, cost_ore, business_date, expires_at,
             created_by)
          values (${orgId}::uuid, ${machine.machineId}::uuid, ${title?.id ?? null}::uuid,
                  ${goodName.slice(0, 200)}, ${machine.awishMachineId}, ${input.productId},
                  ${input.quantity}, ${input.reason}, ${input.recipient}, ${input.note},
                  ${cost.unitCostOre}, ${cost.costOre}, ${today}::date, ${tsParam(expiresAt)},
                  ${viewer.user.userId}::uuid)
          returning id`,
    );
    const batchId = batch!.id;

    let codes: { code: string; id: string; expiresAt: Date | null }[];
    try {
      codes = await db.transaction(async (tx) => {
        // En i taget per automat: koderna läses som skillnaden före och efter.
        await tx.execute(
          sql`select pg_advisory_xact_lock(hashtextextended(${`free_pack:${orgId}:${machine.awishMachineId}`}, 0))`,
        );
        const before = await api.pickupCodes(machine.awishMachineId);
        try {
          await api.createPickupCodes({
            machineId: machine.awishMachineId,
            productId: input.productId,
            quantity: input.quantity,
            expiredAt: Math.floor(expiresAt.getTime() / 1000),
          });
        } catch (error) {
          // Ett avbrutet svar (tidsgräns, nätet) kan ändå ha skapat koderna. Läs listan igen
          // (under låset) så att skapade koder inte loggas som misslyckade utan kostnad.
          const again = await api.pickupCodes(machine.awishMachineId).catch(() => null);
          const created = again ? createdCodes(before, again, input.productId) : [];
          if (created.length === 0) {
            const unsure =
              again === null ||
              (error instanceof AwishApiError &&
                (error.kind === "timeout" || error.kind === "unavailable"));
            if (unsure) {
              throw new FreePackError(
                "Awish svarade inte. Koderna kan ha skapats: kolla i Awish innan du försöker igen.",
              );
            }
            throw error;
          }
          return created.map((c) => ({
            code: c.code,
            id: c.id,
            expiresAt: c.expiredAtMillis ? new Date(c.expiredAtMillis) : null,
          }));
        }
        const after = await api.pickupCodes(machine.awishMachineId).catch(() => null);
        const created = after ? createdCodes(before, after, input.productId) : [];
        return created.map((c) => ({
          code: c.code,
          id: c.id,
          expiresAt: c.expiredAtMillis ? new Date(c.expiredAtMillis) : null,
        }));
      });
    } catch (error) {
      const message = shortError(error);
      await db.execute(
        sql`update public.free_pack_batches
            set status = 'failed', error = ${message}, unit_cost_ore = null, cost_ore = null
            where organization_id = ${orgId}::uuid and id = ${batchId}::uuid`,
      );
      throw new FreePackError(message);
    }

    await db.transaction(async (tx) => {
      for (const c of codes) {
        await tx.execute(
          sql`insert into public.free_pack_codes
                (organization_id, batch_id, code, awish_code_id, expires_at, created_by)
              values (${orgId}::uuid, ${batchId}::uuid, ${c.code.slice(0, 64)},
                      ${/^[0-9]{1,20}$/.test(c.id) ? c.id : null}, ${tsParam(c.expiresAt)},
                      ${viewer.user.userId}::uuid)
              on conflict do nothing`,
        );
      }
      await tx.execute(
        sql`update public.free_pack_batches
            set status = 'created',
                error = ${codes.length === 0 ? "Koderna skapades men kunde inte läsas. Se Awish." : null}
            where organization_id = ${orgId}::uuid and id = ${batchId}::uuid`,
      );
    });

    return {
      batchId,
      codes: codes.map((c) => c.code),
      goodName: title?.name ?? goodName,
      machine: { code: machine.code, name: machine.name },
      expiresOn,
      costOre: cost.costOre,
    };
  } finally {
    api.close();
  }
}

// ---------------------------------------------------------------------------
// Läsa
// ---------------------------------------------------------------------------

export interface FreePackBatchView {
  readonly id: string;
  readonly day: IsoDate;
  readonly machine: { id: string; code: string; name: string };
  readonly goodName: string;
  readonly quantity: number;
  readonly reason: FreePackReason;
  readonly recipient: string | null;
  readonly note: string | null;
  readonly costOre: number | null;
  readonly status: "sending" | "created" | "failed";
  readonly error: string | null;
  readonly createdBy: string | null;
  readonly expiresAt: string;
  /** Koderna (bara för ägare och admin; läsaren får en tom lista). */
  readonly codes: string[];
}

export interface FreePackPageData {
  readonly connected: boolean;
  readonly linked: LinkedMachine[];
  readonly canCreate: boolean;
  readonly month: { packs: number; costOre: number; unpriced: number };
  readonly batches: FreePackBatchView[];
}

export async function loadFreePackPageFor(
  viewer: Viewer,
  deps: FreePackDeps = {},
): Promise<FreePackPageData> {
  const orgId = viewer.organization.id;
  const role = await requireRoleFor(viewer.user, orgId, ECONOMY_ROLES);
  const db = dbOf(deps);
  const today = businessToday(nowOf(deps), viewer.organization.timezone);
  const monthStart = `${monthOf(today)}-01`;
  const linked = await linkedMachines(db, orgId);
  const [conn] = await query<{ ok: boolean }>(
    db,
    sql`select exists (select 1 from public.data_sources ds
          where ds.organization_id = ${orgId}::uuid and ds.provider = 'awish_grpc'
            and ds.archived_at is null and ds.secret_ref is not null) as ok`,
  );
  return withUserDbFor(viewer.user, async (tx) => {
    const rows = await query<{
      id: string;
      business_date: string;
      machine_id: string;
      code: string;
      name: string;
      good_name: string;
      title_name: string | null;
      quantity: number;
      reason: FreePackReason;
      recipient: string | null;
      note: string | null;
      cost_ore: string | number | null;
      status: "sending" | "created" | "failed";
      error: string | null;
      expires_at: Date;
      created_by_name: string | null;
    }>(
      tx,
      sql`select b.id, b.business_date::text as business_date, b.machine_id, m.code, m.name,
                 b.good_name, t.name as title_name, b.quantity, b.reason, b.recipient, b.note,
                 b.cost_ore, b.status, b.error, b.expires_at,
                 (select p.display_name from public.profiles p
                   where p.organization_id = b.organization_id and p.user_id = b.created_by
                   limit 1) as created_by_name
          from public.free_pack_batches b
          join public.machines m on m.organization_id = b.organization_id and m.id = b.machine_id
          left join public.titles t on t.organization_id = b.organization_id and t.id = b.title_id
          where b.organization_id = ${orgId}::uuid
          order by b.created_at desc
          limit 50`,
    );
    const codes = await query<{ batch_id: string; code: string }>(
      tx,
      sql`select batch_id, code from public.free_pack_codes
          where organization_id = ${orgId}::uuid
            and batch_id = any (${`{${rows.map((r) => r.id).join(",")}}`}::uuid[])
          order by created_at, code`,
    );
    const codesBy = new Map<string, string[]>();
    for (const c of codes) codesBy.set(c.batch_id, [...(codesBy.get(c.batch_id) ?? []), c.code]);

    const [month] = await query<{ packs: number; cost: string | number; unpriced: number }>(
      tx,
      sql`select coalesce(sum(quantity), 0)::int as packs, coalesce(sum(cost_ore), 0) as cost,
                 count(*) filter (where cost_ore is null)::int as unpriced
          from public.free_pack_batches
          where organization_id = ${orgId}::uuid and status = 'created'
            and business_date >= ${monthStart}::date and business_date <= ${today}::date`,
    );
    return {
      connected: conn?.ok === true,
      linked,
      canCreate: (OPERATOR_ROLES as readonly string[]).includes(role),
      month: {
        packs: month?.packs ?? 0,
        costOre: Number(month?.cost ?? 0),
        unpriced: month?.unpriced ?? 0,
      },
      batches: rows.map((r) => ({
        id: r.id,
        day: r.business_date as IsoDate,
        machine: { id: r.machine_id, code: r.code, name: r.name },
        goodName: r.title_name ?? r.good_name,
        quantity: r.quantity,
        reason: r.reason,
        recipient: r.recipient,
        note: r.note,
        costOre: r.cost_ore === null ? null : Number(r.cost_ore),
        status: r.status,
        error: r.error,
        createdBy: r.created_by_name,
        expiresAt: new Date(r.expires_at).toISOString(),
        codes: codesBy.get(r.id) ?? [],
      })),
    };
  });
}
