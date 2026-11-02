/**
 * Felanmälan från butiksportalen: vilka slags fel butiken kan anmäla och hur
 * ärendets status visas. Samma lista som i portal_report_fault
 * (supabase/migrations/20261102130100_portal_store_access.sql). Ärendena hamnar i
 * incidents med kind = store_* och syns i Inkorgen.
 */

export const FAULT_KINDS = [
  "store_payment",
  "store_stuck",
  "store_empty",
  "store_screen",
  "store_damage",
  "store_other",
] as const;

export type FaultKind = (typeof FAULT_KINDS)[number];

export const FAULT_LABEL: Record<FaultKind, string> = {
  store_payment: "Betalningen fungerar inte",
  store_stuck: "Ett pack fastnade",
  store_empty: "Tomt eller nästan tomt",
  store_screen: "Skärmen eller strömmen",
  store_damage: "Skadad eller nedsmutsad",
  store_other: "Annat",
};

export function isFaultKind(value: unknown): value is FaultKind {
  return typeof value === "string" && (FAULT_KINDS as readonly string[]).includes(value);
}

export type FaultStatus = "open" | "in_progress" | "resolved";

export const FAULT_STATUS_LABEL: Record<FaultStatus, string> = {
  open: "Mottagen",
  in_progress: "Åtgärdas",
  resolved: "Åtgärdad",
};

export function faultStatus(value: unknown, resolvedAt: string | null): FaultStatus {
  if (value === "open" || value === "in_progress" || value === "resolved") return value;
  return resolvedAt ? "resolved" : "open";
}
