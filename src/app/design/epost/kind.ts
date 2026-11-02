import type { RecipientKind } from "@/emails/report-content";

const KINDS: ReadonlyArray<RecipientKind> = ["butik", "bokforing", "delagare"];

/** ?typ=butik|bokforing|delagare. Okänt eller saknat värde ger delagare. */
export function parseRecipientKind(value: string | string[] | null | undefined): RecipientKind {
  const v = Array.isArray(value) ? value[0] : value;
  return KINDS.find((k) => k === v) ?? "delagare";
}
