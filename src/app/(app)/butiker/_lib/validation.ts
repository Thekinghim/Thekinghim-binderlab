/**
 * Indata till ändringarna på Butiker: scheman (zod) och regeln för nya avtal. Rena
 * funktioner, testas i validation.test.ts. Databasen kontrollerar samma sak en gång till
 * (överlappande avtal, minst provision eller hyra, stängda månader).
 */

import { z } from "zod";

import {
  DEFAULT_PROFIT_SHARE_BP,
  addDays,
  isIsoDate,
  maxDate,
  minDate,
  type CommissionBase,
  type IsoDate,
} from "@/domain";
import { parseLocation } from "@/analytics/visits/links";
import { parseAmountOre } from "@/import/amount";

const uuid = z.uuid({ message: "Ogiltigt id." });

const isoDate = (label: string) =>
  z
    .string()
    .trim()
    .refine((v) => isIsoDate(v), { message: `${label} måste vara ett datum (ÅÅÅÅ-MM-DD).` });

const optionalDate = (label: string) =>
  z
    .string()
    .trim()
    .optional()
    .nullable()
    .transform((v) => (v ? v : null))
    .refine((v) => v === null || isIsoDate(v), {
      message: `${label} måste vara ett datum (ÅÅÅÅ-MM-DD).`,
    });

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, { message: `${label} får vara högst ${max} tecken.` })
    .optional()
    .nullable()
    .transform((v) => (v ? v : null));

const name = z
  .string()
  .trim()
  .min(1, { message: "Ange butikens namn." })
  .max(200, { message: "Namnet får vara högst 200 tecken." });

const optionalEmail = z
  .string()
  .trim()
  .max(320, { message: "E-postadressen får vara högst 320 tecken." })
  .optional()
  .nullable()
  .transform((v) => (v ? v : null))
  .refine((v) => v === null || z.email().safeParse(v).success, {
    message: "Ogiltig e-postadress.",
  });

const phone = optionalText(50, "Telefonnumret").refine(
  (v) => v === null || /^[+0-9 ()-]{3,50}$/.test(v),
  { message: "Telefonnumret får bara innehålla siffror, mellanslag, +, - och parenteser." },
);

const checkbox = z
  .union([z.boolean(), z.string()])
  .optional()
  .nullable()
  .transform((v) => v === true || v === "on" || v === "true");

// ---------------------------------------------------------------------------
// Butik
// ---------------------------------------------------------------------------

/**
 * Kartlänk eller koordinater (valfritt): Google Maps-länk eller "55.70, 13.19". Utelämnad =
 * undefined (rörs inte), tom = null (tas bort).
 */
const location = z
  .string()
  .trim()
  .max(2000, { message: "Kartlänken är för lång." })
  .optional()
  .nullable()
  .transform((v, ctx) => {
    if (v === undefined) return undefined;
    const p = parseLocation(v);
    if (p === undefined) {
      ctx.addIssue({
        code: "custom",
        message:
          "Hittar ingen plats. Kopiera adressraden i Google Maps på datorn eller skriv 55.70, 13.19.",
      });
      return z.NEVER;
    }
    return p;
  });

export const storeSchema = z.object({
  name,
  location,
  address: optionalText(300, "Adressen"),
  city: optionalText(100, "Orten"),
  contactName: optionalText(200, "Kontaktpersonen"),
  email: optionalEmail,
  phone,
  isExample: checkbox,
});
export type StoreInput = z.infer<typeof storeSchema>;

export const updateStoreSchema = storeSchema.extend({ storeId: uuid });
export type UpdateStoreInput = z.infer<typeof updateStoreSchema>;

export const archiveStoreSchema = z.object({ storeId: uuid, archived: z.boolean() });

/** "Visa detaljer i rapporten" på eller av för en butik. */
export const reportDetailsSchema = z.object({ storeId: uuid, details: z.boolean() });

// ---------------------------------------------------------------------------
// Ersättning: provision i procent och hyra i kronor, som fälten visar dem
// ---------------------------------------------------------------------------

export type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** "12" → 1 200 bp, "12,5 %" → 1 250, "" → null. 0–100 % med högst två decimaler. */
export function parsePercentBp(raw: string | null | undefined): Parsed<number | null> {
  const s = (raw ?? "").replace(/[\s %]/g, "");
  if (s === "") return { ok: true, value: null };
  const m = /^(\d{1,3})(?:[.,](\d{1,2}))?$/.exec(s);
  if (!m) return { ok: false, message: "Provisionen anges i procent, t.ex. 12 eller 12,5." };
  const bp = Number(m[1]) * 100 + Number((m[2] ?? "").padEnd(2, "0"));
  if (bp > 10_000) return { ok: false, message: "Provisionen kan vara högst 100 %." };
  return { ok: true, value: bp };
}

/** "750" → 75 000 öre, "1 500,50 kr" → 150 050, "" → null. */
export function parseRentOre(raw: string | null | undefined): Parsed<number | null> {
  const s = (raw ?? "").trim();
  if (s === "") return { ok: true, value: null };
  const r = parseAmountOre(s);
  if (!r.ok) return { ok: false, message: `Hyran: ${r.message}` };
  if (r.ore < 0) return { ok: false, message: "Hyran kan inte vara negativ." };
  return { ok: true, value: r.ore };
}

/**
 * Ersättningsmodellen i formuläret: "split" = vinstdelning (standard för nya avtal, 50 %
 * av vinsten efter kostnader om ingen andel anges), "sales" = andel av försäljningen exkl.
 * moms. Utelämnad = "sales" (äldre anrop som bara skickar provision).
 */
export const AGREEMENT_MODELS = ["split", "sales"] as const;
export type AgreementModel = (typeof AGREEMENT_MODELS)[number];

const termsShape = {
  model: z
    .union([z.enum(AGREEMENT_MODELS), z.literal("")], {
      error: "Välj vinstdelning eller andel av försäljning.",
    })
    .optional()
    .nullable(),
  commission: z.string().optional().nullable(),
  rent: z.string().optional().nullable(),
  note: optionalText(500, "Anteckningen"),
  /** Vinstdelning: dra av VMB-moms före delningen. Utelämnad = oförändrad (nytt avtal: av). */
  vmbBeforeSplit: z.boolean().optional(),
};

function withTerms<
  T extends {
    model?: AgreementModel | "" | null;
    commission?: string | null;
    rent?: string | null;
  },
>(
  v: T,
  ctx: z.RefinementCtx,
):
  | (Omit<T, "commission" | "rent" | "model"> & {
      commissionBp: number | null;
      monthlyRentOre: number | null;
      commissionBase: CommissionBase;
    })
  | never {
  const split = v.model === "split";
  const c = parsePercentBp(v.commission);
  if (!c.ok) {
    ctx.addIssue({ code: "custom", message: c.message, path: ["commission"] });
    return z.NEVER;
  }
  const r = parseRentOre(v.rent);
  if (!r.ok) {
    ctx.addIssue({ code: "custom", message: r.message, path: ["rent"] });
    return z.NEVER;
  }
  if (split) {
    const { commission: _c, rent: _r, model: _m, ...rest } = v;
    void _c;
    void _r;
    void _m;
    return {
      ...rest,
      commissionBp: c.value ?? DEFAULT_PROFIT_SHARE_BP,
      monthlyRentOre: r.value,
      commissionBase: "profit_after_costs" as const,
    };
  }
  if (c.value === null && r.value === null) {
    ctx.addIssue({ code: "custom", message: "Ange andel, hyra eller båda." });
    return z.NEVER;
  }
  const { commission: _c, rent: _r, model: _m, ...rest } = v;
  void _c;
  void _r;
  void _m;
  return {
    ...rest,
    commissionBp: c.value,
    monthlyRentOre: r.value,
    commissionBase: "net_excl_vat" as const,
  };
}

export const newAgreementSchema = z
  .object({
    storeId: uuid,
    validFrom: isoDate("Giltig från"),
    validTo: optionalDate("Sista dagen"),
    ...termsShape,
    /** Bekräftat att ersättning för dagar före i dag räknas om. */
    confirmHistory: checkbox,
  })
  .refine((v) => v.validTo === null || v.validTo >= v.validFrom, {
    message: "Avtalet kan inte sluta före det börjar.",
    path: ["validTo"],
  })
  .transform(withTerms);
export type NewAgreementInput = z.infer<typeof newAgreementSchema>;

/** Sista dagen vid ändring: utelämnad = oförändrad, tom = tills vidare. */
const keptDate = (label: string) =>
  z
    .string()
    .trim()
    .nullable()
    .optional()
    .transform((v) => (v === undefined ? undefined : v ? v : null))
    .refine((v) => v === undefined || v === null || isIsoDate(v), {
      message: `${label} måste vara ett datum (ÅÅÅÅ-MM-DD).`,
    });

export const updateAgreementSchema = z
  .object({
    agreementId: uuid,
    validTo: keptDate("Sista dagen"),
    ...termsShape,
    confirmHistory: checkbox,
  })
  .transform(withTerms);
export type UpdateAgreementInput = z.infer<typeof updateAgreementSchema>;

// ---------------------------------------------------------------------------
// Rapportmottagare
// ---------------------------------------------------------------------------

export const recipientSchema = z.object({
  storeId: uuid,
  name: z
    .string()
    .trim()
    .min(1, { message: "Skriv mottagarens namn." })
    .max(200, { message: "Namnet får vara högst 200 tecken." }),
  email: z
    .string()
    .trim()
    .max(320, { message: "E-postadressen får vara högst 320 tecken." })
    .pipe(z.email({ message: "Ogiltig e-postadress." })),
});
export type RecipientInput = z.infer<typeof recipientSchema>;

export const updateRecipientSchema = recipientSchema
  .omit({ storeId: true })
  .extend({ recipientId: uuid, active: z.boolean() });
export type UpdateRecipientInput = z.infer<typeof updateRecipientSchema>;

export const recipientIdSchema = z.object({ recipientId: uuid });

/** Första felmeddelandet ur ett zod-fel. */
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Ogiltiga uppgifter.";
}

// ---------------------------------------------------------------------------
// Nytt avtal: ersätter det som gäller, utan överlapp
// ---------------------------------------------------------------------------

/** Avslutande punkt, utan att dubbla punkten efter en förkortning ("1 dec."). */
function stop(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

/** Ett befintligt avtal (giltighet), för planeringen. */
export interface AgreementSpan {
  readonly id: string;
  readonly validFrom: IsoDate;
  readonly validTo: IsoDate | null;
}

export type AgreementPlan =
  | {
      readonly ok: true;
      /** Avtalet som gäller dagen före det nya och ska avslutas dagen före, eller null. */
      readonly close: { readonly id: string; readonly validTo: IsoDate } | null;
    }
  | { readonly ok: false; readonly message: string; readonly conflictId: string | null };

/**
 * Ett nytt avtal från och med `validFrom` (till och med `validTo`, null = tills vidare).
 *
 * - Ett avtal som började före `validFrom` och fortfarande gäller den dagen avslutas
 *   dagen före (avtalshistoriken behålls: villkoren ändras aldrig bakåt).
 * - Ett avtal som börjar samma dag eller senare och skulle överlappa stoppar ändringen:
 *   det ska rättas eller avslutas i stället, så att inga avtal skrivs över i tysthet.
 *
 * `formatDay` skriver datum i meddelandet ("1 okt. 2026").
 */
export function planNewAgreement(
  existing: readonly AgreementSpan[],
  validFrom: IsoDate,
  validTo: IsoDate | null,
  formatDay: (d: IsoDate) => string = (d) => d,
): AgreementPlan {
  const end = validTo ?? "9999-12-31";
  let close: { id: string; validTo: IsoDate } | null = null;
  const sorted = [...existing].sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1));
  for (const a of sorted) {
    const aEnd = a.validTo ?? "9999-12-31";
    const overlaps = a.validFrom <= end && aEnd >= validFrom;
    if (!overlaps) continue;
    if (a.validFrom < validFrom) {
      // Gäller dagen före det nya: avslutas dagen före, om det inte också täcker hela
      // det nya avtalets period och fortsätter efter (då skulle historiken klyvas).
      if (validTo !== null && a.validTo !== null && a.validTo > validTo) {
        return {
          ok: false,
          conflictId: a.id,
          message: `Avtalet från ${formatDay(a.validFrom)} gäller till ${formatDay(a.validTo)}, efter det nya avtalets slut. Ändra det avtalet i stället.`,
        };
      }
      close = { id: a.id, validTo: addDays(validFrom, -1) };
      continue;
    }
    return {
      ok: false,
      conflictId: a.id,
      message:
        a.validFrom === validFrom
          ? `Det finns redan ett avtal från ${stop(formatDay(a.validFrom))} Ändra det i stället.`
          : `Avtalet från ${formatDay(a.validFrom)} skulle överlappa. Ange en sista dag före ${formatDay(a.validFrom)} eller ändra det avtalet.`,
    };
  }
  return { ok: true, close };
}

/**
 * Kontroll vid ändring av ett avtals sista dag: får inte sluta före start och inte
 * överlappa nästa avtal. Returnerar ett meddelande, eller null om det går.
 */
export function checkAgreementEnd(
  existing: readonly AgreementSpan[],
  agreementId: string,
  validTo: IsoDate | null,
  formatDay: (d: IsoDate) => string = (d) => d,
): string | null {
  const self = existing.find((a) => a.id === agreementId);
  if (!self) return "Avtalet finns inte.";
  if (validTo !== null && validTo < self.validFrom) {
    return "Avtalet kan inte sluta före det börjar.";
  }
  const end = validTo ?? "9999-12-31";
  const next = existing
    .filter((a) => a.id !== agreementId && a.validFrom > self.validFrom)
    .sort((a, b) => (a.validFrom < b.validFrom ? -1 : 1))[0];
  if (next && end >= next.validFrom) {
    return `Nästa avtal börjar ${stop(formatDay(next.validFrom))} Sista dagen måste vara senast ${stop(formatDay(addDays(next.validFrom, -1)))}`;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Ändringar bakåt i tiden
// ---------------------------------------------------------------------------

/** Dagar (från och med, till och med). */
export interface DayRange {
  readonly start: IsoDate;
  readonly end: IsoDate;
}

function union(ranges: readonly DayRange[]): DayRange | null {
  if (ranges.length === 0) return null;
  return ranges.reduce((a, b) => ({
    start: minDate(a.start, b.start),
    end: maxDate(a.end, b.end),
  }));
}

/**
 * Dagarna före i dag som ett nytt avtal räknar om (ersättningen för dem ändras), eller
 * null om avtalet börjar i dag eller senare.
 */
export function newAgreementImpact(
  validFrom: IsoDate,
  validTo: IsoDate | null,
  today: IsoDate,
): DayRange | null {
  const yesterday = addDays(today, -1);
  if (validFrom > yesterday) return null;
  return { start: validFrom, end: validTo !== null ? minDate(validTo, yesterday) : yesterday };
}

/**
 * Dagarna före i dag som en rättning av ett avtal räknar om: hela den passerade
 * giltigheten när provision eller hyra ändras, och dagarna mellan gammal och ny sista
 * dag när sista dagen flyttas. null om bara framtiden påverkas.
 */
export function agreementChangeImpact(
  before: {
    readonly validFrom: IsoDate;
    readonly validTo: IsoDate | null;
    readonly commissionBp: number | null;
    readonly monthlyRentOre: number | null;
    readonly commissionBase?: CommissionBase;
    readonly vmbBeforeSplit?: boolean;
  },
  after: {
    readonly validTo: IsoDate | null;
    readonly commissionBp: number | null;
    readonly monthlyRentOre: number | null;
    readonly commissionBase?: CommissionBase;
    readonly vmbBeforeSplit?: boolean;
  },
  today: IsoDate,
): DayRange | null {
  const yesterday = addDays(today, -1);
  const ranges: DayRange[] = [];
  const termsChanged =
    before.commissionBp !== after.commissionBp ||
    before.monthlyRentOre !== after.monthlyRentOre ||
    (before.commissionBase ?? "net_excl_vat") !== (after.commissionBase ?? "net_excl_vat") ||
    (after.commissionBase === "profit_after_costs" &&
      (before.vmbBeforeSplit ?? false) !==
        (after.vmbBeforeSplit ?? before.vmbBeforeSplit ?? false));
  if (termsChanged) {
    let end = yesterday;
    if (before.validTo !== null) end = minDate(end, before.validTo);
    if (after.validTo !== null) end = minDate(end, after.validTo);
    if (before.validFrom <= end) ranges.push({ start: before.validFrom, end });
  }
  if (before.validTo !== after.validTo) {
    // Minst en av dem är satt (annars vore de lika).
    const a = before.validTo;
    const b = after.validTo;
    const first = a === null ? b! : b === null ? a : minDate(a, b);
    const last = a === null || b === null ? yesterday : minDate(maxDate(a, b), yesterday);
    const start = addDays(first, 1);
    if (start <= last) ranges.push({ start, end: last });
  }
  return union(ranges);
}

// ---------------------------------------------------------------------------
// Kontraktets villkor (Skapa kontrakt och Ny butik)
// ---------------------------------------------------------------------------

/** Högst så många tecken i "Särskilda villkor" (samma gräns som i databasen). */
export const SPECIAL_TERMS_MAX = 2000;

/**
 * Villkoren i Skapa kontrakt och Ny butik, som fälten visar dem: andel i procent, av vad,
 * fast hyra i kronor, vid förlust, VMB före delning och särskilda villkor. Ger samma
 * värden som store_agreements och PDF:en använder (ContractTerms).
 *
 * - Andel eller hyra måste finnas (som i databasen).
 * - Vid förlust och VMB gäller bara vinstdelning; för omsättning sparas förval (0, av).
 */
export const contractTermsSchema = z
  .object({
    share: z.string().optional().nullable(),
    base: z
      .enum(["profit_after_costs", "net_excl_vat"], { error: "Välj vinst eller omsättning." })
      .optional()
      .nullable(),
    rent: z.string().optional().nullable(),
    loss: z
      .enum(["zero", "proportional"], { error: "Välj vad som gäller vid förlust." })
      .optional()
      .nullable(),
    vmbBeforeSplit: z.boolean().optional().nullable(),
    specialTerms: z
      .string()
      .trim()
      .max(SPECIAL_TERMS_MAX, {
        message: `Särskilda villkor får vara högst ${SPECIAL_TERMS_MAX.toLocaleString("sv-SE")} tecken.`,
      })
      .optional()
      .nullable()
      .transform((v) => (v ? v : null)),
  })
  .transform((v, ctx) => {
    const c = parsePercentBp(v.share);
    if (!c.ok) {
      ctx.addIssue({
        code: "custom",
        message: c.message.replace("Provisionen", "Andelen"),
        path: ["share"],
      });
      return z.NEVER;
    }
    const r = parseRentOre(v.rent);
    if (!r.ok) {
      ctx.addIssue({ code: "custom", message: r.message, path: ["rent"] });
      return z.NEVER;
    }
    const shareBp = c.value === 0 ? null : c.value;
    const monthlyRentOre = r.value === 0 ? null : r.value;
    if (shareBp === null && monthlyRentOre === null) {
      ctx.addIssue({ code: "custom", message: "Ange andel, hyra eller båda.", path: ["share"] });
      return z.NEVER;
    }
    // Bara hyra: ingen andel att räkna, sparas som förut (omsättning, ingen procent).
    const base: CommissionBase =
      shareBp === null ? "net_excl_vat" : (v.base ?? "profit_after_costs");
    const split = base === "profit_after_costs" && shareBp !== null;
    return {
      shareBp,
      base,
      lossTreatment: split ? (v.loss ?? "zero") : ("zero" as const),
      vmbBeforeSplit: split ? v.vmbBeforeSplit === true : false,
      monthlyRentOre,
      specialTerms: v.specialTerms,
    };
  });
export type ContractTermsInput = z.infer<typeof contractTermsSchema>;
