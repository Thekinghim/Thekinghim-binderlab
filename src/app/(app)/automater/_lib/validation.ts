/**
 * Indata till ändringarna på Automater: scheman (zod) och regler för flytt och
 * avveckling. Rena funktioner, testas i validation.test.ts. Databasen kontrollerar
 * samma sak en gång till (format på kod, överlappande placeringar, stängda månader).
 */

import { z } from "zod";

import { addDays, isIsoDate, type IsoDate } from "@/domain";

/** Samma regel som databasens check på machines.code. */
export const MACHINE_CODE = /^[A-Z0-9][A-Z0-9-]{0,31}$/;

/** Kod i kanonisk form: versaler, utan mellanslag. "bl 004" → "BL-004" görs inte; bara trim och versaler. */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

const uuid = z.uuid({ message: "Ogiltigt id." });

const isoDate = (label: string) =>
  z
    .string()
    .trim()
    .refine((v) => isIsoDate(v), { message: `${label} måste vara ett datum (ÅÅÅÅ-MM-DD).` });

const optionalText = (max: number, label: string) =>
  z
    .string()
    .trim()
    .max(max, { message: `${label} får vara högst ${max} tecken.` })
    .optional()
    .transform((v) => (v ? v : null));

const name = z
  .string()
  .trim()
  .min(1, { message: "Ange ett namn." })
  .max(200, { message: "Namnet får vara högst 200 tecken." });

export const createMachineSchema = z.object({
  code: z
    .string()
    .transform(normalizeCode)
    .refine((v) => v.length > 0, { message: "Ange en kod, t.ex. BL-004." })
    .refine((v) => v.length === 0 || MACHINE_CODE.test(v), {
      message: "Koden får bara innehålla A–Z, 0–9 och bindestreck, högst 32 tecken.",
    }),
  name,
  serial: optionalText(100, "Serienumret"),
  activeFrom: isoDate("Driftstart"),
  storeId: z
    .string()
    .optional()
    .transform((v) => (v ? v : null))
    .pipe(uuid.nullable()),
});
export type CreateMachineInput = z.infer<typeof createMachineSchema>;

export const updateMachineSchema = z.object({
  machineId: uuid,
  name,
  serial: optionalText(100, "Serienumret"),
  activeFrom: isoDate("Driftstart"),
});
export type UpdateMachineInput = z.infer<typeof updateMachineSchema>;

export const moveMachineSchema = z.object({
  machineId: uuid,
  storeId: uuid,
  from: isoDate("Datumet"),
  note: optionalText(500, "Anteckningen"),
});
export type MoveMachineInput = z.infer<typeof moveMachineSchema>;

export const decommissionSchema = z.object({
  machineId: uuid,
  activeTo: isoDate("Sista dagen"),
});
export type DecommissionInput = z.infer<typeof decommissionSchema>;

export const reactivateSchema = z.object({ machineId: uuid });

/**
 * Två meningar där den första kan sluta på ett förkortat datum ("1 nov."): ingen
 * dubbel punkt.
 */
export function sentences(first: string, second: string): string {
  const a = first.trim();
  return `${/[.!?]$/.test(a) ? a : `${a}.`} ${second}`;
}

/** Första felmeddelandet ur en zod-validering. */
export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Kontrollera uppgifterna.";
}

// ---------------------------------------------------------------------------
// Flytt
// ---------------------------------------------------------------------------

export interface PlacementSpan {
  readonly id: string;
  readonly storeId: string;
  readonly from: IsoDate;
  readonly to: IsoDate | null;
}

export type MovePlan =
  | {
      readonly ok: true;
      /** Placeringen som avslutas dagen före flytten, eller null. */
      readonly close: { readonly id: string; readonly to: IsoDate } | null;
      /** Den nya placeringen. */
      readonly insert: {
        readonly storeId: string;
        readonly from: IsoDate;
        readonly to: IsoDate | null;
      };
    }
  | { readonly ok: false; readonly error: string };

/**
 * Planerar en flytt till `storeId` från och med `from`. Den placering som gäller
 * `from` avslutas dagen före; den nya behåller den gamlas slutdag (normalt ingen).
 * Nekas om automaten redan står i butiken, om en senare placering redan finns, eller om
 * flytten ligger utanför automatens driftperiod.
 */
export function planMove(args: {
  placements: readonly PlacementSpan[];
  storeId: string;
  from: IsoDate;
  activeFrom: IsoDate | null;
  activeTo: IsoDate | null;
  /** Sätts in i felmeddelanden, t.ex. "BL-001". */
  code: string;
  /** Formaterar datum för felmeddelanden. */
  day: (d: IsoDate) => string;
  storeName: (id: string) => string;
}): MovePlan {
  const { placements, storeId, from, activeFrom, activeTo, code, day, storeName } = args;
  if (activeTo !== null && from > activeTo) {
    return {
      ok: false,
      error: sentences(
        `${code} är avvecklad från ${day(addDays(activeTo, 1))}`,
        "Återaktivera den först.",
      ),
    };
  }
  if (activeFrom !== null && from < activeFrom) {
    return {
      ok: false,
      error: sentences(
        `${code} startar ${day(activeFrom)}`,
        "Flytten kan inte ligga före driftstarten.",
      ),
    };
  }
  const later = placements
    .filter((p) => p.from >= from)
    .sort((a, b) => (a.from < b.from ? -1 : 1))[0];
  if (later) {
    return {
      ok: false,
      error:
        later.from === from
          ? `${code} har redan en placering från ${day(from)} (${storeName(later.storeId)}).`
          : sentences(
              `${code} har en placering från ${day(later.from)}`,
              "Välj ett datum efter den.",
            ),
    };
  }
  const covering = placements.find((p) => p.from < from && (p.to === null || p.to >= from));
  if (covering) {
    if (covering.storeId === storeId) {
      return { ok: false, error: `${code} står redan i ${storeName(storeId)}.` };
    }
    return {
      ok: true,
      close: { id: covering.id, to: addDays(from, -1) },
      insert: { storeId, from, to: covering.to },
    };
  }
  return { ok: true, close: null, insert: { storeId, from, to: activeTo } };
}

// ---------------------------------------------------------------------------
// Avveckling
// ---------------------------------------------------------------------------

export type DecommissionPlan =
  | {
      readonly ok: true;
      /** Placeringar som avslutas på sista dagen. */
      readonly close: ReadonlyArray<{ readonly id: string; readonly to: IsoDate }>;
    }
  | { readonly ok: false; readonly error: string };

/**
 * Avveckling: active_to = sista dagen, placeringar som pågår efter den avslutas samma
 * dag. Historiken (order, placeringar, lager) behålls. Nekas före driftstarten, före
 * sista ordern och om en placering börjar efter sista dagen.
 */
export function planDecommission(args: {
  placements: readonly PlacementSpan[];
  activeTo: IsoDate;
  activeFrom: IsoDate | null;
  lastOrderDate: IsoDate | null;
  code: string;
  day: (d: IsoDate) => string;
}): DecommissionPlan {
  const { placements, activeTo, activeFrom, lastOrderDate, code, day } = args;
  if (activeFrom !== null && activeTo < activeFrom) {
    return {
      ok: false,
      error: sentences(`${code} startade ${day(activeFrom)}`, "Sista dagen kan inte ligga före."),
    };
  }
  if (lastOrderDate !== null && activeTo < lastOrderDate) {
    return {
      ok: false,
      error: sentences(
        `${code} har order till ${day(lastOrderDate)}`,
        "Sista dagen kan inte ligga före den.",
      ),
    };
  }
  const after = placements.find((p) => p.from > activeTo);
  if (after) {
    return {
      ok: false,
      error: sentences(
        `${code} har en placering från ${day(after.from)}`,
        "Välj en sista dag efter den.",
      ),
    };
  }
  return {
    ok: true,
    close: placements
      .filter((p) => p.to === null || p.to > activeTo)
      .map((p) => ({ id: p.id, to: activeTo })),
  };
}

// ---------------------------------------------------------------------------
// Driftstart och återaktivering
// ---------------------------------------------------------------------------

/**
 * Första placeringens startdag om driftstarten skulle hamna efter den (en flytt får inte
 * ligga före driftstarten, så en placering får inte heller göra det), annars null.
 */
export function placementBeforeStart(
  placements: readonly PlacementSpan[],
  activeFrom: IsoDate,
): IsoDate | null {
  const first = placements.reduce<IsoDate | null>(
    (min, p) => (min === null || p.from < min ? p.from : min),
    null,
  );
  return first !== null && first < activeFrom ? first : null;
}

/**
 * Återaktivering: den senaste placeringen öppnas igen om den slutade på automatens sista
 * dag (avvecklingen avslutade den), så att automaten står kvar i butiken och hyra och
 * provision räknas. Slutade den tidigare (automaten flyttades ut före avvecklingen) öppnas
 * ingen.
 */
export function placementToReopen(
  placements: readonly PlacementSpan[],
  activeTo: IsoDate,
): PlacementSpan | null {
  const latest = [...placements].sort((a, b) => (a.from < b.from ? 1 : a.from > b.from ? -1 : 0))[0];
  return latest && latest.to === activeTo ? latest : null;
}
