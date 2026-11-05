/**
 * "Redigera vara": ren logik utan nätverk och databas. Läsning av en vara som Awishs panel
 * läser den, kodning av UpdateGood som panelens sida "Redigera vara" skickar den, planen som
 * visas före "Spara i Awish" och kontrollen av varan efteråt.
 *
 * Panelens sida (GoodsCreate med id, version 1.30.4) läser varan, gör om priserna till tal
 * och skickar HELA varan tillbaka med UpdateGood. Binderlab gör exakt likadant och ändrar
 * bara namn, SEK-priset (samma pris-id) och bilden (thumb + media[0]); allt annat skickas
 * tillbaka som det var, med panelens egna regler för fält som kräver behörighet.
 */

import { z } from "zod";

import {
  cleanGoodName,
  formatKr,
  goodNameKey,
  MAX_GOOD_NAME,
  MAX_SALE_PRICE_ORE,
  NewProductError,
  oreToAwishPrice,
  awishPriceToOre,
  parseKronor,
  type AwishGoodSummary,
  type BinderlabTitleState,
  type GoodInput,
} from "./goods";

/** Behörigheterna panelen läser (permissionEnum, goods.*). Profile.permissions är en lista strängar. */
export const GOOD_PERMISSIONS = {
  create: "goods:create",
  update: "goods:update",
  attributes: "goods:attributes:update",
  originalPrice: "goods:original_price:update",
  memberPrice: "goods:member_price:update",
  costPrice: "goods:cost_price:update",
} as const;

/** Ett pris på en vara som panelen håller det (talen i kronor). */
export interface AwishGoodPrice {
  readonly id: number;
  readonly currencyId: number;
  readonly currencyCode: string;
  readonly price: number;
  readonly originalPrice: number;
  readonly memberPrice: number;
  readonly costPrice: number;
}

/** En vara med alla fält som panelens redigering skickar tillbaka. */
export interface AwishGoodFull {
  readonly id: number;
  readonly name: string;
  readonly description: string;
  readonly multiCurrencyEnabled: boolean;
  readonly prices: readonly AwishGoodPrice[];
  readonly thumb: string | null;
  readonly media: readonly string[];
  readonly content: string;
  readonly slug: string;
  readonly unitId: number | null;
  readonly attributes: ReadonlyArray<{
    readonly id: number;
    readonly label_name: string;
    readonly label_value: readonly string[];
    readonly immutable: boolean;
  }>;
  readonly isTaxExempt: boolean;
  readonly taxRate: number;
  readonly isReturnable: boolean;
}

/** parseFloat som panelen, men aldrig NaN (NaN blir null i JSON och nekas som Float). */
function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number.parseFloat(String(v ?? ""));
  return Number.isFinite(n) ? n : fallback;
}

/**
 * En vara ur Goods som panelens redigering läser den (watch på good): priserna som tal,
 * currency_id = currency.id ?? 1, unit_id = unit.id, tax_rate som tal.
 */
export function parseAwishGood(raw: Record<string, unknown>): AwishGoodFull {
  const prices = Array.isArray(raw.prices) ? (raw.prices as Array<Record<string, unknown>>) : [];
  const unit = (raw.unit ?? null) as { id?: unknown } | null;
  const attributes = Array.isArray(raw.attributes)
    ? (raw.attributes as Array<Record<string, unknown>>)
    : [];
  return {
    id: Number(raw.id),
    name: String(raw.name ?? ""),
    description: String(raw.description ?? ""),
    multiCurrencyEnabled: raw.multi_currency_enabled === true,
    prices: prices.map((p) => {
      const currency = (p.currency ?? null) as { id?: unknown; code?: unknown } | null;
      return {
        id: Number(p.id ?? 0),
        currencyId: currency?.id == null ? 1 : Number(currency.id),
        currencyCode: String(currency?.code ?? "").toUpperCase(),
        price: num(p.price),
        originalPrice: num(p.original_price),
        memberPrice: num(p.member_price),
        costPrice: num(p.cost_price),
      };
    }),
    thumb: typeof raw.thumb === "string" ? raw.thumb : null,
    media: Array.isArray(raw.media) ? (raw.media as unknown[]).map(String) : [],
    content: String(raw.content ?? ""),
    slug: String(raw.slug ?? ""),
    unitId: unit?.id == null ? null : Number(unit.id),
    attributes: attributes.map((a) => ({
      id: Number(a.id ?? 0),
      label_name: String(a.label_name ?? ""),
      label_value: Array.isArray(a.label_value) ? (a.label_value as unknown[]).map(String) : [],
      immutable: a.immutable === true,
    })),
    isTaxExempt: raw.is_tax_exempt === true,
    taxRate: num(raw.tax_rate ?? "0.0"),
    isReturnable: raw.is_returnable === true,
  };
}

/** SEK-priset (det automaten tar betalt i), eller null om varan saknar ett. */
export function sekPrice(good: Pick<AwishGoodFull, "prices">): AwishGoodPrice | null {
  return good.prices.find((p) => p.currencyCode === "SEK") ?? null;
}

/**
 * Fält som varan har värden i men kontot saknar behörighet för. Panelens redigering skickar
 * då 0 (priserna) eller [] (egenskaperna), vilket skulle nollställa dem i Awish; Binderlab
 * stoppar i stället.
 */
export function fieldsAtRisk(good: AwishGoodFull, permissions: readonly string[]): string[] {
  const has = (p: string) => permissions.includes(p);
  const out: string[] = [];
  if (!has(GOOD_PERMISSIONS.originalPrice) && good.prices.some((p) => p.originalPrice !== 0)) {
    out.push("ordinarie pris");
  }
  if (!has(GOOD_PERMISSIONS.memberPrice) && good.prices.some((p) => p.memberPrice !== 0)) {
    out.push("medlemspris");
  }
  if (!has(GOOD_PERMISSIONS.costPrice) && good.prices.some((p) => p.costPrice !== 0)) {
    out.push("kostnadspris");
  }
  if (!has(GOOD_PERMISSIONS.attributes) && good.attributes.length > 0) out.push("egenskaper");
  return out;
}

function listText(parts: readonly string[]): string {
  if (parts.length <= 1) return parts[0] ?? "";
  return `${parts.slice(0, -1).join(", ")} och ${parts.at(-1)}`;
}

/** Varans huvudbild som panelen visar den (thumb, annars första bilden). */
export function goodImage(good: Pick<AwishGoodFull, "thumb" | "media">): string | null {
  return good.thumb || good.media[0] || null;
}

/** Varan som Binderlab visar den (samma som allGoods: SEK-priset, annars första). */
export function summaryOf(good: AwishGoodFull): AwishGoodSummary {
  const price = sekPrice(good) ?? good.prices[0] ?? null;
  return {
    id: good.id,
    name: good.name,
    priceOre: price ? awishPriceToOre(price.price) : null,
    thumb: good.thumb ? good.thumb : null,
  };
}

const noControl = /^[^\p{Cc}]*$/u;

/** Formuläret "Redigera vara": vara, namn och försäljningspris (kronor → öre). */
export const editGoodInputSchema = z.object({
  goodId: z.coerce.number({ error: "Välj vara." }).int("Välj vara.").positive("Välj vara."),
  name: z
    .string({ error: "Skriv ett namn." })
    .transform(cleanGoodName)
    .pipe(
      z
        .string()
        .min(1, "Skriv ett namn.")
        .max(MAX_GOOD_NAME, `Namnet får vara högst ${MAX_GOOD_NAME} tecken.`)
        .regex(noControl, "Namnet får inte innehålla radbrytningar."),
    ),
  salePrice: z.union([z.string(), z.number()]).transform((raw, ctx) => {
    const ore = parseKronor(raw);
    if (ore === null) {
      ctx.addIssue({ code: "custom", message: "Skriv priset i kronor, t.ex. 79 eller 79,50." });
      return z.NEVER;
    }
    if (ore < 1) {
      ctx.addIssue({ code: "custom", message: "Priset måste vara minst 0,01 kr." });
      return z.NEVER;
    }
    if (ore > MAX_SALE_PRICE_ORE) {
      ctx.addIssue({
        code: "custom",
        message: `Priset får vara högst ${formatKr(MAX_SALE_PRICE_ORE)}.`,
      });
      return z.NEVER;
    }
    return ore;
  }),
});
export type EditGoodInput = z.output<typeof editGoodInputSchema>;

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Beskrivning och innehåll som Binderlab själv satte (= namnet) följer med ett nytt namn. */
function followsName(good: AwishGoodFull, newName: string) {
  const changed = newName !== good.name;
  return {
    description: changed && good.description === good.name ? newName : good.description,
    content:
      changed && good.content === `<p>${escapeHtml(good.name)}</p>`
        ? `<p>${escapeHtml(newName)}</p>`
        : good.content,
  };
}

/** Bilderna efter ett byte: den nya först (thumb), den gamla huvudbilden bort, högst 5. */
export function mediaAfter(good: AwishGoodFull, imageUrl: string | null): string[] {
  if (!imageUrl) return [...good.media];
  const old = goodImage(good);
  return [imageUrl, ...good.media.filter((m) => m !== old && m !== imageUrl)].slice(0, 5);
}

/**
 * UpdateGood-indata exakt som panelens sida "Redigera vara" (create-*.js, handlern P):
 *
 *   { name, description, thumb: thumb ?? media[0], content, media, multi_currency_enabled,
 *     slug, unit_id, attributes: (behörighet goods:attributes:update) ? attributes : [],
 *     is_tax_exempt, tax_rate: parseFloat(tax_rate), is_returnable,
 *     prices: prices.map(p => ({ id, good_id, currency_id, price,
 *       original_price: (goods:original_price:update) ? p.original_price : 0,
 *       member_price: (goods:member_price:update) ? p.member_price : 0,
 *       cost_price: (goods:cost_price:update) ? p.cost_price : 0 })) }
 *
 * good_id finns inte i panelens prisfråga och blir undefined (utelämnas i JSON), så det
 * skickas inte här heller. unit_id är null när varan saknar enhet (panelen utelämnar det;
 * null är samma sak för ett frivilligt fält och är det CreateGood redan skickar).
 * Bara namn, SEK-priset och bilden ändras; allt annat skickas tillbaka som det lästes.
 */
export function encodeUpdateGoodInput(
  good: AwishGoodFull,
  change: { name: string; priceOre: number; imageUrl: string | null },
  permissions: readonly string[],
): GoodInput {
  const has = (p: string) => permissions.includes(p);
  const sek = sekPrice(good);
  if (!sek) throw new NewProductError(`${good.name} har inget pris i SEK i Awish.`);
  const name = cleanGoodName(change.name);
  if (name === "") throw new NewProductError("Skriv ett namn.");
  if (
    !Number.isSafeInteger(change.priceOre) ||
    change.priceOre < 1 ||
    change.priceOre > MAX_SALE_PRICE_ORE
  ) {
    throw new NewProductError("Priset måste vara mellan 0,01 kr och 10 000 kr.");
  }
  const media = mediaAfter(good, change.imageUrl);
  const { description, content } = followsName(good, name);
  return {
    name,
    description,
    thumb: change.imageUrl ?? good.thumb ?? media[0] ?? "",
    content,
    media,
    multi_currency_enabled: good.multiCurrencyEnabled,
    slug: good.slug,
    unit_id: good.unitId,
    attributes: has(GOOD_PERMISSIONS.attributes)
      ? good.attributes.map((a) => ({
          id: a.id,
          label_name: a.label_name,
          label_value: [...a.label_value],
          immutable: a.immutable,
        }))
      : [],
    is_tax_exempt: good.isTaxExempt,
    tax_rate: good.taxRate,
    is_returnable: good.isReturnable,
    prices: good.prices.map((p) => ({
      id: p.id,
      currency_id: p.currencyId,
      price: p.id === sek.id ? oreToAwishPrice(change.priceOre) : p.price,
      original_price: has(GOOD_PERMISSIONS.originalPrice) ? p.originalPrice : 0,
      member_price: has(GOOD_PERMISSIONS.memberPrice) ? p.memberPrice : 0,
      cost_price: has(GOOD_PERMISSIONS.costPrice) ? p.costPrice : 0,
    })),
  };
}

// ---------------------------------------------------------------------------
// Planen
// ---------------------------------------------------------------------------

export interface EditGoodPlan {
  readonly goodId: number;
  readonly from: {
    readonly name: string;
    readonly priceOre: number | null;
    readonly image: string | null;
  };
  readonly to: {
    readonly name: string;
    readonly priceOre: number;
    /** Den nya bildens filnamn, eller null (bilden behålls). */
    readonly image: string | null;
  };
  readonly changes: {
    readonly name: boolean;
    readonly price: boolean;
    readonly image: boolean;
    /** Beskrivningen i Awish (som var namnet) följer med det nya namnet. */
    readonly description: boolean;
  };
  readonly binderlab: {
    readonly titleId: string | null;
    readonly titleName: string | null;
    /** Namn som läggs till som alias på titeln (nya namnet, och det gamla om det saknas). */
    readonly aliases: readonly string[];
    /** Titeln heter som varan: den byter namn med den. */
    readonly renameTitle: { readonly from: string; readonly to: string } | null;
  };
  readonly nothingToDo: boolean;
  readonly warnings: string[];
  readonly blocking: string | null;
  readonly lines: string[];
}

export function planEditGood(args: {
  good: AwishGoodFull;
  input: EditGoodInput;
  /** Andra varor i Awish (inte den här) som heter som det nya namnet. */
  otherSameName: readonly Pick<AwishGoodSummary, "id" | "name">[];
  /** Titeln varan är kopplad till nu (via det gamla namnet), eller null. */
  title: BinderlabTitleState | null;
  /** Titeln det nya namnet redan pekar på, eller null. */
  newNameTitle: BinderlabTitleState | null;
  /** En annan aktiv titel heter redan det nya namnet (titelnamnen är unika). */
  titleNameTaken: boolean;
  image: { fileName: string } | null;
  permissions: readonly string[];
}): EditGoodPlan {
  const { good, input, title, newNameTitle, image } = args;
  const warnings: string[] = [];
  let blocking: string | null = null;

  const sek = sekPrice(good);
  const fromPrice = sek ? awishPriceToOre(sek.price) : null;
  const nameChanged = input.name !== good.name;
  const keyChanged = goodNameKey(input.name) !== goodNameKey(good.name);
  const priceChanged = fromPrice !== input.salePrice;
  const imageChanged = image !== null;
  const descriptionFollows =
    nameChanged &&
    (good.description === good.name || good.content === `<p>${escapeHtml(good.name)}</p>`);

  if (
    !args.permissions.includes(GOOD_PERMISSIONS.update) &&
    !args.permissions.includes(GOOD_PERMISSIONS.create)
  ) {
    blocking = "Awish-kontot får inte ändra varor. Ge kontot behörigheten i Awish först.";
  }
  if (!sek) blocking ??= `${good.name} har inget pris i SEK i Awish. Lägg till det i Awish först.`;
  const atRisk = fieldsAtRisk(good, args.permissions);
  if (atRisk.length > 0) {
    blocking ??= `Awish-kontot får inte ändra varans ${listText(atRisk)}. Att spara härifrån skulle nollställa ${atRisk.length === 1 ? "det" : "dem"} i Awish. Ändra varan direkt i Awish.`;
  }
  if (keyChanged && args.otherSameName.length > 0) {
    const other = args.otherSameName[0]!;
    blocking ??= `Awish har redan en vara som heter ${other.name} (id ${other.id}). Välj ett annat namn.`;
  }
  if (keyChanged && newNameTitle && newNameTitle.titleId !== title?.titleId) {
    blocking ??= `Namnet ${input.name} hör redan till titeln ${newNameTitle.titleName} i Binderlab. Välj ett annat namn.`;
  }
  if (nameChanged && title?.archived) {
    blocking ??= `${title.titleName} är arkiverad i Binderlab. Ta fram den igen först.`;
  }
  if (mediaAfter(good, null).length === 0 && !imageChanged && (nameChanged || priceChanged)) {
    blocking ??= "Awish kräver en bild på varan. Välj en bild.";
  }

  // Binderlab: namnet blir ett alias på samma titel, och det gamla behålls (gamla order).
  const aliases: string[] = [];
  let renameTitle: EditGoodPlan["binderlab"]["renameTitle"] = null;
  if (title && nameChanged) {
    const keys = new Set<string>();
    const add = (n: string) => {
      const k = goodNameKey(n);
      if (!keys.has(k)) {
        keys.add(k);
        aliases.push(n);
      }
    };
    if (!title.hasAlias) add(good.name);
    const newHasAlias = newNameTitle?.hasAlias === true && newNameTitle.titleId === title.titleId;
    if (!newHasAlias && keyChanged) add(input.name);
    if (goodNameKey(title.titleName) === goodNameKey(good.name) && title.titleName !== input.name) {
      if (args.titleNameTaken) {
        warnings.push(
          `Titeln ${title.titleName} byter inte namn: en annan titel heter redan ${input.name}.`,
        );
      } else {
        renameTitle = { from: title.titleName, to: input.name };
      }
    }
  }

  if (title && title.purchasePriceOre !== null && input.salePrice <= title.purchasePriceOre) {
    warnings.push(
      `Priset är lika med eller lägre än inköpspriset (${formatKr(title.purchasePriceOre)}).`,
    );
  }

  const nothingToDo = !nameChanged && !priceChanged && !imageChanged;
  const lines: string[] = [];
  if (nothingToDo) {
    lines.push("Inget är ändrat.");
  } else {
    if (nameChanged) lines.push(`Namn: ${good.name} → ${input.name}`);
    if (priceChanged) {
      lines.push(
        `Pris: ${fromPrice === null ? "inget pris" : formatKr(fromPrice)} → ${formatKr(input.salePrice)}`,
      );
    }
    if (imageChanged) lines.push("Bild: byts");
    if (descriptionFollows) lines.push("Beskrivningen i Awish får också det nya namnet.");
    if (nameChanged) {
      if (!title) {
        lines.push("Binderlab: varan är inte kopplad till någon titel. Koppla den i listan.");
      } else {
        const added = aliases.filter((a) => goodNameKey(a) === goodNameKey(input.name));
        if (added.length > 0) {
          lines.push(
            `Binderlab: lägger till namnet ${input.name} på titeln ${title.titleName} så försäljningen kopplas rätt.`,
          );
        }
        if (keyChanged) {
          lines.push(`Binderlab: ${good.name} finns kvar, så gamla order hamnar rätt.`);
        }
        if (renameTitle) {
          lines.push(`Binderlab: titeln byter namn: ${renameTitle.from} → ${renameTitle.to}`);
        }
      }
    }
  }

  return {
    goodId: good.id,
    from: { name: good.name, priceOre: fromPrice, image: goodImage(good) },
    to: { name: input.name, priceOre: input.salePrice, image: image?.fileName ?? null },
    changes: {
      name: nameChanged,
      price: priceChanged,
      image: imageChanged,
      description: descriptionFollows,
    },
    binderlab: {
      titleId: title?.titleId ?? null,
      titleName: title?.titleName ?? null,
      aliases,
      renameTitle,
    },
    nothingToDo,
    warnings,
    blocking,
    lines,
  };
}

/** Vad Awish faktiskt sparade, enligt varan som lästes tillbaka. */
export interface EditGoodCheck {
  readonly found: boolean;
  readonly name: boolean;
  readonly price: boolean;
  readonly image: boolean;
  readonly all: boolean;
}

export function checkEditedGood(
  plan: Pick<EditGoodPlan, "to" | "changes">,
  after: AwishGoodFull | null,
  imageUrl: string | null,
): EditGoodCheck {
  if (!after) return { found: false, name: false, price: false, image: false, all: false };
  const sek = sekPrice(after);
  const name = !plan.changes.name || after.name === plan.to.name;
  const price =
    !plan.changes.price || (sek !== null && awishPriceToOre(sek.price) === plan.to.priceOre);
  const image = !plan.changes.image || (imageUrl !== null && goodImage(after) === imageUrl);
  return { found: true, name, price, image, all: name && price && image };
}

/** Det som inte sparades, som text ("priset och bilden"). */
export function notSavedText(check: EditGoodCheck): string {
  return listText(
    [
      check.name ? null : "namnet",
      check.price ? null : "priset",
      check.image ? null : "bilden",
    ].filter((x): x is string => x !== null),
  );
}
