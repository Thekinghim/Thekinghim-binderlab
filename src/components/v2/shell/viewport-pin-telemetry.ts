/**
 * Fältdata från ViewportPin: när bottenraden flyttas (eller när skyddet mot en för liten
 * förskjutning slår till) i hemskärmsappen skickas de senaste måtten en gång, via
 * klientfelens väg (POST /api/klientfel → private.client_errors, message "ViewportPin: …").
 * Bara mått och händelsenamn, inget om personen. Högst en rapport per REPORT_EVERY_MS
 * (sessionStorage) och per sidladdning; databasen släpper dessutom fler än 30 per timme.
 */

/** Kolumnerna i varje rad, i ordning. */
export const VP_COLS =
  "ev,inner,vvH,vvTop,fixedBottom,healthy,shift,gap,scrollY,msResume,drawer" as const;

export type VpSnapshot = {
  /** Händelsen som utlöste mätningen (kort namn, t.ex. "vvresize", "t400", "visible"). */
  ev: string;
  inner: number;
  vvH: number;
  vvTop: number;
  fixedBottom: number;
  healthy: number;
  shift: number;
  gap: number;
  scrollY: number;
  /** ms sedan appen senast kom tillbaka (visibilitychange/pageshow/focus) eller laddades. */
  msResume: number;
  drawerOpen: boolean;
};

export const RING_SIZE = 12;
export const REPORT_EVERY_MS = 10 * 60 * 1000;
/** Största längd (tecken) på `vp` som JSON, så att extra ryms i databasens 1000 byte. */
export const VP_MAX_JSON = 760;

function int(n: number, max = 99_999): number {
  if (!Number.isFinite(n)) return -1;
  return Math.max(-max, Math.min(max, Math.round(n)));
}

/** En rad: "vvresize,793,793,0,793,852,0,59,120,3400,0". */
export function snapshotRow(s: VpSnapshot): string {
  const ev = s.ev.replace(/[^a-z0-9]/gi, "").slice(0, 10) || "x";
  return [
    ev,
    int(s.inner),
    int(s.vvH),
    int(s.vvTop),
    int(s.fixedBottom),
    int(s.healthy),
    int(s.shift),
    int(s.gap),
    int(s.scrollY),
    int(s.msResume, 9_999_999),
    s.drawerOpen ? 1 : 0,
  ].join(",");
}

/**
 * De senaste RING_SIZE mätningarna. En mätning som bara skiljer sig i scrollY och tid från den
 * förra (samma händelse) ersätter den, så att en lång scroll inte trycker ut det som hände vid
 * återkomsten.
 */
export class SnapshotRing {
  private items: VpSnapshot[] = [];

  push(s: VpSnapshot): void {
    const last = this.items[this.items.length - 1];
    if (
      last &&
      last.ev === s.ev &&
      last.inner === s.inner &&
      last.vvH === s.vvH &&
      last.vvTop === s.vvTop &&
      last.fixedBottom === s.fixedBottom &&
      last.healthy === s.healthy &&
      last.shift === s.shift &&
      last.drawerOpen === s.drawerOpen
    ) {
      this.items[this.items.length - 1] = s;
      return;
    }
    this.items.push(s);
    if (this.items.length > RING_SIZE) this.items.shift();
  }

  rows(): string[] {
    return this.items.map(snapshotRow);
  }
}

export type VpReport = { cols: string; screen: number; rows: string[] };

/** Rapportens `vp`: de nyaste raderna som ryms inom VP_MAX_JSON tecken. */
export function vpReport(rows: string[], screen: number): VpReport {
  const r: VpReport = { cols: VP_COLS, screen: int(screen), rows: rows.slice(-RING_SIZE) };
  while (r.rows.length > 0 && JSON.stringify(r).length > VP_MAX_JSON) r.rows.shift();
  return r;
}

/** Får en ny rapport skickas? `last` är tidpunkten (ms sedan 1970) för den förra, eller null. */
export function reportDue(last: number | null, now: number): boolean {
  if (last === null || !Number.isFinite(last)) return true;
  return now - last >= REPORT_EVERY_MS || now < last;
}
