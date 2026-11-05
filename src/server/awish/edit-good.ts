/**
 * "Varor i Awish": listan över varorna med Binderlabs siffror, "Redigera vara" (namn, pris
 * och bild i Awish) och "Koppla" (en vara utan titel i Binderlab). Allt på servern; butikens
 * Awish-inloggning läses ur Vault och lämnar aldrig servern.
 *
 * Säkerhet (samma mönster som Ny produkt, new-product.ts):
 *  - Bara ägare och admin, push till Awish påslaget och inloggningen sparad.
 *  - Förhandsvisning först. Den ger ett fingeravtryck av planen OCH av hela varan som den
 *    lästes i Awish; "Spara i Awish" räknar fram allt på nytt och skickar ingenting om något
 *    ändrats under tiden (även en ändring i Awish av något annat fält).
 *  - En skrivning i taget per organisation (lås i databasen) mot dubbelklick.
 *  - Binderlab ändras i en transaktion som bara sparas om Awish tog emot ändringen. Nekar
 *    Awish ändras ingenting i Binderlab. Efteråt läses varan tillbaka och det som inte
 *    sparades sägs tydligt.
 *  - Inget hemligt loggas.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { addDays } from "@/domain";
import {
  currentPriceEconomics,
  salePriceEffect,
} from "@/app/(app)/inkopspriser/_lib/price-economics";
import { withUserDbFor } from "@/server/access";
import {
  businessToday,
  loadDomainInputFor,
  loadStockFor,
  type Viewer,
} from "@/server/data/core/loaders";
import { sumOwnStock } from "@/server/data/core/own-stock";
import { safeErrorForLog } from "@/server/errors";
import type { Tx } from "@/db/client";

import { formatKr, goodNameKey, NewProductError, planFingerprint, type GoodImage } from "./goods";
import {
  checkEditedGood,
  editGoodInputSchema,
  encodeUpdateGoodInput,
  goodImage,
  notSavedText,
  planEditGood,
  summaryOf,
  type AwishGoodFull,
  type EditGoodPlan,
} from "./goods-edit";
import {
  buildGoodsOverview,
  type GoodRow,
  type GoodTitleLink,
  type OverviewSlot,
} from "./goods-overview";
import {
  loggedInClient,
  rows,
  STALE_MESSAGE,
  titleStateFor,
  withAwishWriteLock,
  type NewProductDeps,
} from "./new-product";
import { awishImageSrc } from "./image-proxy";
import type { AwishWebApi } from "./web-client";

export interface EditGoodDeps extends NewProductDeps {
  /** "Med VMB" (vyknappen); standard av, som Inköpspriser. */
  vmb?: boolean;
  /** Vald butik eller automat (andelen visas då, som Inköpspriser). */
  storeId?: string | null;
  machineId?: string | null;
}

/** Dagarna listan och effekten räknar på. */
export const SALES_DAYS = 30;

// ---------------------------------------------------------------------------
// Läsning ur Binderlab
// ---------------------------------------------------------------------------

interface LinkedMachine {
  readonly id: string;
  readonly label: string;
  readonly awishId: number;
}

async function linkedMachines(viewer: Viewer, sourceId: string): Promise<LinkedMachine[]> {
  const orgId = viewer.organization.id;
  const found = await withUserDbFor(viewer.user, (tx) =>
    rows<{ id: string; code: string | null; name: string; external_id: string }>(
      tx,
      sql`select distinct m.id::text as id, m.code, m.name, sm.external_id
          from public.source_machines sm
          join public.machines m on m.organization_id = sm.organization_id and m.id = sm.machine_id
          where sm.organization_id = ${orgId}::uuid and sm.data_source_id = ${sourceId}::uuid
            and sm.external_id ~ '^[0-9]{1,30}$' and m.archived_at is null
          order by m.code nulls last, m.name`,
    ),
  );
  return found.map((m) => ({
    id: m.id,
    label: m.code ? `${m.code} ${m.name}` : m.name,
    awishId: Number(m.external_id),
  }));
}

/**
 * Titeln per varunamn (normaliserad nyckel): via alias som importen (följer sammanslagningar),
 * annars en aktiv titel med samma namn. Dagens inköpspris (giltigt i dag) följer med.
 */
async function titleLinksByName(
  tx: Tx,
  orgId: string,
  names: readonly string[],
  today: string,
): Promise<Map<string, GoodTitleLink>> {
  if (names.length === 0) return new Map();
  const found = await rows<{
    normalized: string;
    id: string;
    name: string;
    own_product: boolean;
    price: number | string | null;
  }>(
    tx,
    sql`
      with recursive input as (
        select distinct lower(btrim(regexp_replace(normalize(r.raw, NFKC), '\\s+', ' ', 'g'))) as normalized
        from jsonb_array_elements_text(${JSON.stringify(names)}::jsonb) as r(raw)
      ),
      hit as (
        select i.normalized, a.title_id, 0 as depth
        from input i
        join public.title_aliases a
          on a.organization_id = ${orgId}::uuid and a.alias_normalized = i.normalized
      ),
      chain as (
        select normalized, title_id, depth from hit
        union all
        select c.normalized, t.merged_into_id, c.depth + 1
        from chain c
        join public.titles t on t.organization_id = ${orgId}::uuid and t.id = c.title_id
        where t.merged_into_id is not null and c.depth < 20
      ),
      by_alias as (
        select distinct on (normalized) normalized, title_id from chain order by normalized, depth desc
      ),
      by_name as (
        select distinct on (i.normalized) i.normalized, t.id as title_id
        from input i
        join public.titles t
          on t.organization_id = ${orgId}::uuid and t.archived_at is null
         and lower(t.name) = i.normalized
        order by i.normalized, t.created_at
      ),
      chosen as (
        select normalized, title_id from by_alias
        union all
        select n.normalized, n.title_id from by_name n
        where not exists (select 1 from by_alias b where b.normalized = n.normalized)
      )
      select c.normalized, t.id::text as id, t.name, t.own_product,
             (select pp.unit_cost_ore from public.purchase_prices pp
               where pp.organization_id = t.organization_id and pp.title_id = t.id
                 and pp.valid_from <= ${today}::date
               order by pp.valid_from desc limit 1) as price
      from chosen c
      join public.titles t on t.organization_id = ${orgId}::uuid and t.id = c.title_id`,
  );
  return new Map(
    found.map((r) => [
      r.normalized,
      {
        titleId: r.id,
        titleName: r.name,
        ownProduct: r.own_product,
        purchasePriceOre: r.price === null ? null : Number(r.price),
      },
    ]),
  );
}

function salesPeriod(viewer: Viewer, now: Date) {
  const today = businessToday(now, viewer.organization.timezone);
  return { today, period: { start: addDays(today, -(SALES_DAYS - 1)), end: today } };
}

// ---------------------------------------------------------------------------
// Listan
// ---------------------------------------------------------------------------

export interface GoodsOverview {
  readonly rows: GoodRow[];
  /** Aktiva titlar att koppla en vara till. */
  readonly titles: Array<{ id: string; name: string }>;
  /** Vår del visas (butik eller automat vald). */
  readonly showShare: boolean;
  readonly machines: number;
  /** Saker som inte gick att läsa (en automats fack), visas lugnt ovanför listan. */
  readonly notices: string[];
}

/**
 * Varorna i Awish (Goods) med fack (Products per kopplad automat) och Binderlabs siffror.
 * Läser Awish men skriver ingenting.
 */
export async function goodsOverviewFor(
  viewer: Viewer,
  deps: EditGoodDeps = {},
): Promise<GoodsOverview> {
  const { client, sourceId } = await loggedInClient(viewer, deps);
  const orgId = viewer.organization.id;
  const now = (deps.now ?? (() => new Date()))();
  const { today, period } = salesPeriod(viewer, now);

  const machines = await linkedMachines(viewer, sourceId);
  const goods = await client.allGoodsFull();
  const notices: string[] = [];
  const slots: OverviewSlot[] = [];
  for (const m of machines) {
    try {
      for (const s of await client.slots(m.awishId)) {
        slots.push({
          goodId: s.goodId,
          machine: m.label,
          slot: s.channelName ?? String(s.id),
          count: s.currentInventory,
          capacity: s.capacity,
        });
      }
    } catch {
      notices.push(`Kunde inte läsa facken i ${m.label} just nu.`);
    }
  }

  const scoped = Boolean(deps.storeId || deps.machineId);
  const [byName, domain, stock] = await Promise.all([
    withUserDbFor(viewer.user, (tx) =>
      titleLinksByName(
        tx,
        orgId,
        goods.map((g) => g.name),
        today,
      ),
    ),
    loadDomainInputFor(
      viewer,
      {
        period,
        storeId: deps.storeId ?? null,
        machineId: deps.machineId ?? null,
        vmb: deps.vmb ?? false,
      },
      now,
    ),
    loadStockFor(viewer),
  ]);

  const links = new Map<number, GoodTitleLink>();
  for (const g of goods) {
    const link = byName.get(goodNameKey(g.name));
    if (link) links.set(g.id, link);
  }
  const sales = new Map<string, { orders: number; revenueOre: number }>();
  for (const o of domain.current.orders) {
    const cur = sales.get(o.titleId) ?? { orders: 0, revenueOre: 0 };
    sales.set(o.titleId, { orders: cur.orders + 1, revenueOre: cur.revenueOre + o.amountOre });
  }
  const titleIds = [...new Set([...links.values()].map((l) => l.titleId))];
  const economics = new Map(
    currentPriceEconomics({ ...domain.current, titleIds }).map((e) => [
      e.titleId,
      { leftBeforeOre: e.leftBeforeStoreOre, leftOre: e.leftPerOrderOre },
    ]),
  );
  const warehouse = new Map(sumOwnStock(stock.warehouse).map((r) => [r.titleId, r.onHand]));

  return {
    rows: buildGoodsOverview({
      goods: goods.map((g) => ({
        id: g.id,
        name: g.name,
        priceOre: summaryOf(g).priceOre,
        image: awishImageSrc(goodImage(g)),
      })),
      links,
      sales,
      slots,
      warehouse,
      economics,
      showShare: scoped,
      allMachines: !scoped,
    }),
    titles: domain.titles
      .filter((t) => !t.archived && t.mergedIntoId === null)
      .map((t) => ({ id: t.id, name: t.name }))
      .sort((a, b) => a.name.localeCompare(b.name, "sv")),
    showShare: scoped,
    machines: machines.length,
    notices,
  };
}

// ---------------------------------------------------------------------------
// Redigera vara
// ---------------------------------------------------------------------------

export interface EditGoodPreview {
  readonly lines: string[];
  readonly warnings: string[];
  readonly blocking: string | null;
  readonly nothingToDo: boolean;
  /** Vad ett nytt pris gör med Kvar per order (en uppskattning, ingår inte i fingeravtrycket). */
  readonly effect: string[];
  readonly fingerprint: string;
}

interface ComputedEdit {
  plan: EditGoodPlan;
  fingerprint: string;
  good: AwishGoodFull;
  permissions: string[];
}

async function computeEdit(
  viewer: Viewer,
  client: AwishWebApi,
  raw: unknown,
  image: GoodImage | null,
): Promise<ComputedEdit> {
  const input = editGoodInputSchema.parse(raw);
  const orgId = viewer.organization.id;
  const { permissions } = await client.profile();
  const goods = await client.allGoodsFull();
  const good = goods.find((g) => g.id === input.goodId);
  if (!good) throw new NewProductError("Varan finns inte längre i Awish. Ladda om sidan.");
  const key = goodNameKey(input.name);
  const otherSameName = goods
    .filter((g) => g.id !== good.id && goodNameKey(g.name) === key)
    .map((g) => ({ id: g.id, name: g.name }));

  const state = await withUserDbFor(viewer.user, async (tx) => {
    const title = await titleStateFor(tx, orgId, good.name);
    const newNameTitle =
      key === goodNameKey(good.name) ? title : await titleStateFor(tx, orgId, input.name);
    const [taken] = await rows<{ id: string }>(
      tx,
      sql`select t.id::text as id from public.titles t
          where t.organization_id = ${orgId}::uuid and t.archived_at is null
            and lower(t.name) = lower(${input.name})
            and t.id is distinct from ${title?.titleId ?? null}::uuid
          limit 1`,
    );
    return { title, newNameTitle, titleNameTaken: Boolean(taken) };
  });

  const plan = planEditGood({
    good,
    input,
    otherSameName,
    title: state.title,
    newNameTitle: state.newNameTitle,
    titleNameTaken: state.titleNameTaken,
    image: image ? { fileName: image.fileName } : null,
    permissions,
  });
  const fingerprint = planFingerprint(plan, {
    good,
    image: image?.sha256 ?? null,
    permissions: [...permissions].sort(),
  });
  return { plan, fingerprint, good, permissions };
}

function signedKr(ore: number): string {
  const whole = Math.round(ore / 100) * 100;
  if (whole === 0) return "±0 kr";
  return `${whole > 0 ? "+" : "−"}${formatKr(Math.abs(whole))}`;
}

/** "Kvar per order: 67 kr → 77 kr" och "≈ +300 kr per månad …" för ett nytt pris. */
async function priceEffectLines(
  viewer: Viewer,
  plan: EditGoodPlan,
  deps: EditGoodDeps,
): Promise<string[]> {
  if (!plan.changes.price || !plan.binderlab.titleId) return [];
  const titleId = plan.binderlab.titleId;
  const now = (deps.now ?? (() => new Date()))();
  const { period } = salesPeriod(viewer, now);
  const domain = await loadDomainInputFor(
    viewer,
    {
      period,
      storeId: deps.storeId ?? null,
      machineId: deps.machineId ?? null,
      vmb: deps.vmb ?? false,
    },
    now,
  );
  const effect = salePriceEffect(
    domain.current,
    titleId,
    plan.from.priceOre,
    plan.to.priceOre,
    deps.machineId ?? null,
  );
  if (effect.afterOre === null) return ["Kvar per order räknas när titeln har inköpspris."];
  const lines: string[] = [];
  const pair = (a: number | null, b: number) =>
    `${a === null ? "–" : formatKr(a)} → ${formatKr(b)}`;
  lines.push(`Kvar per order: ${pair(effect.beforeOre, effect.afterOre)}`);
  const scoped = Boolean(deps.storeId || deps.machineId);
  if (scoped && effect.shareAfterOre !== null) {
    lines.push(`Vår del per order: ${pair(effect.shareBeforeOre, effect.shareAfterOre)}`);
  }
  if (effect.orders > 0 && effect.monthlyDeltaOre !== null) {
    const delta =
      scoped && effect.shareMonthlyDeltaOre !== null
        ? effect.shareMonthlyDeltaOre
        : effect.monthlyDeltaOre;
    lines.push(
      `≈ ${signedKr(delta)} per månad om försäljningen håller i sig (${effect.orders} sålda senaste ${SALES_DAYS} d). En uppskattning.`,
    );
  } else {
    lines.push(`Ingen försäljning senaste ${SALES_DAYS} d, så räknat på ett pack.`);
  }
  return lines;
}

/** Förhandsvisning av en ändring. Läser Awish och Binderlab, skriver ingenting. */
export async function previewEditGoodFor(
  viewer: Viewer,
  raw: unknown,
  image: GoodImage | null,
  deps: EditGoodDeps = {},
): Promise<EditGoodPreview> {
  const { client } = await loggedInClient(viewer, deps);
  const { plan, fingerprint } = await computeEdit(viewer, client, raw, image);
  let effect: string[] = [];
  if (!plan.blocking) {
    try {
      effect = await priceEffectLines(viewer, plan, deps);
    } catch (error) {
      // Effekten är bara en uppskattning: förhandsvisningen visas ändå. Bara namn och SQLSTATE.
      console.error("[redigera-vara] effekten", safeErrorForLog(error));
      effect = [];
    }
  }
  return {
    lines: plan.lines,
    warnings: plan.warnings,
    blocking: plan.blocking,
    nothingToDo: plan.nothingToDo,
    effect,
    fingerprint,
  };
}

export interface EditGoodResult {
  /** saved: allt sparades. partial: något sparades inte. unverified: kunde inte läsas tillbaka. */
  readonly status: "saved" | "partial" | "unverified" | "nothing";
  readonly message: string;
  /** Varan som Awish har den nu (tillbakaläst), eller som den skickades (unverified). */
  readonly good: { id: number; name: string; priceOre: number | null; image: string | null };
}

/** Binderlab: alias och ev. nytt titelnamn, i transaktionen som väntar på Awish. */
async function writeBinderlab(tx: Tx, orgId: string, plan: EditGoodPlan): Promise<void> {
  const titleId = plan.binderlab.titleId;
  if (!titleId) return;
  for (const alias of plan.binderlab.aliases) {
    await tx.execute(
      sql`insert into public.title_aliases (organization_id, title_id, alias)
          values (${orgId}::uuid, ${titleId}::uuid, ${alias})
          on conflict (organization_id, alias_normalized) do nothing`,
    );
    const [owner] = await rows<{ title_id: string }>(
      tx,
      sql`select title_id::text as title_id from public.title_aliases
          where organization_id = ${orgId}::uuid
            and alias_normalized = lower(btrim(regexp_replace(normalize(${alias}::text, NFKC), '\\s+', ' ', 'g')))`,
    );
    if (owner?.title_id !== titleId) {
      throw new NewProductError(`Namnet ${alias} hör redan till en annan titel i Binderlab.`);
    }
  }
  const rename = plan.binderlab.renameTitle;
  if (rename) {
    await tx.execute(
      sql`update public.titles set name = ${rename.to}
          where organization_id = ${orgId}::uuid and id = ${titleId}::uuid and name = ${rename.from}`,
    );
  }
}

/**
 * "Spara i Awish": laddar upp en ny bild (om vald), skickar hela varan med UpdateGood och
 * läser tillbaka den. Binderlab (alias, titelns namn) sparas i samma transaktion, som bara
 * går igenom om Awish tog emot ändringen. `fingerprint` måste vara förhandsvisningens.
 */
export async function saveEditGoodFor(
  viewer: Viewer,
  raw: unknown,
  image: GoodImage | null,
  fingerprint: string,
  deps: EditGoodDeps = {},
): Promise<EditGoodResult> {
  const { db, client } = await loggedInClient(viewer, deps);
  const orgId = viewer.organization.id;
  return withAwishWriteLock(db, orgId, async () => {
    const {
      plan,
      fingerprint: now,
      good,
      permissions,
    } = await computeEdit(viewer, client, raw, image);
    if (plan.blocking) throw new NewProductError(plan.blocking);
    if (now !== fingerprint) throw new NewProductError(STALE_MESSAGE);
    const before = summaryOf(good);
    if (plan.nothingToDo) {
      return {
        status: "nothing",
        message: "Inget är ändrat.",
        good: {
          id: good.id,
          name: good.name,
          priceOre: before.priceOre,
          image: awishImageSrc(goodImage(good)),
        },
      };
    }

    const imageUrl = plan.changes.image && image ? await client.uploadImage(image) : null;
    const input = encodeUpdateGoodInput(
      good,
      { name: plan.to.name, priceOre: plan.to.priceOre, imageUrl },
      permissions,
    );

    const outcome = await withUserDbFor(
      viewer.user,
      async (tx): Promise<{ after: AwishGoodFull | null; readFailed: boolean }> => {
        await writeBinderlab(tx, orgId, plan);
        const readBack = async () =>
          (await client.allGoodsFull()).find((g) => g.id === plan.goodId) ?? null;
        try {
          await client.updateGood(plan.goodId, input);
        } catch (error) {
          // Nekar Awish rullas Binderlab tillbaka. Men ett tappat svar (tidsgräns, 503) kan
          // betyda att Awish ändå sparade: då måste aliaset sparas, annars kopplas inte
          // försäljningen under det nya namnet. Läs varan och avgör.
          const saved = plan.changes.name ? await readBack().catch(() => null) : null;
          if (!saved || saved.name !== plan.to.name) throw error;
        }
        let after: AwishGoodFull | null;
        try {
          after = await readBack();
        } catch {
          // Awish tog emot ändringen men gick inte att läsa: Binderlab sparas (aliaset är
          // ofarligt även om namnet mot förmodan inte ändrades).
          return { after: null, readFailed: true };
        }
        const check = checkEditedGood(plan, after, imageUrl);
        if (!check.found) {
          throw new NewProductError(
            `${plan.from.name} syns inte i Awish efter ändringen. Inget ändrades i Binderlab. Titta i Awish.`,
          );
        }
        if (!check.name) {
          throw new NewProductError(
            `Awish sparade inte ${notSavedText(check)}. Inget ändrades i Binderlab. Titta i listan och försök igen.`,
          );
        }
        return { after, readFailed: false };
      },
    );

    if (outcome.readFailed || !outcome.after) {
      return {
        status: "unverified",
        message:
          "Skickat till Awish, men varan gick inte att läsa tillbaka. Ladda om och kontrollera.",
        good: {
          id: plan.goodId,
          name: plan.to.name,
          priceOre: plan.to.priceOre,
          image: awishImageSrc(imageUrl ?? plan.from.image),
        },
      };
    }
    const saved = outcome.after;
    const check = checkEditedGood(plan, saved, imageUrl);
    const confirmed = {
      id: saved.id,
      name: saved.name,
      priceOre: summaryOf(saved).priceOre,
      image: awishImageSrc(goodImage(saved)),
    };
    if (!check.all) {
      return {
        status: "partial",
        message: `Awish sparade inte ${notSavedText(check)}. Titta i Awish och försök igen.`,
        good: confirmed,
      };
    }
    const linked =
      plan.binderlab.aliases.length > 0 && plan.binderlab.titleName
        ? ` Försäljningen kopplas till ${plan.binderlab.titleName}.`
        : "";
    return {
      status: "saved",
      message: `Klart! ${saved.name} är sparad i Awish.${linked}`,
      good: confirmed,
    };
  });
}

// ---------------------------------------------------------------------------
// Koppla en vara till Binderlab
// ---------------------------------------------------------------------------

/**
 * Kopplar en vara utan titel: till en befintlig aktiv titel (alias) eller till en ny titel
 * med varans namn. Namnet läses ur Awish (aldrig från webbläsaren). Bara Binderlab ändras.
 */
export async function linkGoodToTitleFor(
  viewer: Viewer,
  raw: unknown,
  deps: EditGoodDeps = {},
): Promise<{ titleId: string; titleName: string; message: string }> {
  const r = (raw ?? {}) as { goodId?: unknown; titleId?: unknown };
  const goodId = Number(r.goodId);
  if (!Number.isInteger(goodId) || goodId <= 0) throw new NewProductError("Välj vara.");
  const titleId =
    typeof r.titleId === "string" && r.titleId !== "" ? r.titleId.toLowerCase() : null;
  if (titleId !== null && !/^[0-9a-f-]{36}$/.test(titleId)) {
    throw new NewProductError("Välj titel.");
  }
  const { db, client } = await loggedInClient(viewer, deps);
  const orgId = viewer.organization.id;
  return withAwishWriteLock(db, orgId, async () => {
    const good = (await client.allGoodsFull()).find((g) => g.id === goodId);
    if (!good) throw new NewProductError("Varan finns inte längre i Awish. Ladda om sidan.");
    return withUserDbFor(viewer.user, async (tx) => {
      const current = await titleStateFor(tx, orgId, good.name);
      if (current) {
        throw new NewProductError(`${good.name} är redan kopplad till ${current.titleName}.`);
      }
      let target: { id: string; name: string } | undefined;
      if (titleId) {
        [target] = await rows<{ id: string; name: string }>(
          tx,
          sql`select t.id::text as id, t.name from public.titles t
              where t.organization_id = ${orgId}::uuid and t.id = ${titleId}::uuid
                and t.archived_at is null and t.merged_into_id is null`,
        );
        if (!target) throw new NewProductError("Titeln finns inte längre. Ladda om sidan.");
      } else {
        [target] = await rows<{ id: string; name: string }>(
          tx,
          sql`insert into public.titles (organization_id, name)
              values (${orgId}::uuid, ${good.name})
              returning id::text as id, name`,
        );
        if (!target) throw new NewProductError(`Kunde inte skapa titeln ${good.name}.`);
      }
      await tx.execute(
        sql`insert into public.title_aliases (organization_id, title_id, alias)
            values (${orgId}::uuid, ${target.id}::uuid, ${good.name})`,
      );
      return {
        titleId: target.id,
        titleName: target.name,
        message: titleId
          ? `Klart! ${good.name} är kopplad till ${target.name}.`
          : `Klart! Ny titel ${target.name} i Binderlab.`,
      };
    });
  });
}
