/** Gemensamt för kontrollerna: resultatet ur fynden, och talen som text. Rent. */

import { formatKronor, formatMarginBp, MINUS, NBSP } from "@/lib/format";

import {
  CHECKS,
  MAX_FINDINGS,
  type CheckFigure,
  type CheckFinding,
  type CheckResult,
  type CheckStatus,
  type SelfCheckId,
} from "./types";

/** fail om något fynd är ett fel, warn om något är en varning, annars pass. */
export function statusOf(findings: readonly CheckFinding[]): CheckStatus {
  if (findings.some((f) => f.level === "fail")) return "fail";
  if (findings.some((f) => f.level === "warn")) return "warn";
  return "pass";
}

/** Felen först, sedan varningarna; högst MAX_FINDINGS sparas. */
export function resultOf(
  id: SelfCheckId,
  input: {
    readonly findings: readonly CheckFinding[];
    readonly summary: { readonly pass: string; readonly warn?: string; readonly fail?: string };
    readonly figures?: readonly CheckFigure[];
    readonly status?: CheckStatus;
  },
): CheckResult {
  const meta = CHECKS[id];
  const ordered = [
    ...input.findings.filter((f) => f.level === "fail"),
    ...input.findings.filter((f) => f.level === "warn"),
  ];
  const status = input.status ?? statusOf(ordered);
  const summary =
    status === "fail"
      ? (input.summary.fail ?? input.summary.pass)
      : status === "warn"
        ? (input.summary.warn ?? input.summary.pass)
        : input.summary.pass;
  return {
    id,
    status,
    title: meta.title,
    summary,
    findings: ordered.slice(0, MAX_FINDINGS),
    more: Math.max(0, ordered.length - MAX_FINDINGS),
    figures: input.figures ?? [],
    link: meta.link,
    linkLabel: meta.linkLabel,
  };
}

/** Inget att kontrollera (t.ex. ingen Awish-koppling). */
export function skipped(id: SelfCheckId, summary: string): CheckResult {
  return resultOf(id, { findings: [], summary: { pass: summary }, status: "skip" });
}

/** Kontrollen kunde inte köras (fel vid inläsningen): räknas som fel. */
export function crashed(id: SelfCheckId, message: string): CheckResult {
  return resultOf(id, {
    findings: [{ level: "fail", text: `Kontrollen kunde inte köras: ${message}` }],
    summary: { pass: "", fail: "Kontrollen kunde inte köras." },
  });
}

/** 12 480,50 kr */
export function kr(ore: number): string {
  return formatKronor(ore / 100);
}

/** 23,8 % (eller "–" utan marginal). */
export function pct(bp: number | null): string {
  return bp === null ? "–" : formatMarginBp(bp);
}

/** "1 fel", "3 fel" / "1 varning", "2 varningar" */
export function countText(n: number, one: string, many: string): string {
  return `${n}${NBSP}${n === 1 ? one : many}`;
}

/** Skillnad med tecken: "+50,00 kr", "−12,00 kr". */
export function diffKr(ore: number): string {
  const s = kr(Math.abs(ore));
  return ore < 0 ? `${MINUS}${s}` : `+${s}`;
}

/** Ental eller plural efter antalet. */
export function plural(n: number, one: string, many: string): string {
  return n === 1 ? one : many;
}
