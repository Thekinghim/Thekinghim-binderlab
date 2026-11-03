/**
 * Ny automat från Awish och guiden "Ny butik": indata (zod) och regler utan I/O, så att
 * de kan testas (plan.test.ts). Tjänsten (./new-machines.ts) kör dem i en transaktion.
 *
 * - En automat som Awish hittat (source_machines utan machine_id) kopplas till en butik på
 *   ett klick: koden föreslås (BL-001 → BL-002), namnet tas från Awish, driftstart och
 *   placering börjar dagen för första ordern (eller i dag), så att alla order hamnar i
 *   butiken.
 * - Guiden: butik → avtal (snabbval, standard 50/50 vinst) → automat → klart.
 */

import { z } from "zod";

import { isIsoDate, minDate, type IsoDate } from "@/domain";

import { MACHINE_CODE, normalizeCode } from "@/app/(app)/automater/_lib/validation";

/** Nyckeln i todo_dismissals när en hittad automat är "Inte vår". */
export function newMachineKey(sourceMachineId: string): string {
  return `new-machine:${sourceMachineId}`;
}

/** Fingerprint för "Inte vår" (gäller tills ångrad). */
export const IGNORED_FINGERPRINT = "inte-var";

const uuid = z.uuid({ message: "Ogiltigt id." });

const optionalCode = z
  .string()
  .optional()
  .nullable()
  .transform((v) => (v ? normalizeCode(v) : null))
  .refine((v) => v === null || MACHINE_CODE.test(v), {
    message: "Koden får bara innehålla A–Z, 0–9 och bindestreck, högst 32 tecken.",
  });

const optionalName = z
  .string()
  .trim()
  .max(200, { message: "Namnet får vara högst 200 tecken." })
  .optional()
  .nullable()
  .transform((v) => (v ? v : null));

export const connectSchema = z.object({
  sourceMachineId: uuid,
  storeId: uuid,
  code: optionalCode,
  name: optionalName,
});
export type ConnectInput = z.infer<typeof connectSchema>;

export const ignoreSchema = z.object({ sourceMachineId: uuid });

/** Snabbvalen i guiden. */
export const TERM_PRESETS = ["split", "sales", "rent"] as const;
export type TermPreset = (typeof TERM_PRESETS)[number];

export const guideSchema = z.object({
  store: z.object({
    name: z.string(),
    address: z.string().optional(),
    city: z.string().optional(),
  }),
  terms: z.object({
    preset: z.enum(TERM_PRESETS, { error: "Välj villkor." }),
    /** Butikens andel i procent (vinst eller omsättning). */
    share: z.string().optional(),
    /** Fast hyra i kronor per månad. */
    rent: z.string().optional(),
  }),
  machine: z
    .discriminatedUnion("kind", [
      z.object({ kind: z.literal("awish"), sourceMachineId: uuid }),
      z.object({ kind: z.literal("new"), code: optionalCode, name: optionalName }),
    ])
    .nullable(),
});
export type GuideInput = z.infer<typeof guideSchema>;

/**
 * Villkoren som fält till avtalets schema (newAgreementSchema): 50/50 vinst =
 * vinstdelning, procent av omsättning = andel av försäljningen, fast hyra = bara hyra.
 */
export function agreementFields(terms: GuideInput["terms"]): {
  model: "split" | "sales";
  commission: string;
  rent: string;
} {
  const share = (terms.share ?? "").trim();
  const rent = (terms.rent ?? "").trim();
  switch (terms.preset) {
    case "split":
      return { model: "split", commission: share || "50", rent: "" };
    case "sales":
      return { model: "sales", commission: share, rent: "" };
    case "rent":
      return { model: "sales", commission: "", rent };
  }
}

/** Driftstart och placering: första orderns dag, högst i dag. */
export function startDate(firstOrderDate: string | null, today: IsoDate): IsoDate {
  return firstOrderDate && isIsoDate(firstOrderDate) ? minDate(firstOrderDate, today) : today;
}

/** Automatens namn: valt namn, annars Awish namn, annars "Automat <nummer>". */
export function machineName(
  chosen: string | null,
  external: { name: string | null; deviceNo: string | null },
  code: string,
): string {
  const n = chosen?.trim() || external.name?.trim();
  if (n) return n.slice(0, 200);
  return `Automat ${external.deviceNo?.trim() || code}`.slice(0, 200);
}
