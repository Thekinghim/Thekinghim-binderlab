/**
 * Prenumerationer: vem får vilka larm, och när.
 *
 * En avisering går till en prenumeration när:
 *   - prenumerationen är aktiv,
 *   - larmtypen ingår (`kinds`),
 *   - automaten ingår (`machineIds`); larm utan automat (import, hela organisationen) påverkas
 *     inte av automatfiltret,
 *   - allvaret är minst `minSeverity` (standard 'warning'),
 *   - 'resolved' bara med `notifyResolved`, 'reminder' bara om `reminders` inte är avstängt.
 *
 * Tysta timmar (lokal tid i prenumerationens tidszon): aviseringen skjuts upp till slutet av de
 * tysta timmarna, utom kritiska larm när `criticalDuringQuietHours` (standard sant).
 * Alla aviseringar till samma användare med samma sändtid samlas i ett utskick.
 */

import { DomainError } from "@/domain";
import { DEFAULT_TIME_ZONE, localParts, parseInstant } from "@/analytics/todos/time";
import { SEVERITY_RANK } from "./rules";
import type { AlertDelivery, AlertNotification, AlertSubscription, QuietHours } from "./types";

const MINUTE_MS = 60_000;
const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function minutesOf(time: string): number {
  const m = TIME_PATTERN.exec(time);
  if (!m)
    throw new DomainError(
      "invalid_input",
      `Ogiltigt klockslag: ${JSON.stringify(time)}. Väntat 'TT:MM'.`,
    );
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Sant om den lokala tiden (minuter efter midnatt) ligger inom de tysta timmarna [start, end). */
export function isQuiet(localMinutes: number, quiet: QuietHours): boolean {
  const start = minutesOf(quiet.start);
  const end = minutesOf(quiet.end);
  if (start === end) return false;
  return start < end
    ? localMinutes >= start && localMinutes < end
    : localMinutes >= start || localMinutes < end;
}

function localMinutesAt(ms: number, timeZone: string): number {
  return minutesOf(localParts(ms, timeZone).time);
}

/**
 * Första tidpunkten ≥ `nowMs` utanför de tysta timmarna, på hel minut. `nowMs` om det inte är
 * tyst. Räknar fram skillnaden i lokal tid och justerar vid sommartidsskifte.
 * quietEndsAt(22:30 lokal tid, 22:00–07:00) → 07:00 nästa dag.
 */
export function quietEndsAt(nowMs: number, quiet: QuietHours, timeZone: string): number {
  const nowLocal = localMinutesAt(nowMs, timeZone);
  if (!isQuiet(nowLocal, quiet)) return nowMs;
  const end = minutesOf(quiet.end);
  const delta = (end - nowLocal + 1440) % 1440;
  let candidate = Math.floor(nowMs / MINUTE_MS) * MINUTE_MS + delta * MINUTE_MS;
  // Sommartid: klockan kan ha flyttats en timme under natten.
  for (const adjust of [0, -60, 60]) {
    const ms = candidate + adjust * MINUTE_MS;
    if (ms >= nowMs && !isQuiet(localMinutesAt(ms, timeZone), quiet)) {
      candidate = ms;
      return candidate;
    }
  }
  return candidate;
}

/** Sant om aviseringen ska gå till prenumerationen (utan hänsyn till tysta timmar). */
export function matchesSubscription(n: AlertNotification, s: AlertSubscription): boolean {
  if (s.active === false) return false;
  if (s.kinds !== "all" && !s.kinds.includes(n.kind)) return false;
  if (n.machineId !== null && s.machineIds !== "all" && !s.machineIds.includes(n.machineId))
    return false;
  if (SEVERITY_RANK[n.severity] < SEVERITY_RANK[s.minSeverity ?? "warning"]) return false;
  if (n.reason === "resolved" && !s.notifyResolved) return false;
  if (n.reason === "reminder" && s.reminders === false) return false;
  return true;
}

function subject(items: readonly AlertNotification[]): string {
  const first = items[0];
  if (!first) return "";
  if (items.length === 1) return first.title;
  return `${items.length} larm: ${first.title} med flera`;
}

/**
 * Fördelar aviseringarna på prenumerationerna och samlar dem till utskick, ett per användare
 * och sändtid. Har en användare flera prenumerationer får hon varje avisering en gång (den
 * tidigaste sändtiden vinner). Utskicken sorteras på sändtid och användare; aviseringarna i ett
 * utskick med allvarligast först.
 */
export function routeNotifications(
  notifications: readonly AlertNotification[],
  subscriptions: readonly AlertSubscription[],
  now: Date | string | number,
): AlertDelivery[] {
  const nowMs = parseInstant(now);
  // användare → incident+orsak → (sändtid, avisering)
  const perUser = new Map<string, Map<string, { sendAt: number; n: AlertNotification }>>();
  for (const s of subscriptions) {
    const tz = s.timeZone ?? DEFAULT_TIME_ZONE;
    for (const n of notifications) {
      if (!matchesSubscription(n, s)) continue;
      const bypass = n.severity === "critical" && s.criticalDuringQuietHours !== false;
      const sendAt = s.quietHours && !bypass ? quietEndsAt(nowMs, s.quietHours, tz) : nowMs;
      let user = perUser.get(s.userId);
      if (!user) {
        user = new Map();
        perUser.set(s.userId, user);
      }
      const k = `${n.incidentId}\u0000${n.reason}`;
      const prev = user.get(k);
      if (!prev || sendAt < prev.sendAt) user.set(k, { sendAt, n });
    }
  }
  const deliveries: AlertDelivery[] = [];
  for (const [userId, items] of perUser) {
    const bySend = new Map<number, AlertNotification[]>();
    for (const { sendAt, n } of items.values()) {
      const list = bySend.get(sendAt);
      if (list) list.push(n);
      else bySend.set(sendAt, [n]);
    }
    for (const [sendAt, list] of bySend) {
      list.sort(
        (a, b) =>
          SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
          (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) ||
          (a.reason < b.reason ? -1 : a.reason > b.reason ? 1 : 0),
      );
      deliveries.push({
        userId,
        sendAt: new Date(sendAt).toISOString(),
        deferred: sendAt > nowMs,
        subject: subject(list),
        items: list,
      });
    }
  }
  return deliveries.sort(
    (a, b) =>
      (a.sendAt < b.sendAt ? -1 : a.sendAt > b.sendAt ? 1 : 0) ||
      (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
  );
}

/**
 * Slår ihop väntande (uppskjutna) utskick med nya, så att en användare får ett utskick per
 * sändtid. Samma incident förekommer bara en gång per utskick: den senaste aviseringen gäller
 * (t.ex. "Löst: …" ersätter "Automat 3 är offline" om problemet löstes under natten).
 */
export function mergeDeliveries(
  pending: readonly AlertDelivery[],
  incoming: readonly AlertDelivery[],
): AlertDelivery[] {
  const map = new Map<string, AlertDelivery>();
  for (const d of [...pending, ...incoming]) {
    const k = `${d.userId}\u0000${d.sendAt}`;
    const prev = map.get(k);
    if (!prev) {
      map.set(k, d);
      continue;
    }
    const byIncident = new Map<string, AlertNotification>();
    for (const n of [...prev.items, ...d.items]) byIncident.set(n.incidentId, n);
    const items = [...byIncident.values()].sort(
      (a, b) =>
        SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] ||
        (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
    map.set(k, { ...prev, deferred: prev.deferred || d.deferred, items, subject: subject(items) });
  }
  return [...map.values()].sort(
    (a, b) =>
      (a.sendAt < b.sendAt ? -1 : a.sendAt > b.sendAt ? 1 : 0) ||
      (a.userId < b.userId ? -1 : a.userId > b.userId ? 1 : 0),
  );
}
