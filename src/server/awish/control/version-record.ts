/**
 * Sparar ett Version-svar från Awish (awish_api_state) och larmar vid byte. Används av
 * Version-kontrollen (cron, Datakällor) och av spärren före varje skrivning som rör fack,
 * påfyllning, schema, Mata ut och Stäng av (guard.ts läser versionen live).
 */

import "server-only";

import type { Db } from "@/db/client";
import { raiseSystemAlert } from "@/server/monitoring/system-alerts";

import { updateApiState } from "./state";

/** Proto-filen som är inbäddad i provider-proto.ts. */
export const EMBEDDED_PROTO_VERSION = "1.2.41";

/** Jämför versioner som "1.2.41" (numeriskt per del). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface VersionCheck {
  version: string;
  previous: string | null;
  changed: boolean;
}

export function versionAlertKey(version: string): string {
  return `awish_version:${version}`;
}

/**
 * Är versionen ett byte? Mot förra sparade, eller (första gången) mot den inbäddade
 * proto-filen: en annan version än den vi byggt mot kan ha andra fältnummer.
 */
export function isVersionChange(previous: string | null, version: string): boolean {
  return version !== (previous ?? EMBEDDED_PROTO_VERSION);
}

/** Sparar versionen; vid byte krävs ny kvittering och ett systemlarm skapas. */
export async function recordAwishVersion(
  db: Db,
  orgId: string,
  sourceId: string,
  previous: string | null,
  version: string,
  now: Date,
): Promise<VersionCheck> {
  const changed = isVersionChange(previous, version);
  const from = previous ?? EMBEDDED_PROTO_VERSION;
  await updateApiState(db, orgId, sourceId, {
    version,
    versionSeenAt: now,
    ...(changed
      ? {
          previousVersion: from,
          versionChangedAt: now,
          versionAcknowledgedAt: null,
          versionAcknowledgedBy: null,
        }
      : {}),
  });
  if (changed) {
    await raiseSystemAlert(db, {
      organizationId: orgId,
      kind: "job_failed",
      key: versionAlertKey(version),
      severity: "warning",
      title: `Awish bytte API-version: ${from} → ${version}`,
      detail:
        "Kontrollera att facken och antalen ser rätt ut. Ändringar via API (fack, påfyllning, schema, mata ut, stäng av) är pausade tills någon bekräftat under Datakällor. Påfyllningen går via webbpanelen så länge.",
      rule: "Awishs Version-svar skiljer sig från förra kontrollen.",
      link: "/datakallor",
      now,
    });
  }
  return { version, previous, changed };
}
