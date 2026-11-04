/**
 * Visning på Drift: status per automat som statusetikett, rubriker räknade ur hälsan och
 * tider i organisationens tidszon. Rent och klientsäkert.
 */

import type { HealthStatus, MachineHealth } from "@/analytics/health";
import { assortmentKey } from "@/analytics/todos/assortment";
import type { IsoDate } from "@/domain";
import { sentence, weekdayDay } from "@/analytics/todos/text";
import type { Status } from "@/components/ui/status-tag";
import { wallClockIn } from "@/components/shell/period-state";
import { formatDateTime, formatInt, MISSING, NBSP } from "@/lib/format";

/** Statusetikett per hälsostatus. Ur drift och fel kräver åtgärd (signal); tom och misstänkt fel är varningar. */
export const HEALTH_TAG: Record<HealthStatus, { status: Status; label: string }> = {
  offline: { status: "critical", label: "Ur drift" },
  fault: { status: "critical", label: "Fel" },
  suspected_fault: { status: "warning", label: "Misstänkt fel" },
  empty: { status: "warning", label: "Tom" },
  unknown: { status: "neutral", label: "Okänt" },
  ok: { status: "ok", label: "I drift" },
  inactive: { status: "offline", label: "Ej i drift" },
};

/** Statusar som räknas som problem i rubriken. */
const PROBLEM: ReadonlySet<HealthStatus> = new Set([
  "offline",
  "fault",
  "suspected_fault",
  "empty",
]);

export function plural(n: number, one: string, many: string): string {
  return `${formatInt(n)}${NBSP}${n === 1 ? one : many}`;
}

/** "1 nov. 21:23" i tidszonen. */
export function formatWhen(iso: string | null, timeZone: string, now: Date = new Date()): string {
  if (!iso) return MISSING;
  const d = new Date(iso);
  if (!Number.isFinite(d.getTime())) return MISSING;
  return formatDateTime(wallClockIn(d, timeZone), { now: wallClockIn(now, timeZone) });
}

/** Första meningen i en text (för grå rubrikdelar). */
export function firstSentence(text: string): string {
  // En punkt följd av gemen eller siffra är en förkortning ("1 nov. 17:09"), inte meningens slut.
  const m = /^(.+?[.!?])(\s+(?=[A-ZÅÄÖ])|$)/.exec(text.trim());
  return m?.[1] ?? text.trim();
}

/**
 * Rubriken på /drift. Huvudpersonen är antalet automater i drift; den grå delen säger vad
 * som är fel och sedan när, eller att alla är i drift.
 */
export function driftHeadline(health: readonly MachineHealth[]): { title: string; aside: string } {
  const active = health.filter((h) => h.status !== "inactive");
  if (active.length === 0) {
    return { title: "Inga automater i drift.", aside: "Lägg till en automat under Automater." };
  }
  const ok = active.filter((h) => h.status === "ok").length;
  const problems = active.filter((h) => PROBLEM.has(h.status));
  const unknown = active.filter((h) => h.status === "unknown").length;
  if (problems.length === 0) {
    return {
      title:
        ok === active.length
          ? active.length === 1
            ? "Automaten är i drift."
            : `Alla ${formatInt(active.length)} automater är i drift.`
          : `${formatInt(ok)} av ${plural(active.length, "automat", "automater")} i drift.`,
      aside:
        unknown > 0
          ? `${plural(unknown, "automat", "automater")} för ny att bedöma.`
          : "Alla säljer som vanligt.",
    };
  }
  const first = problems[0]!;
  const more = problems.length - 1;
  return {
    title: `${formatInt(ok)} av ${plural(active.length, "automat", "automater")} i drift.`,
    aside: `${sentence(first.title)}${more > 0 ? ` Och ${plural(more, "automat", "automater")} till.` : ""}`,
  };
}

/** Ett tal i underlaget som text, med enhet. Belopp (öre) visas aldrig här. */
export function figureText(f: { value: number; unit: string }): string | null {
  switch (f.unit) {
    case "packs":
      return `${formatInt(f.value)}${NBSP}pack`;
    case "days":
      return `${formatInt(f.value)}${NBSP}${f.value === 1 ? "dag" : "dagar"}`;
    case "hours":
      return `${formatInt(f.value)}${NBSP}h`;
    case "count":
      return formatInt(f.value);
    case "tenths":
      return `${formatInt(Math.trunc(f.value / 10))},${Math.abs(f.value % 10)}`;
    case "bp": {
      const sign = f.value < 0 ? "−" : "";
      const abs = Math.abs(f.value);
      return `${sign}${formatInt(Math.trunc(abs / 100))},${String(abs % 100).padStart(2, "0")}${NBSP}%`;
    }
    default:
      return null;
  }
}

const RANK: Record<HealthStatus, number> = {
  offline: 0,
  fault: 1,
  suspected_fault: 2,
  empty: 3,
  unknown: 4,
  ok: 5,
  inactive: 6,
};

/** Sorteringsvärde: allvarligast först. */
export function healthRank(status: HealthStatus): number {
  return RANK[status];
}

/** Avslutar en mening med punkt om den inte redan slutar med ett skiljetecken. */
export function sentenceEnd(text: string): string {
  const t = text.trim();
  return /[.!?]$/.test(t) ? t : `${t}.`;
}

/** Det ur ett larm som rubrik och sortering behöver. */
export interface AlertLike {
  readonly kind: string;
  readonly severity: "critical" | "warning" | "info" | string;
  readonly machineId: string | null;
  readonly title: string;
  readonly openedAt: string;
  readonly evidence: { readonly dates: readonly string[] };
}

/**
 * Larmen utan lagerlarm för titlar som gått ur automaten (Utgår på Lager): de säljs ut och
 * ska inte stå som "Kritisk – slut". Samma regel som larmjobbet (`lowStockAlerts` med
 * `retired`), så att ett larm som öppnades innan titeln togs bort inte syns tills nästa körning.
 */
export function withoutRetiredAlerts<
  T extends { kind: string; machineId: string | null; titleId: string | null },
>(alerts: readonly T[], retired: ReadonlySet<string>): T[] {
  if (retired.size === 0) return [...alerts];
  return alerts.filter(
    (a) =>
      a.kind !== "low_stock" ||
      a.machineId === null ||
      a.titleId === null ||
      !retired.has(assortmentKey(a.machineId, a.titleId)),
  );
}

const SEVERITY_RANK: Record<string, number> = { critical: 0, warning: 1, info: 2 };

/**
 * Larmen i den ordning de ska hanteras: kritiska först, sedan det som tar slut
 * först (lagerlarmets beräknade slutdatum), sedan äldst öppnade.
 */
export function sortAlerts<T extends AlertLike>(alerts: readonly T[]): T[] {
  const due = (a: AlertLike) => (a.kind === "low_stock" ? (a.evidence.dates[0] ?? null) : null);
  return [...alerts].sort((a, b) => {
    const s = (SEVERITY_RANK[a.severity] ?? 3) - (SEVERITY_RANK[b.severity] ?? 3);
    if (s !== 0) return s;
    const da = due(a);
    const db = due(b);
    if (da !== db) {
      if (da === null) return 1;
      if (db === null) return -1;
      return da < db ? -1 : 1;
    }
    return a.openedAt < b.openedAt ? -1 : a.openedAt > b.openedAt ? 1 : 0;
  });
}

/**
 * Rubriken på /drift när alla automater är i drift men larm är öppna: det som
 * ska göras ("5 titlar i 3 automater tar slut senast tor 5 nov."), inte att allt är i drift.
 */
export function alertHeadline(alerts: readonly AlertLike[]): string | null {
  if (alerts.length === 0) return null;
  const low = alerts.filter((a) => a.kind === "low_stock");
  if (low.length === alerts.length) {
    const empty = low.filter((a) => a.severity === "critical");
    const near = low.filter((a) => a.severity !== "critical");
    const machines = new Set(low.map((a) => a.machineId)).size;
    const last = near
      .map((a) => a.evidence.dates[0])
      .filter((d): d is string => typeof d === "string")
      .sort()
      .at(-1);
    const where = `i ${plural(machines, "automat", "automater")}`;
    const when = last ? `senast ${weekdayDay(last as IsoDate)}` : "inom kort";
    if (near.length === 0) {
      return `${plural(empty.length, "titel är slut", "titlar är slut")} ${where}.`;
    }
    if (empty.length === 0) {
      return sentence(`${plural(near.length, "titel", "titlar")} ${where} tar slut ${when}`);
    }
    return sentence(
      `${plural(empty.length, "titel är slut", "titlar är slut")} och ${formatInt(near.length)} tar slut ${when}`,
    );
  }
  const first = sortAlerts(alerts)[0]!;
  return `${plural(alerts.length, "öppet larm", "öppna larm")}: ${sentence(first.title)}`;
}
