/**
 * "Ny produkt": ren logik utan nätverk och databas. Indata från formuläret, kodning av
 * varan som Awishs panel skickar den (CreateGood/GoodInput) och planerna som visas före
 * "Skicka till Awish" (ny vara, koppling i Binderlab, byte av vara i ett fack).
 *
 * Reglerna:
 *  - Pengar i Binderlab är öre (heltal). Awish tar priset som tal i kronor med två decimaler
 *    (panelens n-input-number, precision 2) och svarar med decimalsträngar ("79.00").
 *  - En vara som redan finns i Awish (samma namn) skapas inte igen och dess pris ändras
 *    aldrig här; den kopplas bara i Binderlab.
 *  - Ett fack som har pack får aldrig byta vara eller få lägre antal utan uttrycklig
 *    bekräftelse ("Facket har 5 Mystery Pack – byt ändå?").
 */

import { createHash } from "node:crypto";

import { z } from "zod";

/** Högsta försäljningspris (öre): 10 000 kr per pack. */
export const MAX_SALE_PRICE_ORE = 1_000_000;
/** Högsta inköpspris (öre): 10 000 kr per pack. */
export const MAX_PURCHASE_PRICE_ORE = 1_000_000;
/** Längsta namn på en vara (Binderlabs titlar tillåter 200). */
export const MAX_GOOD_NAME = 100;
/** Största bild. Panelen tillåter 5 MB; Vercel tar emot högst 4,5 MB per anrop. */
export const GOOD_IMAGE_MAX_BYTES = 4 * 1024 * 1024;
/** Högsta antal i ett fack när Awish inte uppger kapaciteten. */
export const MAX_SLOT_COUNT = 999;
/** Fack som fungerar (panelen låter bara sådana ändras). */
export const FLOOR_STATUS_NORMAL = "ERR_NORMAL";

export const GOOD_IMAGE_TYPES = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/webp": "webp",
} as const;
export type GoodImageType = keyof typeof GOOD_IMAGE_TYPES;

/** Fel som visas för användaren som det är (svenska, utan tekniska detaljer). */
export class NewProductError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NewProductError";
  }
}

const noControl = /^[^\p{Cc}]*$/u;

/** Namnet som det skickas till Awish och sparas i Binderlab: trimmat, ett mellanslag. */
export function cleanGoodName(raw: string): string {
  return raw.normalize("NFC").replace(/\s+/g, " ").trim();
}

/** Samma jämförelsenyckel som title_aliases.alias_normalized (NFKC, gemener, ett mellanslag). */
export function goodNameKey(name: string): string {
  return name.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

/** Kronor (som användaren skriver, "79", "79,50", "79.5") → öre, eller null om ogiltigt. */
export function parseKronor(raw: unknown): number | null {
  if (typeof raw === "number") {
    if (!Number.isFinite(raw)) return null;
    const ore = Math.round(raw * 100);
    return Math.abs(ore - raw * 100) < 1e-6 ? ore : null;
  }
  if (typeof raw !== "string") return null;
  const s = raw.replace(/\s|kr/gi, "").replace(",", ".");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

/** Öre → Awishs pris (tal i kronor, två decimaler). 7950 → 79.5. */
export function oreToAwishPrice(ore: number): number {
  if (!Number.isSafeInteger(ore) || ore < 0) throw new RangeError("Ogiltigt belopp.");
  return Number((ore / 100).toFixed(2));
}

/** Awishs pris ("79.00", 79, null) → öre, eller null. */
export function awishPriceToOre(price: unknown): number | null {
  if (price === null || price === undefined || price === "") return null;
  const n = typeof price === "number" ? price : Number(String(price).trim());
  if (!Number.isFinite(n) || n < 0) return null;
  return Math.round(n * 100);
}

/** "79 kr", "79,50 kr". */
export function formatKr(ore: number): string {
  const kr = Math.trunc(ore / 100);
  const rest = Math.abs(ore % 100);
  const whole = kr.toLocaleString("sv-SE").replace(/ /g, " ");
  return rest === 0 ? `${whole} kr` : `${whole},${String(rest).padStart(2, "0")} kr`;
}

const priceField = (label: string, min: number, max: number) =>
  z.union([z.string(), z.number()]).transform((raw, ctx) => {
    const ore = parseKronor(raw);
    if (ore === null) {
      ctx.addIssue({ code: "custom", message: `Skriv ${label} i kronor, t.ex. 79 eller 79,50.` });
      return z.NEVER;
    }
    if (ore < min) {
      ctx.addIssue({
        code: "custom",
        message:
          min > 0
            ? `${cap(label)} måste vara mer än 0 kr.`
            : `${cap(label)} kan inte vara negativt.`,
      });
      return z.NEVER;
    }
    if (ore > max) {
      ctx.addIssue({ code: "custom", message: `${cap(label)} får vara högst ${formatKr(max)}.` });
      return z.NEVER;
    }
    return ore;
  });

function cap(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** Namnet på en vara: trimmat, 1–100 tecken, inga radbrytningar. */
const goodNameSchema = z
  .string({ error: "Skriv ett namn." })
  .transform(cleanGoodName)
  .pipe(
    z
      .string()
      .min(1, "Skriv ett namn.")
      .max(MAX_GOOD_NAME, `Namnet får vara högst ${MAX_GOOD_NAME} tecken.`)
      .regex(noControl, "Namnet får inte innehålla radbrytningar."),
  );

/** Formuläret "Ny produkt". Priserna skrivs i kronor och blir öre. */
export const newProductInputSchema = z.object({
  name: goodNameSchema,
  salePrice: priceField("försäljningspriset", 1, MAX_SALE_PRICE_ORE),
  purchasePrice: priceField("inköpspriset", 0, MAX_PURCHASE_PRICE_ORE),
  ownProduct: z.boolean().default(false),
});
export type NewProductInput = z.output<typeof newProductInputSchema>;

/** Byte i ett fack: automat (Binderlab-id), fack (Awish), vara (Awish) och valfritt antal. */
export const slotChangeInputSchema = z.object({
  machineId: z.uuid("Välj automat."),
  productId: z.coerce.number().int().positive("Välj fack."),
  goodId: z.coerce.number().int().positive("Välj vara."),
  count: z
    .union([z.literal(""), z.null(), z.undefined(), z.coerce.number()])
    .transform((v, ctx) => {
      if (v === "" || v === null || v === undefined) return null;
      if (!Number.isInteger(v) || v < 0) {
        ctx.addIssue({ code: "custom", message: "Antalet måste vara ett heltal, 0 eller mer." });
        return z.NEVER;
      }
      if (v > MAX_SLOT_COUNT) {
        ctx.addIssue({ code: "custom", message: `Antalet får vara högst ${MAX_SLOT_COUNT}.` });
        return z.NEVER;
      }
      return v;
    }),
});
export type SlotChangeInput = z.output<typeof slotChangeInputSchema>;

/** Bildens typ ur innehållet (magiska bytes), inte ur webbläsarens uppgift. */
export function sniffGoodImage(bytes: Uint8Array): GoodImageType | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (starts([0x52, 0x49, 0x46, 0x46]) && starts([0x57, 0x45, 0x42, 0x50], 8)) return "image/webp";
  return null;
}

export interface GoodImage {
  readonly bytes: Uint8Array;
  readonly type: GoodImageType;
  /** Filnamn till Awish: "<slug>.<ext>" (aldrig användarens eget filnamn). */
  readonly fileName: string;
  readonly sha256: string;
}

/** Kontrollerar en uppladdad bild (typ ur innehållet, storlek). Kastar NewProductError. */
export function checkGoodImage(bytes: Uint8Array, name: string): GoodImage {
  if (bytes.byteLength === 0) throw new NewProductError("Bilden är tom.");
  if (bytes.byteLength > GOOD_IMAGE_MAX_BYTES) {
    throw new NewProductError("Bilden är för stor (högst 4 MB).");
  }
  const type = sniffGoodImage(bytes);
  if (!type) throw new NewProductError("Bilden måste vara jpg, png eller webp.");
  const slug =
    goodNameKey(name)
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "produkt";
  return {
    bytes,
    type,
    fileName: `${slug}.${GOOD_IMAGE_TYPES[type]}`,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  };
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Ett pris i GoodInput.prices, i panelens fältordning. */
export interface GoodPriceInput {
  id: number;
  currency_id: number;
  price: number;
  original_price: number;
  member_price: number;
  cost_price: number;
}

/** GoodInput som panelens sida "Ny vara" skickar (GoodsCreate, fältordningen bevarad). */
export interface GoodInput {
  name: string;
  description: string;
  thumb: string;
  content: string;
  media: string[];
  multi_currency_enabled: boolean;
  slug: string;
  unit_id: number | null;
  attributes: Array<{ id: number; label_name: string; label_value: string[]; immutable: boolean }>;
  is_tax_exempt: boolean;
  tax_rate: number;
  is_returnable: boolean;
  prices: GoodPriceInput[];
}

/**
 * Kodar en ny vara som panelen gör. Panelen kräver beskrivning och innehåll, så båda får
 * namnet. Pris i en valuta (butikens SEK), inget ordinarie pris, inget medlemspris och inget
 * inköpspris i Awish (inköpspriset finns bara i Binderlab). Momsfri som panelens standard,
 * ingen enhet, inga attribut (panelen skickar [] utan behörigheten för attribut), slug tom
 * (Awish skapar den).
 */
export function encodeGoodInput(args: {
  name: string;
  salePriceOre: number;
  currencyId: number;
  imageUrl: string | null;
}): GoodInput {
  const name = cleanGoodName(args.name);
  if (name === "") throw new NewProductError("Skriv ett namn.");
  if (!Number.isSafeInteger(args.salePriceOre) || args.salePriceOre <= 0) {
    throw new NewProductError("Försäljningspriset måste vara mer än 0 kr.");
  }
  if (args.salePriceOre > MAX_SALE_PRICE_ORE) {
    throw new NewProductError(`Försäljningspriset får vara högst ${formatKr(MAX_SALE_PRICE_ORE)}.`);
  }
  if (!Number.isInteger(args.currencyId) || args.currencyId <= 0) {
    throw new NewProductError("Awish har ingen valuta för SEK.");
  }
  const media = args.imageUrl ? [args.imageUrl] : [];
  return {
    name,
    description: name,
    thumb: media[0] ?? "",
    content: `<p>${escapeHtml(name)}</p>`,
    media,
    multi_currency_enabled: false,
    slug: "",
    unit_id: null,
    attributes: [],
    is_tax_exempt: true,
    tax_rate: 0,
    is_returnable: false,
    prices: [
      {
        id: 0,
        currency_id: args.currencyId,
        price: oreToAwishPrice(args.salePriceOre),
        original_price: 0,
        member_price: 0,
        cost_price: 0,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Planer
// ---------------------------------------------------------------------------

/** En vara i Awish, som Binderlab ser den. */
export interface AwishGoodSummary {
  readonly id: number;
  readonly name: string;
  /** SEK-priset i öre (eller första priset), null om varan saknar pris. */
  readonly priceOre: number | null;
  readonly thumb: string | null;
}

/** Titeln i Binderlab för namnet (via alias, annars samma namn), eller null. */
export interface BinderlabTitleState {
  readonly titleId: string;
  readonly titleName: string;
  /** Finns ett alias med exakt det här namnet (normaliserat)? */
  readonly hasAlias: boolean;
  readonly archived: boolean;
  readonly ownProduct: boolean;
  /** Senaste inköpspriset (öre), eller null. */
  readonly purchasePriceOre: number | null;
}

export interface NewProductPlan {
  readonly name: string;
  readonly awish:
    | { readonly action: "create"; readonly priceOre: number; readonly image: string | null }
    | {
        readonly action: "exists";
        readonly goodId: number;
        readonly priceOre: number | null;
      };
  readonly title:
    | { readonly action: "create" }
    | { readonly action: "existing"; readonly titleId: string; readonly titleName: string };
  readonly alias: "create" | "exists";
  readonly purchasePrice:
    | { readonly action: "set"; readonly ore: number; readonly validFrom: string }
    | { readonly action: "keep"; readonly currentOre: number };
  readonly ownProduct: { readonly action: "set" | "keep"; readonly value: boolean };
  /** Allt finns redan: inget skickas och inget sparas. */
  readonly nothingToDo: boolean;
  /** Upplysningar som inte stoppar (visas i förhandsvisningen). */
  readonly warnings: string[];
  /** Hinder: knappen "Skicka till Awish" visas inte. */
  readonly blocking: string | null;
  /** Rader att visa: exakt vad som ändras. */
  readonly lines: string[];
}

export function planNewProduct(args: {
  input: NewProductInput;
  /** Varor i Awish med samma namn (normaliserat). */
  sameNameGoods: readonly AwishGoodSummary[];
  title: BinderlabTitleState | null;
  image: { fileName: string; bytes: number } | null;
  today: string;
}): NewProductPlan {
  const { input, title, image, today } = args;
  const warnings: string[] = [];
  let blocking: string | null = null;

  if (args.sameNameGoods.length > 1) {
    blocking = `Awish har ${args.sameNameGoods.length} varor som heter ${input.name}. Byt namn på en av dem i Awish först.`;
  }
  const existing = args.sameNameGoods[0] ?? null;
  const awish: NewProductPlan["awish"] = existing
    ? { action: "exists", goodId: existing.id, priceOre: existing.priceOre }
    : { action: "create", priceOre: input.salePrice, image: image?.fileName ?? null };
  if (existing && existing.priceOre !== input.salePrice) {
    warnings.push(
      `Awish har redan ${existing.name} för ${
        existing.priceOre === null ? "okänt pris" : formatKr(existing.priceOre)
      }. Priset ändras inte här.`,
    );
  }
  if (existing && image) warnings.push("Varan finns redan i Awish. Bilden skickas inte.");

  if (title?.archived) {
    blocking ??= `${title.titleName} är arkiverad i Binderlab. Ta fram den igen först.`;
  }
  // Awish egen panel sparar ingen ny vara utan bild, så vi skickar aldrig en utan.
  if (!existing && !image) blocking ??= "Välj en bild. Awish kräver bild på nya varor.";

  const purchasePrice: NewProductPlan["purchasePrice"] =
    title && title.purchasePriceOre !== null
      ? { action: "keep", currentOre: title.purchasePriceOre }
      : { action: "set", ore: input.purchasePrice, validFrom: today };
  if (purchasePrice.action === "keep" && purchasePrice.currentOre !== input.purchasePrice) {
    warnings.push(
      `Binderlab har redan inköpspris ${formatKr(purchasePrice.currentOre)} för ${title!.titleName}. Ändra det under Inköpspriser.`,
    );
  }
  const effectivePurchase =
    purchasePrice.action === "set" ? purchasePrice.ore : purchasePrice.currentOre;
  const effectiveSale = existing ? existing.priceOre : input.salePrice;
  if (effectiveSale !== null && effectivePurchase >= effectiveSale) {
    warnings.push("Inköpspriset är lika högt som eller högre än försäljningspriset.");
  }

  // Egen produkt slås bara på härifrån, aldrig av: en befintlig titel som är egen produkt
  // behålls som den är (som inköpspriset), så att reglaget av misstag inte ändrar den.
  const ownProduct: NewProductPlan["ownProduct"] =
    title && title.ownProduct
      ? { action: "keep", value: true }
      : input.ownProduct
        ? { action: "set", value: true }
        : { action: "keep", value: false };
  if (title?.ownProduct && !input.ownProduct) {
    warnings.push(
      `${title.titleName} är Egen produkt i Binderlab. Det ändras inte här (ändra under Inköpspriser).`,
    );
  }
  const alias: NewProductPlan["alias"] = title?.hasAlias ? "exists" : "create";
  const titlePlan: NewProductPlan["title"] = title
    ? { action: "existing", titleId: title.titleId, titleName: title.titleName }
    : { action: "create" };

  const nothingToDo =
    awish.action === "exists" &&
    titlePlan.action === "existing" &&
    alias === "exists" &&
    purchasePrice.action === "keep" &&
    ownProduct.action === "keep";

  const lines: string[] = [];
  if (awish.action === "create") {
    lines.push(
      `Awish: ny vara ${input.name}, ${formatKr(awish.priceOre)}${image ? `, bild ${image.fileName}` : ""}.`,
    );
  } else {
    lines.push(`Awish: ${input.name} finns redan (id ${awish.goodId}). Ingen ändring i Awish.`);
  }
  if (titlePlan.action === "create") {
    lines.push(`Binderlab: ny titel ${input.name}.`);
  } else if (alias === "create") {
    lines.push(`Binderlab: kopplar ${input.name} till titeln ${titlePlan.titleName}.`);
  } else {
    lines.push(`Binderlab: titeln ${titlePlan.titleName} finns redan.`);
  }
  if (purchasePrice.action === "set") {
    lines.push(`Inköpspris ${formatKr(purchasePrice.ore)} från ${purchasePrice.validFrom}.`);
  }
  if (ownProduct.action === "set") {
    lines.push("Egen produkt: ja.");
  }
  if (nothingToDo) lines.push("Allt finns redan. Inget att skicka.");

  return {
    name: input.name,
    awish,
    title: titlePlan,
    alias,
    purchasePrice,
    ownProduct,
    nothingToDo,
    warnings,
    blocking,
    lines,
  };
}

/** Ett fack i en automat (ur Awishs Products). */
export interface AwishSlot {
  readonly id: number;
  readonly channelName: string | null;
  readonly goodId: number | null;
  readonly goodName: string | null;
  readonly status: boolean;
  readonly floorStatus: string | null;
  readonly currentInventory: number;
  /** Fackets kapacitet (inventory, annars channel.total), eller null. */
  readonly capacity: number | null;
}

export interface SlotChangePlan {
  readonly productId: number;
  readonly slotName: string;
  readonly from: {
    readonly goodId: number | null;
    readonly goodName: string | null;
    readonly count: number;
  };
  readonly to: { readonly goodId: number; readonly goodName: string; readonly count: number };
  /** Status behålls som den är (panelens redigering skickar fackets status oförändrad). */
  readonly status: boolean;
  /** Fråga som måste bekräftas uttryckligen, eller null. */
  readonly confirm: string | null;
  readonly unchanged: boolean;
  readonly warnings: string[];
  readonly blocking: string | null;
  readonly lines: string[];
}

export function slotLabel(slot: Pick<AwishSlot, "id" | "channelName">): string {
  return slot.channelName ? `Fack ${slot.channelName}` : `Fack ${slot.id}`;
}

export function planSlotChange(args: {
  slot: AwishSlot;
  good: Pick<AwishGoodSummary, "id" | "name">;
  count: number | null;
}): SlotChangePlan {
  const { slot, good } = args;
  const sameGood = slot.goodId === good.id;
  const current = Math.max(0, Math.floor(slot.currentInventory));
  const count = args.count ?? (sameGood ? current : 0);
  const name = slotLabel(slot);
  const warnings: string[] = [];
  let blocking: string | null = null;

  if (slot.floorStatus && slot.floorStatus !== FLOOR_STATUS_NORMAL) {
    blocking = `${name} har ett fel i Awish (${slot.floorStatus}). Rätta det i Awish först.`;
  }
  const max = slot.capacity ?? MAX_SLOT_COUNT;
  if (count > max) {
    blocking ??= `${name} rymmer ${max}. Välj högst ${max}.`;
  }
  if (!slot.status) warnings.push(`${name} är avstängt i Awish och säljer inte.`);

  let confirm: string | null = null;
  if (!sameGood && current > 0) {
    confirm = `${name} har ${current} ${slot.goodName ?? "pack"} – byt ändå?`;
  } else if (sameGood && count < current) {
    confirm = `${name} har ${current} ${slot.goodName ?? good.name}. Sänk till ${count}?`;
  }

  const unchanged = sameGood && count === current;
  const fromText =
    slot.goodId === null
      ? current > 0
        ? `utan vara ${current} st`
        : "tomt"
      : `${slot.goodName ?? `vara ${slot.goodId}`} ${current} st`;
  const lines = unchanged
    ? [`${name}: ${fromText}. Inget att ändra.`]
    : [`${name}: ${fromText} → ${good.name} ${count} st.`];

  return {
    productId: slot.id,
    slotName: name,
    from: { goodId: slot.goodId, goodName: slot.goodName, count: current },
    to: { goodId: good.id, goodName: good.name, count },
    status: slot.status,
    confirm,
    unchanged,
    warnings,
    blocking,
    lines,
  };
}

/**
 * Fingeravtryck av en plan: förhandsvisningen ger det, och "Skicka till Awish" skickar
 * tillbaka det. Räknar servern fram en annan plan (något ändrades i Awish eller Binderlab
 * under tiden, eller en annan bild) skickas ingenting.
 */
export function planFingerprint(plan: unknown, extra: Record<string, unknown> = {}): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object") {
      return Object.fromEntries(
        Object.keys(v as Record<string, unknown>)
          .sort()
          .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return createHash("sha256")
    .update(JSON.stringify(stable({ plan, extra })))
    .digest("hex")
    .slice(0, 32);
}
