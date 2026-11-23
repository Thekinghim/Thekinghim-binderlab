/**
 * Automatens utseende (machines.appearance, 20261227200000_automat_utseende.sql). Vi har två
 * sorters kiosker: de svarta med gula stjärnor (de flesta butiker) och en gul. Bara för bilden
 * av automaten (MachineGlyph); inga beräkningar beror på det.
 */

export const MACHINE_LOOKS = ["stjarnor", "gul"] as const;
export type MachineLook = (typeof MACHINE_LOOKS)[number];

/** Standard när kolumnen är null eller okänd. */
export const DEFAULT_MACHINE_LOOK: MachineLook = "stjarnor";

/** Valen i formuläret ("Utseende"). */
export const MACHINE_LOOK_LABEL: Readonly<Record<MachineLook, string>> = {
  stjarnor: "Svart med stjärnor",
  gul: "Gul",
};

export function isMachineLook(value: unknown): value is MachineLook {
  return typeof value === "string" && (MACHINE_LOOKS as readonly string[]).includes(value);
}

/** Databasens värde → utseende (null och okänt = svart med stjärnor). */
export function machineLookOf(value: unknown): MachineLook {
  return isMachineLook(value) ? value : DEFAULT_MACHINE_LOOK;
}
