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

/** Sista dagen i månaden 'ÅÅÅÅ-MM'. */
export function monthEnd(month: string): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${month}-${String(last).padStart(2, "0")}`;
}

/**
 * Dagen för senaste synken ('ÅÅÅÅ-MM-DD' i organisationens tidszon) när rapportperioden
 * slutar samma dag eller senare, så att order efter synken kan saknas i rapporten. Annars
 * null (ingen synk än, eller synken är nyare än perioden). Blockerar inget.
 */
export function staleImportDay(
  periodEnd: string,
  syncedAt: string | null | undefined,
  timeZone: string,
): string | null {
  if (!syncedAt) return null;
  const d = new Date(syncedAt);
  if (Number.isNaN(d.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const day = `${get("year")}-${get("month")}-${get("day")}`;
  return day <= periodEnd ? day : null;
}
