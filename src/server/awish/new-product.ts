/**
 * "Ny produkt": skapa en vara i Awish och koppla den i Binderlab, och lägga en vara i ett
 * fack. Allt på servern; butikens Awish-inloggning läses ur Vault och lämnar aldrig servern.
 *
 * Säkerhet (samma mönster som Provkör / Skicka till Awish nu):
 *  - Bara ägare och admin (rollen kontrolleras mot databasen i varje anrop).
 *  - Push till Awish måste vara påslaget (Datakällor → Awish) och inloggningen sparad.
 *  - Aldrig från en demo (Demo för kunder): inget anrop till Awish, inte ens inloggningen.
 *  - Varje skrivning föregås av en förhandsvisning som visar exakt vad som ändras. Den ger
 *    ett fingeravtryck; "Skicka till Awish" skickar tillbaka det och servern räknar fram
 *    planen på nytt. Skiljer sig planen (något ändrades under tiden) skickas ingenting.
 *  - En skrivning i taget per organisation (lås i databasen): ett dubbelklick eller två
 *    flikar kan inte skapa samma vara två gånger.
 *  - Befintliga varors priser ändras aldrig. Ett fack med pack byter aldrig vara och får
 *    aldrig lägre antal utan uttrycklig bekräftelse.
 *  - Misslyckas Awish sparas ingenting i Binderlab (Binderlab skrivs efter Awish, i en
 *    transaktion). Inget hemligt loggas.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { getServiceDb, type Db, type Tx } from "@/db/client";
import { AuthorizationError, requireRoleFor, withUserDbFor } from "@/server/access";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { OPERATOR_ROLES } from "@/server/data/core/types";
import { DEMO_MESSAGES, isDemoOrganization } from "@/server/demo/guard";
import { dbErrorMessage } from "@/server/errors";

import {
  encodeGoodInput,
  goodNameKey,
  NewProductError,
  newProductInputSchema,
  planFingerprint,
  planNewProduct,
  planSlotChange,
  slotChangeInputSchema,
  type AwishGoodSummary,
  type AwishSlot,
  type BinderlabTitleState,
  type GoodImage,
  type NewProductPlan,
  type SlotChangePlan,
} from "./goods";
import { createAwishWebClient, type AwishWebApi, type AwishWebClientOptions } from "./web-client";
import { awishMachineId, loadWebSource, readWebCredentials } from "./web-service";

export interface NewProductDeps {
  serviceDb?: Db;
  /** Webb-klienten mot Awish; injiceras i tester (låtsas-panelen). */
  makeWebClient?: (options: AwishWebClientOptions) => AwishWebApi;
  webClientOptions?: AwishWebClientOptions;
  /** Klocka (dagens datum för inköpspriset); injiceras i tester. */
  now?: () => Date;
}

type Row = Record<string, unknown>;

export async function rows<T extends Row>(db: Db | Tx, q: ReturnType<typeof sql>): Promise<T[]> {
  return Array.from(await db.execute(q)) as T[];
}

export const FORBIDDEN_MESSAGE = "Bara ägare och admin kan lägga till produkter i Awish.";
export const STALE_MESSAGE =
  "Något har ändrats i Awish eller Binderlab sedan förhandsvisningen. Titta på förhandsvisningen igen och skicka sedan.";

export async function requireOperator(viewer: Viewer): Promise<void> {
  try {
    await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  } catch (error) {
    if (error instanceof AuthorizationError)
      throw new AuthorizationError("forbidden", FORBIDDEN_MESSAGE);
    throw error;
  }
}

/** Läget för sidan: kopplad, push på, inloggning sparad. */
export interface NewProductStatus {
  readonly connected: boolean;
  readonly enabled: boolean;
  readonly hasLogin: boolean;
  /** Svenskt besked när något saknas, annars null. */
  readonly blocker: string | null;
}

export async function awishStatus(
  db: Db,
  orgId: string,
): Promise<NewProductStatus & { sourceId: string | null }> {
  // Demo för kunder: Awish är avstängt (databasen nekar också Awish-källor i en demo).
  if (await isDemoOrganization(db, orgId)) {
    return {
      connected: false,
      enabled: false,
      hasLogin: false,
      sourceId: null,
      blocker: DEMO_MESSAGES.integrations,
    };
  }
  const source = await loadWebSource(db, orgId);
  if (!source) {
    return {
      connected: false,
      enabled: false,
      hasLogin: false,
      sourceId: null,
      blocker: "Koppla Awish först (Mer → Datakällor → Awish).",
    };
  }
  const creds = await readWebCredentials(db, source.id);
  const blocker = !creds
    ? "Spara Awish-inloggningen först (Mer → Datakällor → Awish)."
    : !source.enabled
      ? "Slå på Skicka påfyllningar till Awish först (Mer → Datakällor → Awish)."
      : null;
  return {
    connected: true,
    enabled: source.enabled,
    hasLogin: creds !== null,
    sourceId: source.id,
    blocker,
  };
}

/** Inloggad klient mot Awish, eller NewProductError om push är av eller inloggning saknas. */
export async function loggedInClient(
  viewer: Viewer,
  deps: NewProductDeps,
): Promise<{ db: Db; client: AwishWebApi; sourceId: string }> {
  await requireOperator(viewer);
  const db = deps.serviceDb ?? getServiceDb();
  // Före allt annat: en demo når aldrig Awish (inte heller med en källa som lagts in förbi spärren).
  if (await isDemoOrganization(db, viewer.organization.id)) {
    throw new NewProductError(DEMO_MESSAGES.integrations);
  }
  const status = await awishStatus(db, viewer.organization.id);
  if (status.blocker || !status.sourceId)
    throw new NewProductError(status.blocker ?? "Koppla Awish först.");
  const creds = await readWebCredentials(db, status.sourceId);
  if (!creds)
    throw new NewProductError("Spara Awish-inloggningen först (Mer → Datakällor → Awish).");
  const client = (deps.makeWebClient ?? createAwishWebClient)(deps.webClientOptions ?? {});
  await client.login(creds);
  return { db, client, sourceId: status.sourceId };
}

/**
 * En skrivning till Awish i taget per organisation. Låset hålls i en transaktion i
 * databasen medan anropen pågår och släpps när den avslutas (även vid fel).
 */
export async function withAwishWriteLock<T>(
  db: Db,
  orgId: string,
  fn: () => Promise<T>,
): Promise<T> {
  return db.transaction(async (tx) => {
    const [row] = await rows<{ ok: boolean }>(
      tx,
      sql`select pg_try_advisory_xact_lock(hashtextextended(${`binderlab:awish-produkt:${orgId}`}, 0)) as ok`,
    );
    if (!row?.ok) {
      throw new NewProductError(
        "Ett annat anrop till Awish pågår redan. Vänta en stund och försök igen.",
      );
    }
    return fn();
  });
}

// ---------------------------------------------------------------------------
// Sidan
// ---------------------------------------------------------------------------

export interface LinkedMachineChoice {
  readonly id: string;
  readonly code: string | null;
  readonly name: string;
}

export interface NewProductPageData {
  readonly status: NewProductStatus;
  readonly machines: LinkedMachineChoice[];
}

/** Läget och automaterna som är kopplade till Awish. Ingen kontakt med Awish. */
export async function newProductPageFor(
  viewer: Viewer,
  deps: NewProductDeps = {},
): Promise<NewProductPageData> {
  await requireOperator(viewer);
  const db = deps.serviceDb ?? getServiceDb();
  const orgId = viewer.organization.id;
  const { sourceId, ...status } = await awishStatus(db, orgId);
  if (!sourceId) return { status, machines: [] };
  const machines = await withUserDbFor(viewer.user, (tx) =>
    rows<{ id: string; code: string | null; name: string }>(
      tx,
      sql`select distinct m.id::text as id, m.code, m.name
          from public.source_machines sm
          join public.machines m on m.organization_id = sm.organization_id and m.id = sm.machine_id
          where sm.organization_id = ${orgId}::uuid and sm.data_source_id = ${sourceId}::uuid
            and sm.external_id ~ '^[0-9]{1,30}$' and m.archived_at is null
          order by m.code nulls last, m.name`,
    ),
  );
  return { status, machines };
}

// ---------------------------------------------------------------------------
// A) Ny produkt
// ---------------------------------------------------------------------------

/** Titeln i Binderlab för namnet: via alias (följer sammanslagningar), annars samma namn. */
export async function titleStateFor(
  tx: Tx,
  orgId: string,
  name: string,
): Promise<BinderlabTitleState | null> {
  const [hit] = await rows<{
    id: string;
    name: string;
    archived: boolean;
    own_product: boolean;
    price: number | null;
    has_alias: boolean;
  }>(
    tx,
    sql`
      with recursive input as (
        select lower(btrim(regexp_replace(normalize(${name}::text, NFKC), '\\s+', ' ', 'g'))) as normalized
      ),
      alias_hit as (
        select a.title_id, 0 as depth
        from input i
        join public.title_aliases a
          on a.organization_id = ${orgId}::uuid and a.alias_normalized = i.normalized
      ),
      chain as (
        select title_id, depth from alias_hit
        union all
        select t.merged_into_id, c.depth + 1
        from chain c
        join public.titles t on t.organization_id = ${orgId}::uuid and t.id = c.title_id
        where t.merged_into_id is not null and c.depth < 20
      ),
      by_alias as (select title_id from chain order by depth desc limit 1),
      by_name as (
        select t.id as title_id from public.titles t
        where t.organization_id = ${orgId}::uuid and t.archived_at is null
          and lower(t.name) = lower(${name}::text)
        limit 1
      ),
      chosen as (
        select title_id, true as has_alias from by_alias
        union all
        select title_id, false from by_name where not exists (select 1 from by_alias)
      )
      select t.id::text as id, t.name, t.archived_at is not null as archived, t.own_product,
             (select pp.unit_cost_ore from public.purchase_prices pp
               where pp.organization_id = t.organization_id and pp.title_id = t.id
               order by pp.valid_from desc limit 1) as price,
             c.has_alias
      from chosen c
      join public.titles t on t.organization_id = ${orgId}::uuid and t.id = c.title_id`,
  );
  if (!hit) return null;
  return {
    titleId: hit.id,
    titleName: hit.name,
    hasAlias: hit.has_alias,
    archived: hit.archived,
    ownProduct: hit.own_product,
    purchasePriceOre: hit.price === null ? null : Number(hit.price),
  };
}

export interface NewProductPreview {
  readonly lines: string[];
  readonly warnings: string[];
  readonly blocking: string | null;
  readonly nothingToDo: boolean;
  /** Skickas tillbaka med "Skicka till Awish". */
  readonly fingerprint: string;
}

function sameNameGoods(goods: readonly AwishGoodSummary[], name: string): AwishGoodSummary[] {
  const key = goodNameKey(name);
  return goods.filter((g) => goodNameKey(g.name) === key);
}

async function computeNewProductPlan(
  viewer: Viewer,
  client: AwishWebApi,
  raw: unknown,
  image: GoodImage | null,
  deps: NewProductDeps,
): Promise<{ plan: NewProductPlan; fingerprint: string; goods: AwishGoodSummary[] }> {
  const input = newProductInputSchema.parse(raw);
  const orgId = viewer.organization.id;
  const title = await withUserDbFor(viewer.user, (tx) => titleStateFor(tx, orgId, input.name));
  const goods = await client.allGoods();
  const today = businessToday((deps.now ?? (() => new Date()))(), viewer.organization.timezone);
  const plan = planNewProduct({
    input,
    sameNameGoods: sameNameGoods(goods, input.name),
    title,
    image: image ? { fileName: image.fileName, bytes: image.bytes.byteLength } : null,
    today,
  });
  const fingerprint = planFingerprint(plan, {
    image: image?.sha256 ?? null,
    salePrice: input.salePrice,
    purchasePrice: input.purchasePrice,
  });
  return { plan, fingerprint, goods };
}

/** Förhandsvisning: läser Awish och Binderlab och visar vad som skulle hända. Skriver inget. */
export async function previewNewProductFor(
  viewer: Viewer,
  raw: unknown,
  image: GoodImage | null,
  deps: NewProductDeps = {},
): Promise<NewProductPreview> {
  const { client } = await loggedInClient(viewer, deps);
  const { plan, fingerprint } = await computeNewProductPlan(viewer, client, raw, image, deps);
  return {
    lines: plan.lines,
    warnings: plan.warnings,
    blocking: plan.blocking,
    nothingToDo: plan.nothingToDo,
    fingerprint,
  };
}

export interface NewProductResult {
  readonly status: "created" | "linked" | "nothing";
  readonly goodId: number;
  readonly titleId: string | null;
  readonly message: string;
}

/** Binderlab: titel, alias, inköpspris och egen produkt i en transaktion (som användaren). */
async function saveInBinderlab(viewer: Viewer, plan: NewProductPlan): Promise<string> {
  const orgId = viewer.organization.id;
  return withUserDbFor(viewer.user, async (tx) => {
    let titleId = plan.title.action === "existing" ? plan.title.titleId : null;
    if (!titleId) {
      const [ins] = await rows<{ id: string }>(
        tx,
        sql`insert into public.titles (organization_id, name)
            values (${orgId}::uuid, ${plan.name})
            on conflict do nothing
            returning id::text as id`,
      );
      titleId = ins?.id ?? null;
      if (!titleId) {
        const [existing] = await rows<{ id: string }>(
          tx,
          sql`select t.id::text as id from public.titles t
              where t.organization_id = ${orgId}::uuid and t.archived_at is null
                and lower(t.name) = lower(${plan.name})
              limit 1`,
        );
        titleId = existing?.id ?? null;
      }
      if (!titleId) throw new NewProductError(`Kunde inte skapa titeln ${plan.name}.`);
    }
    if (plan.alias === "create") {
      await tx.execute(
        sql`insert into public.title_aliases (organization_id, title_id, alias)
            values (${orgId}::uuid, ${titleId}::uuid, ${plan.name})
            on conflict do nothing`,
      );
    }
    if (plan.purchasePrice.action === "set") {
      await tx.execute(
        sql`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from, note)
            values (${orgId}::uuid, ${titleId}::uuid, ${plan.purchasePrice.ore},
                    ${plan.purchasePrice.validFrom}::date, 'Ny produkt')`,
      );
    }
    if (plan.ownProduct.action === "set") {
      await tx.execute(
        sql`update public.titles set own_product = ${plan.ownProduct.value}
            where organization_id = ${orgId}::uuid and id = ${titleId}::uuid`,
      );
    }
    return titleId;
  });
}

/**
 * "Skicka till Awish": skapar varan i Awish (om den inte finns) och kopplar den i Binderlab.
 * `fingerprint` måste vara förhandsvisningens; annars skickas ingenting.
 */
export async function createNewProductFor(
  viewer: Viewer,
  raw: unknown,
  image: GoodImage | null,
  fingerprint: string,
  deps: NewProductDeps = {},
): Promise<NewProductResult> {
  const { db, client } = await loggedInClient(viewer, deps);
  return withAwishWriteLock(db, viewer.organization.id, async () => {
    const {
      plan,
      fingerprint: now,
      goods,
    } = await computeNewProductPlan(viewer, client, raw, image, deps);
    if (plan.blocking) throw new NewProductError(plan.blocking);
    if (now !== fingerprint) throw new NewProductError(STALE_MESSAGE);

    let goodId: number;
    if (plan.awish.action === "exists") {
      goodId = plan.awish.goodId;
      if (plan.nothingToDo) {
        return {
          status: "nothing",
          goodId,
          titleId: plan.title.action === "existing" ? plan.title.titleId : null,
          message: `${plan.name} finns redan i Awish och Binderlab.`,
        };
      }
    } else {
      // Valutan före bilden: saknas SEK laddas ingen bild upp i onödan.
      const { merchantId } = await client.profile();
      const currencies = await client.currencies(merchantId);
      const sek = currencies.find((c) => c.code === "SEK");
      if (!sek)
        throw new NewProductError(
          "Awish-butiken har ingen valuta SEK. Lägg till den i Awish först.",
        );
      const imageUrl = image ? await client.uploadImage(image) : null;
      const before = new Set(goods.map((g) => g.id));
      await client.createGood(
        encodeGoodInput({
          name: plan.name,
          salePriceOre: plan.awish.priceOre,
          currencyId: sek.id,
          imageUrl,
        }),
      );
      const created = sameNameGoods(await client.allGoods(), plan.name).filter(
        (g) => !before.has(g.id),
      );
      if (created.length !== 1) {
        throw new NewProductError(
          `Awish tog emot ${plan.name} men varan syns inte i listan. Titta i Awish innan du försöker igen.`,
        );
      }
      goodId = created[0]!.id;
    }

    let titleId: string;
    try {
      titleId = await saveInBinderlab(viewer, plan);
    } catch (error) {
      const why = error instanceof NewProductError ? error.message : dbErrorMessage(error);
      throw new NewProductError(
        `${plan.name} finns nu i Awish men sparades inte i Binderlab (${why}). Förhandsgranska och skicka igen, så kopplas den.`,
      );
    }
    return plan.awish.action === "create"
      ? {
          status: "created",
          goodId,
          titleId,
          message: `Klart! ${plan.name} finns nu i Awish och i Binderlab.`,
        }
      : {
          status: "linked",
          goodId,
          titleId,
          message: `Klart! ${plan.name} är kopplad i Binderlab.`,
        };
  });
}

// ---------------------------------------------------------------------------
// B) Lägg en vara i ett fack
// ---------------------------------------------------------------------------

async function awishIdOf(
  db: Db,
  viewer: Viewer,
  sourceId: string,
  machineId: string,
): Promise<number> {
  const id = await awishMachineId(db, viewer.organization.id, sourceId, machineId);
  if (id === null) throw new NewProductError("Automaten är inte kopplad till Awish.");
  return id;
}

export interface SlotChoices {
  readonly slots: AwishSlot[];
  readonly goods: AwishGoodSummary[];
}

/** Automatens fack och alla varor i Awish (läses nu). Skriver inget. */
export async function slotChoicesFor(
  viewer: Viewer,
  machineId: string,
  deps: NewProductDeps = {},
): Promise<SlotChoices> {
  const { db, client, sourceId } = await loggedInClient(viewer, deps);
  const awishId = await awishIdOf(db, viewer, sourceId, machineId);
  const [slots, goods] = [await client.slots(awishId), await client.allGoods()];
  return {
    slots: [...slots].sort(
      (a, b) =>
        (a.channelName ?? "").localeCompare(b.channelName ?? "", "sv", { numeric: true }) ||
        a.id - b.id,
    ),
    goods: [...goods].sort((a, b) => a.name.localeCompare(b.name, "sv")),
  };
}

export interface SlotChangePreview {
  readonly lines: string[];
  readonly warnings: string[];
  readonly blocking: string | null;
  readonly confirm: string | null;
  readonly unchanged: boolean;
  readonly fingerprint: string;
}

async function computeSlotPlan(
  db: Db,
  client: AwishWebApi,
  viewer: Viewer,
  sourceId: string,
  raw: unknown,
): Promise<{ plan: SlotChangePlan; fingerprint: string }> {
  const input = slotChangeInputSchema.parse(raw);
  const awishId = await awishIdOf(db, viewer, sourceId, input.machineId);
  const slot = (await client.slots(awishId)).find((s) => s.id === input.productId);
  if (!slot) throw new NewProductError("Facket finns inte i automaten i Awish. Ladda om.");
  const good = (await client.allGoods()).find((g) => g.id === input.goodId);
  if (!good) throw new NewProductError("Varan finns inte i Awish. Ladda om.");
  const plan = planSlotChange({ slot, good, count: input.count });
  return { plan, fingerprint: planFingerprint(plan, { machineId: input.machineId }) };
}

export async function previewSlotChangeFor(
  viewer: Viewer,
  raw: unknown,
  deps: NewProductDeps = {},
): Promise<SlotChangePreview> {
  const { db, client, sourceId } = await loggedInClient(viewer, deps);
  const { plan, fingerprint } = await computeSlotPlan(db, client, viewer, sourceId, raw);
  return {
    lines: plan.lines,
    warnings: plan.warnings,
    blocking: plan.blocking,
    confirm: plan.confirm,
    unchanged: plan.unchanged,
    fingerprint,
  };
}

/**
 * Skickar bytet till Awish (UpdateProduct med good_id, status och current_inventory, som
 * panelens facksida). Kräver förhandsvisningens fingeravtryck och, när planen frågar,
 * `confirmed`. Läser facket igen efteråt och kontrollerar att Awish sparade det.
 */
export async function applySlotChangeFor(
  viewer: Viewer,
  raw: unknown,
  fingerprint: string,
  confirmed: boolean,
  deps: NewProductDeps = {},
): Promise<{ message: string }> {
  const { db, client, sourceId } = await loggedInClient(viewer, deps);
  return withAwishWriteLock(db, viewer.organization.id, async () => {
    const { plan, fingerprint: now } = await computeSlotPlan(db, client, viewer, sourceId, raw);
    if (plan.blocking) throw new NewProductError(plan.blocking);
    if (now !== fingerprint) throw new NewProductError(STALE_MESSAGE);
    if (plan.unchanged)
      return { message: `${plan.slotName} har redan ${plan.to.goodName} ${plan.to.count} st.` };
    if (plan.confirm && !confirmed) throw new NewProductError(`Bekräfta först: ${plan.confirm}`);

    await client.setProductInventory(plan.productId, {
      goodId: plan.to.goodId,
      status: plan.status,
      currentInventory: plan.to.count,
    });
    const input = slotChangeInputSchema.parse(raw);
    const awishId = await awishIdOf(db, viewer, sourceId, input.machineId);
    const after = (await client.slots(awishId)).find((s) => s.id === plan.productId);
    if (!after || after.goodId !== plan.to.goodId || after.currentInventory !== plan.to.count) {
      throw new NewProductError(
        `Awish sparade inte ändringen i ${plan.slotName}. Titta i Awish och försök igen.`,
      );
    }
    return { message: `Klart! ${plan.slotName}: ${plan.to.goodName} ${plan.to.count} st.` };
  });
}
