/**
 * Visning på Drift: status per automat som statusetikett, rubriker räknade ur hälsan och
 * tider i organisationens tidszon. Rent och klientsäkert.
 */

import type { HealthStatus, MachineHealth } from "@/analytics/health";
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
const PROBLEM: ReadonlySet<HealthStatus> = new Set(["offline", "fault", "suspected_fault", "empty"]);

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
  const m = /^(.+?[.!?])(\s|$)/.exec(text.trim());
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
          ? `Alla ${formatInt(active.length)} automater är i drift.`
          : `${formatInt(ok)} av ${plural(active.length, "automat", "automater")} i drift.`,
      aside:
        unknown > 0
          ? `${plural(unknown, "automat har", "automater har")} för lite historik för att bedömas.`
          : "Ingen avvikande tystnad i försäljningen.",
    };
  }
  const first = problems[0]!;
  const more = problems.length - 1;
  return {
    title: `${formatInt(ok)} av ${plural(active.length, "automat", "automater")} i drift.`,
    aside: `${first.title}.${more > 0 ? ` Och ${plural(more, "automat", "automater")} till.` : ""}`,
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
