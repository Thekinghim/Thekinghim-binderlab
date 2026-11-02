/**
 * Status för en rapport i arkivet, räknad ur godkännandet och utskicken. Ren modul.
 *
 *   ersatt   en nyare rapport av samma typ, period och butik finns (den här skickas inte)
 *   skickad  minst ett utskick med status köad, skickad eller levererad
 *   godkänd  godkänd av ägare eller admin men inte skickad
 *   utkast   inte godkänd
 *
 * En skickad rapport räknas aldrig som ersatt: den har gått iväg och står kvar i arkivet
 * som skickad även om en nyare version skapats.
 */

export type ReportStatus = "draft" | "approved" | "sent" | "superseded";

export type DeliveryStatus = "queued" | "sent" | "delivered" | "failed" | "bounced";

export const STATUS_LABEL: Record<ReportStatus, string> = {
  draft: "Utkast",
  approved: "Godkänd",
  sent: "Skickad",
  superseded: "Ersatt",
};

/** Utskick som räknas som genomförda (samma regel som Att göra). */
export const DONE_DELIVERY: ReadonlySet<DeliveryStatus> = new Set(["queued", "sent", "delivered"]);

export interface StatusRow {
  readonly id: string;
  readonly kind: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly storeId: string | null;
  /** ISO 8601. */
  readonly generatedAt: string;
  readonly approved: boolean;
  readonly deliveries: readonly { readonly status: DeliveryStatus }[];
}

/** Nyckeln som avgör om två rapporter är versioner av samma rapport. */
export function versionKey(r: Pick<StatusRow, "kind" | "periodStart" | "periodEnd" | "storeId">) {
  return `${r.kind}|${r.periodStart}|${r.periodEnd}|${r.storeId ?? ""}`;
}

/** Status per rapport-id. */
export function reportStatuses(rows: readonly StatusRow[]): Map<string, ReportStatus> {
  const latest = new Map<string, StatusRow>();
  for (const r of rows) {
    const key = versionKey(r);
    const cur = latest.get(key);
    if (
      !cur ||
      r.generatedAt > cur.generatedAt ||
      (r.generatedAt === cur.generatedAt && r.id > cur.id)
    ) {
      latest.set(key, r);
    }
  }
  const out = new Map<string, ReportStatus>();
  for (const r of rows) {
    const sent = r.deliveries.some((d) => DONE_DELIVERY.has(d.status));
    if (sent) out.set(r.id, "sent");
    else if (latest.get(versionKey(r))?.id !== r.id) out.set(r.id, "superseded");
    else out.set(r.id, r.approved ? "approved" : "draft");
  }
  return out;
}
