/**
 * Varor i Awish via gRPC-API:t (CreateGood, UpdateGood, DeleteGood), som alternativ till
 * webbpanelen (web-client.ts). Vilken väg som används styrs av goods_writes_via under
 * Datakällor → Awish API: "web" (standard, som i dag), "api" eller "api_then_web" (API:t,
 * och webbpanelen om API:t säger nej). Webbvägen tas aldrig bort.
 *
 * Priser: Binderlab räknar i öre; API:t vill ha text med två decimaler ("79.00").
 */

import "server-only";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { AuthorizationError } from "@/server/access";
import { runControlAction } from "@/server/awish/control/guard";
import type {
  AwishControlApi,
  AwishCurrencyInfo,
  AwishGoodInput,
  AwishProductDetail,
} from "@/server/awish/control/types";
import { awishPriceToOre, NewProductError, type GoodInput } from "@/server/awish/goods";
import type { Db } from "@/db/client";
import { awishSourceOf, linkedMachines, type LinkedMachine } from "@/server/awish/marketing";
import type { AwishWebApi } from "@/server/awish/web-client";
import type { Viewer } from "@/server/data/core/loaders";

import {
  awishIdOf,
  catalogPreview,
  CatalogError,
  dbOf,
  goodsWritesVia,
  keyOf,
  outcomeOf,
  requireOperator,
  STALE_MESSAGE,
  withReadClient,
  type CatalogDeps,
  type CatalogOutcome,
  type CatalogPreview,
  type WritesVia,
} from "./common";
import { sekCurrency } from "./currencies";

// ---------------------------------------------------------------------------
// Rena omvandlingar
// ---------------------------------------------------------------------------

/** 7900 öre → "79.00". Kastar för negativa och icke-heltal. */
export function orePriceText(ore: number): string {
  if (!Number.isSafeInteger(ore) || ore < 0) throw new RangeError("Ogiltigt belopp.");
  return `${Math.floor(ore / 100)}.${String(ore % 100).padStart(2, "0")}`;
}

/** Panelens pris (kr som tal) → API:ts text, eller undefined för 0/saknas. */
function priceText(kr: unknown, keepZero = false): string | undefined {
  const ore = awishPriceToOre(kr);
  if (ore === null) return keepZero ? "0.00" : undefined;
  if (ore === 0 && !keepZero) return undefined;
  return orePriceText(ore);
}

/**
 * Panelens GoodInput → API:ts vara. Valutan behålls när API:t känner den; annars SEK (en ny
 * vara har bara SEK-priset). Fält som bara finns i panelen (slug, enhet, attribut, flera
 * valutor) skickas inte.
 */
export function webGoodToApiInput(
  input: GoodInput,
  currencies: readonly AwishCurrencyInfo[],
): AwishGoodInput {
  const known = new Set(currencies.map((c) => c.id));
  const sek = sekCurrency(currencies);
  const prices = input.prices.map((p) => {
    const currencyId = known.has(String(p.currency_id)) ? String(p.currency_id) : sek?.id;
    if (!currencyId) throw new NewProductError("Awish-butiken har ingen valuta SEK.");
    const price: AwishGoodInput["prices"][number] = {
      id: String(p.id),
      price: priceText(p.price, true)!,
      currencyId,
    };
    const original = priceText(p.original_price);
    const member = priceText(p.member_price);
    const cost = priceText(p.cost_price);
    if (original) price.originalPrice = original;
    if (member) price.memberPrice = member;
    if (cost) price.costPrice = cost;
    return price;
  });
  const out: AwishGoodInput = {
    name: input.name,
    description: input.description,
    prices,
    media: [...input.media],
    isTaxExempt: input.is_tax_exempt,
    taxRate: String(input.tax_rate),
    isReturnable: input.is_returnable,
  };
  if (input.thumb) out.thumb = input.thumb;
  if (input.content) out.content = input.content;
  return out;
}

// ---------------------------------------------------------------------------
// Skrivaren (webbpanelen eller API:t)
// ---------------------------------------------------------------------------

export interface GoodsWriter {
  readonly via: WritesVia;
  /** `fingerprint` = förhandsvisningens (sparas i loggen). */
  createGood(input: GoodInput, fingerprint: string): Promise<void>;
  updateGood(id: number, input: GoodInput, fingerprint: string): Promise<void>;
}

/** Fall tillbaka till webbpanelen bara när API:t sa nej (inte vid okänt utfall eller spärr). */
const FALLBACK_ON = new Set(["awish", "not_connected", "sign_failed", "disabled"]);

/**
 * Hur webbvägen skrivs och vad som händer när API:t tog emot. Ny produkt och Redigera vara
 * skickar in sina skrivningar med nya försök och hälsa (web-service.ts, health.ts), så att
 * webbvägen beter sig exakt som utan API-läget.
 */
export interface GoodsWriterHooks {
  /** Webbvägens CreateGood (standard: `web.createGood`). */
  webCreate?: (input: GoodInput) => Promise<void>;
  /** Webbvägens UpdateGood (standard: `web.updateGood`). */
  webUpdate?: (id: number, input: GoodInput) => Promise<void>;
  /** Körs när API:t tog emot skrivningen (t.ex. hälsan för vägen). Får inte kasta. */
  onApiOk?: () => Promise<void>;
}

/**
 * Skrivaren för organisationen: webbpanelen (som i dag) eller API:t enligt
 * goods_writes_via. `web` är den inloggade panelklienten (läsningarna går alltid via den).
 */
export async function goodsWriterFor(
  viewer: Viewer,
  web: AwishWebApi,
  sourceId: string,
  deps: CatalogDeps = {},
  hooks: GoodsWriterHooks = {},
): Promise<GoodsWriter> {
  const db = dbOf(deps);
  const via = await goodsWritesVia(db, viewer.organization.id, sourceId);
  const webCreate = hooks.webCreate ?? ((input: GoodInput) => web.createGood(input));
  const webUpdate =
    hooks.webUpdate ?? ((id: number, input: GoodInput) => web.updateGood(id, input));
  if (via === "web") {
    return {
      via,
      async createGood(input) {
        await webCreate(input);
      },
      async updateGood(id, input) {
        await webUpdate(id, input);
      },
    };
  }
  const run = deps.run ?? runControlAction;
  const send = async (
    kind: "good_create" | "good_update",
    targetId: string | null,
    input: GoodInput,
    fingerprint: string,
    call: (api: AwishControlApi, mapped: AwishGoodInput) => Promise<unknown>,
    fallback: () => Promise<unknown>,
  ): Promise<void> => {
    const r = await run(
      viewer,
      {
        kind,
        targetId,
        // En ny nyckel per försök (en uuid, som spärren kräver). En nyckel ur fingeravtrycket
        // skulle bli densamma för två likadana ändringar vid olika tillfällen (A→B, B→A,
        // A→B igen) och den tredje skulle tyst inte skickas. Dubbeltryck stoppas av
        // Awish-låset per organisation runt Ny produkt och Redigera vara.
        idempotencyKey: randomUUID(),
        auditRequest: {
          name: input.name,
          prices: input.prices.length,
          preview: fingerprint.slice(0, 16),
        },
      },
      async (api) => call(api, webGoodToApiInput(input, await api.currencies())),
      deps,
    );
    if (r.ok) {
      await hooks.onApiOk?.();
      return;
    }
    if (r.kind === "forbidden") throw new AuthorizationError("forbidden", r.message);
    if (via === "api_then_web" && FALLBACK_ON.has(r.kind)) {
      await fallback();
      return;
    }
    throw new NewProductError(r.message);
  };
  return {
    via,
    createGood: (input, fingerprint) =>
      send(
        "good_create",
        null,
        input,
        fingerprint,
        (api, mapped) => api.createGood(mapped),
        () => webCreate(input),
      ),
    updateGood: (id, input, fingerprint) =>
      send(
        "good_update",
        String(id),
        input,
        fingerprint,
        (api, mapped) => api.updateGood(String(id), mapped),
        () => webUpdate(id, input),
      ),
  };
}

// ---------------------------------------------------------------------------
// Ta bort vara (DeleteGood)
// ---------------------------------------------------------------------------

export interface GoodPlacement {
  readonly machine: string;
  readonly slot: string;
}

/** Facken där varan ligger (på våra kopplade automater). */
export function placementsOf(
  goodId: string,
  machines: readonly { machine: LinkedMachine; products: readonly AwishProductDetail[] }[],
): GoodPlacement[] {
  const out: GoodPlacement[] = [];
  for (const { machine, products } of machines) {
    for (const p of products) {
      if (p.goodId === goodId) {
        out.push({
          machine: machine.code || machine.name,
          slot: p.channel?.name || `fack ${p.id}`,
        });
      }
    }
  }
  return out;
}

export function planDeleteGood(args: { goodName: string; placements: readonly GoodPlacement[] }): {
  lines: string[];
  blocking: string | null;
  confirm: string | null;
} {
  const first = args.placements[0];
  if (first) {
    const more = args.placements.length > 1 ? ` och ${args.placements.length - 1} fack till` : "";
    return {
      lines: [],
      blocking: `Varan ligger i ${first.slot} på ${first.machine}${more}. Byt pack i facket först.`,
      confirm: null,
    };
  }
  return {
    lines: [`${args.goodName} tas bort i Awish.`],
    blocking: null,
    confirm: "Varan tas bort i Awish. Det går inte att ångra.",
  };
}

function cleanName(raw: unknown): string {
  const s = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim().slice(0, 80) : "";
  return s || "Varan";
}

/**
 * Alla Awish-automater som synken sett i kontot (source_machines), även de som inte är
 * kopplade till en automat i Binderlab: en vara i en okopplad automat får inte tas bort.
 */
async function allAwishMachines(db: Db, orgId: string): Promise<LinkedMachine[]> {
  const linked = await linkedMachines(db, orgId);
  const source = await awishSourceOf(db, orgId);
  if (!source) return linked;
  const seen = new Set(linked.map((m) => m.awishMachineId));
  const rows = Array.from(
    await db.execute(
      sql`select distinct external_id, external_name from public.source_machines
          where organization_id = ${orgId}::uuid and data_source_id = ${source.id}::uuid
            and external_id ~ '^[0-9]{1,20}$'
          order by external_id`,
    ),
  ) as { external_id: string; external_name: string | null }[];
  const unlinked = rows
    .filter((r) => !seen.has(r.external_id))
    .map((r) => ({
      machineId: "",
      code: r.external_name?.trim() || `Awish-automat ${r.external_id}`,
      name: r.external_name?.trim() || `Awish-automat ${r.external_id}`,
      awishMachineId: r.external_id,
    }));
  return [...linked, ...unlinked];
}

async function computeDelete(viewer: Viewer, raw: unknown, deps: CatalogDeps) {
  const r = (raw ?? {}) as { goodId?: unknown; goodName?: unknown };
  const goodId = awishIdOf(r.goodId, "Välj vara.");
  const goodName = cleanName(r.goodName);
  return withReadClient(viewer, deps, async ({ api, db }) => {
    const machines = await allAwishMachines(db, viewer.organization.id);
    const read = [];
    for (const machine of machines) {
      read.push({ machine, products: await api.productDetails(machine.awishMachineId) });
    }
    const plan = planDeleteGood({ goodName, placements: placementsOf(goodId, read) });
    return { goodId, goodName, plan };
  });
}

export async function previewDeleteGoodFor(
  viewer: Viewer,
  raw: unknown,
  deps: CatalogDeps = {},
): Promise<CatalogPreview> {
  const { goodId, plan } = await computeDelete(viewer, raw, deps);
  return catalogPreview(plan, { goodId, kind: "good_delete" });
}

export async function deleteGoodFor(
  viewer: Viewer,
  raw: unknown,
  deps: CatalogDeps = {},
): Promise<CatalogOutcome> {
  const r = (raw ?? {}) as { fingerprint?: unknown; idempotencyKey?: unknown };
  const key = keyOf(r.idempotencyKey);
  const { goodId, goodName, plan } = await computeDelete(viewer, raw, deps);
  if (plan.blocking) throw new CatalogError(plan.blocking);
  const now = catalogPreview(plan, { goodId, kind: "good_delete" }).fingerprint;
  if (now !== r.fingerprint) throw new CatalogError(STALE_MESSAGE);
  const result = await (deps.run ?? runControlAction)(
    viewer,
    {
      kind: "good_delete",
      targetId: goodId,
      idempotencyKey: key,
      auditRequest: { id: goodId },
    },
    (api) => api.deleteGood(goodId),
    deps,
  );
  return outcomeOf(result, `Klart! ${goodName} är borttagen i Awish.`);
}

// ---------------------------------------------------------------------------
// Kategori på en vara
// ---------------------------------------------------------------------------

/**
 * UpdateGood har priser och bilder som `repeated`: "inte skickat" och "tom lista" ser
 * likadana ut för Awish. Ersätter Awish listorna när de saknas skulle ett kategoribyte
 * tömma varans priser och bilder. Därför är kategoribytet via API avstängt tills det
 * provats på riktigt (en testvara: priser och bilder ska finnas kvar efteråt) och
 * AWISH_GOOD_CATEGORY_API=true satts.
 */
export const GOOD_CATEGORY_OFF_MESSAGE =
  "Byt kategori i Awishs egen panel tills vidare. Vi har inte bekräftat att Awish behåller varans priser och bilder när bara kategorin skickas.";

export function goodCategoryApiEnabled(env: Record<string, string | undefined>): boolean {
  return (env.AWISH_GOOD_CATEGORY_API ?? "").trim().toLowerCase() === "true";
}

async function computeGoodCategory(viewer: Viewer, raw: unknown, deps: CatalogDeps) {
  const r = (raw ?? {}) as { goodId?: unknown; goodName?: unknown; categoryId?: unknown };
  const goodId = awishIdOf(r.goodId, "Välj vara.");
  const categoryId = awishIdOf(r.categoryId, "Välj kategori.");
  if (!goodCategoryApiEnabled(deps.env ?? process.env)) {
    await requireOperator(viewer);
    const plan = { lines: [], blocking: GOOD_CATEGORY_OFF_MESSAGE };
    const extra = { goodId, categoryId, kind: "good_category" };
    return { goodId, categoryId, category: undefined, plan, extra };
  }
  // Kategorin måste finnas (läses ur Awish, inte ur begäran).
  const category = await withReadClient(viewer, deps, async ({ api }) =>
    (await api.categories()).find((c) => c.id === categoryId),
  );
  const plan = category
    ? { lines: [`${cleanName(r.goodName)} → ${category.title}.`], blocking: null }
    : { lines: [], blocking: "Kategorin finns inte längre. Ladda om sidan." };
  const extra = { goodId, categoryId, kind: "good_category" };
  return { goodId, categoryId, category, plan, extra };
}

/** Förhandsvisning för "Kategori" på en vara. */
export async function previewGoodCategoryFor(
  viewer: Viewer,
  raw: unknown,
  deps: CatalogDeps = {},
): Promise<CatalogPreview> {
  const { plan, extra } = await computeGoodCategory(viewer, raw, deps);
  return catalogPreview(plan, extra);
}

/** Byter varans kategori (UpdateGood med bara category_id). */
export async function setGoodCategoryFor(
  viewer: Viewer,
  raw: unknown,
  deps: CatalogDeps = {},
): Promise<CatalogOutcome> {
  const r = (raw ?? {}) as { fingerprint?: unknown; idempotencyKey?: unknown };
  const key = keyOf(r.idempotencyKey);
  const { goodId, categoryId, category, plan, extra } = await computeGoodCategory(
    viewer,
    raw,
    deps,
  );
  if (plan.blocking || !category) throw new CatalogError(plan.blocking ?? "Välj kategori.");
  if (catalogPreview(plan, extra).fingerprint !== r.fingerprint)
    throw new CatalogError(STALE_MESSAGE);
  const result = await (deps.run ?? runControlAction)(
    viewer,
    {
      kind: "good_update",
      targetId: goodId,
      idempotencyKey: key,
      auditRequest: { id: goodId, category_id: categoryId },
    },
    (api) => api.updateGood(goodId, { categoryId }),
    deps,
  );
  return outcomeOf(result, `Klart! Varan ligger nu under ${category.title}.`);
}
