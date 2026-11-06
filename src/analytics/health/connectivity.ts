/**
 * Automatens anslutning enligt leverantören (Awish Machines: is_online), som synken läser
 * var femte minut. Rena funktioner: `now` är den enda tidskällan.
 *
 * Läget per automat (source_machines.awish_*) går framåt med nextConnectivity:
 *
 *   online  + ingen offlineperiod          → online_at = nu
 *   offline + aldrig sedd online           → bara läget sparas (inget larm för en automat
 *                                             som aldrig varit online, t.ex. inte installerad)
 *   offline + ingen offlineperiod          → offline_since = nu
 *   online  + offlineperiod                → back_online_at = nu (perioden pågår tills
 *                                             automaten varit online i FLAP_MINUTES)
 *   online  + back_online_at ≥ FLAP sedan  → perioden slutar (last_offline_from sparas)
 *   offline + back_online_at satt          → fladder: samma period fortsätter
 *
 * connectivitySignals gör om läget till maskinhändelser (MachineSignal) för maskinhälsan:
 * offline först när perioden varat OFFLINE_ALERT_MINUTES, och bara när läget är färskt
 * (synken har läst automaten de senaste STALE_MINUTES). Larmet (machine_offline) kommer ur
 * maskinhälsan; incidenterna i @/analytics/alerts stänger det när automaten är tillbaka.
 */

import { parseInstant } from "@/analytics/todos/time";

import type { MachineSignal } from "./types";

/** Minuter offline innan automaten räknas som offline (och larmar). */
export const OFFLINE_ALERT_MINUTES = 20;
/** Minuter online innan en offlineperiod räknas som slut (mot fladder). */
export const FLAP_MINUTES = 20;
/** Äldre läge än så här används inte (synken har slutat läsa automaten). */
export const STALE_MINUTES = 60;

const MINUTE_MS = 60_000;

/** Läget för en automat, som det sparas (ISO 8601 eller null). */
export interface ConnectivityState {
  readonly online: boolean | null;
  readonly status: string | null;
  readonly seenAt: string | null;
  readonly onlineAt: string | null;
  readonly offlineSince: string | null;
  readonly backOnlineAt: string | null;
  readonly lastOfflineFrom: string | null;
}

export const EMPTY_CONNECTIVITY: ConnectivityState = {
  online: null,
  status: null,
  seenAt: null,
  onlineAt: null,
  offlineSince: null,
  backOnlineAt: null,
  lastOfflineFrom: null,
};

/** Nästa läge efter ett svar från leverantören. */
export function nextConnectivity(
  prev: ConnectivityState,
  observed: { readonly isOnline: boolean; readonly status: string | null },
  now: Date | string | number,
): ConnectivityState {
  const nowMs = parseInstant(now);
  const at = new Date(nowMs).toISOString();
  const base = { ...prev, online: observed.isOnline, status: observed.status, seenAt: at };
  if (observed.isOnline) {
    if (prev.offlineSince === null) return { ...base, onlineAt: at };
    if (prev.backOnlineAt === null) return { ...base, onlineAt: at, backOnlineAt: at };
    if (nowMs - parseInstant(prev.backOnlineAt) >= FLAP_MINUTES * MINUTE_MS) {
      return {
        ...base,
        onlineAt: at,
        offlineSince: null,
        lastOfflineFrom: prev.offlineSince,
      };
    }
    return { ...base, onlineAt: at };
  }
  if (prev.onlineAt === null) return base;
  if (prev.offlineSince === null) return { ...base, offlineSince: at, backOnlineAt: null };
  // Fladder: tillbaka offline innan perioden hann sluta. Samma period fortsätter.
  return { ...base, backOnlineAt: null };
}

/** Läget för en Binderlab-automat (rad ur public.machine_connectivity). */
export interface MachineConnectivity extends ConnectivityState {
  readonly machineId: string;
}

/** Vad sidorna visar: online, offline (sedan) eller okänt. */
export interface ConnectivityView {
  readonly state: "online" | "offline" | "unknown";
  /** Offline: början på perioden (ISO 8601). */
  readonly since: string | null;
}

function fresh(c: ConnectivityState, nowMs: number): boolean {
  if (c.seenAt === null) return false;
  return nowMs - parseInstant(c.seenAt) <= STALE_MINUTES * MINUTE_MS;
}

/**
 * Offline enligt regeln: sedd online någon gång, senaste svaret offline och perioden har
 * varat minst OFFLINE_ALERT_MINUTES. Returnerar periodens början, annars null.
 */
export function offlineSinceMs(c: ConnectivityState, now: Date | string | number): number | null {
  const nowMs = parseInstant(now);
  if (!fresh(c, nowMs) || c.onlineAt === null || c.online !== false || c.offlineSince === null) {
    return null;
  }
  const since = parseInstant(c.offlineSince);
  return nowMs - since >= OFFLINE_ALERT_MINUTES * MINUTE_MS ? since : null;
}

/** Online/offline för sidorna (samma regel som larmet). */
export function connectivityView(
  c: ConnectivityState | undefined,
  now: Date | string | number,
): ConnectivityView {
  if (!c) return { state: "unknown", since: null };
  const nowMs = parseInstant(now);
  if (!fresh(c, nowMs) || c.onlineAt === null) return { state: "unknown", since: null };
  const since = offlineSinceMs(c, nowMs);
  if (since !== null) return { state: "offline", since: new Date(since).toISOString() };
  return { state: "online", since: null };
}

/** Id-prefix för händelsen som bara säger att anslutningen är känd (inte en övergång). */
export const CONNECTIVITY_STATE_PREFIX = "awish-state:";

/**
 * Maskinhändelser ur läget, för maskinhälsan och tidslinjen:
 *   - senaste offlineperiod som kommit tillbaka och varade OFFLINE_ALERT_MINUTES: offline +
 *     online igen (avslutad, eller i fladderfönstret)
 *   - pågående offline enligt offlineSinceMs: offline vid periodens början
 *   - annars: en "online"-händelse (id med CONNECTIVITY_STATE_PREFIX) vid senaste online,
 *     så att maskinhälsan vet att anslutningen är känd (tidslinjen visar den inte)
 * Inga händelser för en automat som aldrig setts online eller vars läge är gammalt.
 */
export function connectivitySignals(
  rows: readonly MachineConnectivity[],
  now: Date | string | number,
  source = "awish_grpc",
): MachineSignal[] {
  const nowMs = parseInstant(now);
  const out: MachineSignal[] = [];
  for (const c of rows) {
    if (!fresh(c, nowMs) || c.onlineAt === null) continue;
    const id = (what: string, at: string) => `awish:${c.machineId}:${what}:${at}`;
    // Avslutad period (lastOfflineFrom → backOnlineAt), eller pågående period som just kommit
    // tillbaka (offlineSince → backOnlineAt, fladderfönstret). backOnlineAt hör alltid till
    // den senaste perioden, så den paras aldrig med en äldre periods början.
    const periodFrom = c.offlineSince ?? c.lastOfflineFrom;
    if (periodFrom !== null && c.backOnlineAt !== null) {
      const from = parseInstant(periodFrom);
      const to = parseInstant(c.backOnlineAt);
      if (to - from >= OFFLINE_ALERT_MINUTES * MINUTE_MS && to <= nowMs) {
        out.push({
          id: id("offline", periodFrom),
          machineId: c.machineId,
          at: periodFrom,
          kind: "offline",
          source,
        });
        out.push({
          id: id("online", c.backOnlineAt),
          machineId: c.machineId,
          at: c.backOnlineAt,
          kind: "online",
          source,
        });
      }
    }
    const since = offlineSinceMs(c, nowMs);
    if (since !== null) {
      const at = new Date(since).toISOString();
      out.push({
        id: id("offline", at),
        machineId: c.machineId,
        at,
        kind: "offline",
        source,
      });
      continue;
    }
    const lastOnline = Math.min(parseInstant(c.onlineAt), nowMs);
    out.push({
      id: `${CONNECTIVITY_STATE_PREFIX}${c.machineId}`,
      machineId: c.machineId,
      at: new Date(lastOnline).toISOString(),
      kind: "online",
      source,
    });
  }
  return out;
}
