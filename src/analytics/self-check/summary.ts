/**
 * Körningen som helhet: status ur kontrollerna, raden på Hem och tolkningen av det som
 * sparats i self_check_runs.checks. Rent.
 */

import { countText } from "./common";
import {
  CHECK_ORDER,
  CHECKS,
  isSelfCheckId,
  type CheckFigure,
  type CheckFinding,
  type CheckResult,
  type CheckStatus,
} from "./types";

export type RunStatus = "ok" | "warning" | "failed" | "error";

export interface RunSummary {
  readonly status: RunStatus;
  /** Kontroller som inte gick igenom. */
  readonly failed: number;
  /** Kontroller med bara varningar. */
  readonly warnings: number;
}

export function summarize(results: readonly CheckResult[]): RunSummary {
  const failed = results.filter((r) => r.status === "fail").length;
  const warnings = results.filter((r) => r.status === "warn").length;
  return { status: failed > 0 ? "failed" : warnings > 0 ? "warning" : "ok", failed, warnings };
}

/**
 * Raden på Hem: "Kontrollen hittade 2 fel", annars varningen ur inställningarna
 * ("Kortavgiften står på 0 %"), eller null när inget behöver göras.
 */
export function homeLine(
  run: {
    readonly failed: number;
    readonly status: RunStatus;
    readonly notice?: string | null;
  } | null,
): string | null {
  if (!run) return null;
  if (run.status === "error") return "Kontrollen kunde inte köras";
  if (run.failed === 0) return run.notice ?? null;
  return `Kontrollen hittade ${countText(run.failed, "fel", "fel")}`;
}

/** Vart raden på Hem leder: Kontroll vid fel, Inställningar när det bara är en inställning. */
export function homeLink(
  run: {
    readonly failed: number;
    readonly status: RunStatus;
    readonly notice?: string | null;
  } | null,
): string {
  if (run && run.status !== "error" && run.failed === 0 && run.notice) return "/installningar";
  return "/installningar/kontroll";
}

const STATUSES: readonly CheckStatus[] = ["pass", "warn", "fail", "skip"];

function text(v: unknown, max = 600): string {
  return typeof v === "string" ? v.slice(0, max) : "";
}

function safeLink(v: unknown, fallback: string): string {
  return typeof v === "string" && v.startsWith("/") && !v.startsWith("//") && !v.startsWith("/\\")
    ? v.slice(0, 300)
    : fallback;
}

/**
 * Det sparade (jsonb) tillbaka till resultat, i visningsordning. Okända kontroller och
 * felaktiga fält hoppas över, så att en äldre eller trasig rad aldrig kraschar sidan.
 */
export function parseChecks(value: unknown): CheckResult[] {
  if (!Array.isArray(value)) return [];
  const out: CheckResult[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object") continue;
    const r = raw as Record<string, unknown>;
    if (!isSelfCheckId(r.id)) continue;
    const meta = CHECKS[r.id];
    const status = STATUSES.includes(r.status as CheckStatus) ? (r.status as CheckStatus) : "fail";
    const findings: CheckFinding[] = Array.isArray(r.findings)
      ? r.findings
          .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
          .map((f) => ({
            level: f.level === "warn" ? ("warn" as const) : ("fail" as const),
            text: text(f.text),
            ...(typeof f.link === "string" ? { link: safeLink(f.link, meta.link) } : {}),
          }))
      : [];
    const figures: CheckFigure[] = Array.isArray(r.figures)
      ? r.figures
          .filter((f): f is Record<string, unknown> => !!f && typeof f === "object")
          .filter((f) => typeof f.value === "number" && Number.isFinite(f.value))
          .map((f) => ({
            label: text(f.label, 120),
            value: f.value as number,
            unit: (["ore", "bp", "count", "minutes"] as const).includes(f.unit as never)
              ? (f.unit as CheckFigure["unit"])
              : "count",
          }))
      : [];
    out.push({
      id: r.id,
      status,
      title: meta.title,
      summary: text(r.summary),
      findings,
      more: typeof r.more === "number" && r.more > 0 ? Math.floor(r.more) : 0,
      figures,
      link: meta.link,
      linkLabel: meta.linkLabel,
      ...(typeof r.durationMs === "number" ? { durationMs: r.durationMs } : {}),
    });
  }
  return out.sort((a, b) => CHECK_ORDER.indexOf(a.id) - CHECK_ORDER.indexOf(b.id));
}
