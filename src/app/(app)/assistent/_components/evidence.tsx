/**
 * Svaret och underlaget, som de visas både i samtalet (strömmat) och i loggen.
 * Inga hooks: används av klientkomponenten och av sidan (serverkomponent).
 */

import Link from "next/link";
import { Fragment, type ReactNode } from "react";

import { StatusTag } from "@/components/ui/status-tag";
import { cn } from "@/lib/cn";
import { formatDuration, formatInt } from "@/lib/format";
import type { ToolCallRecord, Verification } from "@/server/assistant/protocol";
import { withToolHrefs } from "@/server/assistant/links";
import { extractNumbers } from "@/server/assistant/verify";

const linkCls =
  "text-fg underline decoration-line-control underline-offset-4 transition-[text-decoration-color] duration-fast hover:decoration-fg";

/** Parametrarna som "fran 2026-10-01 · till 2026-10-31 · per automat". */
function paramsText(input: Record<string, unknown>): string {
  const entries = Object.entries(input).filter(
    ([, v]) => v !== undefined && v !== null && v !== "",
  );
  return entries.length === 0
    ? "inga parametrar"
    : entries.map(([k, v]) => `${k} ${typeof v === "string" ? v : JSON.stringify(v)}`).join(" · ");
}

/** Markerar tal som inte fanns i underlaget: streckad understrykning och text för skärmläsare. */
function withMarks(text: string, unverified: readonly string[]): ReactNode {
  if (unverified.length === 0) return text;
  const tokens = new Set(extractNumbers(text).filter((t) => unverified.includes(t)));
  if (tokens.size === 0) return text;
  const pattern = new RegExp(
    `(${[...tokens].map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`,
    "g",
  );
  return text.split(pattern).map((part, i) =>
    tokens.has(part) ? (
      <span
        key={i}
        className="tnum underline decoration-line-control decoration-dashed underline-offset-4"
        title="Talet finns inte i underlaget"
      >
        {part}
        <span className="sr-only"> (finns inte i underlaget)</span>
      </span>
    ) : (
      <Fragment key={i}>{part}</Fragment>
    ),
  );
}

/**
 * Svarstexten: första stycket som huvudmening, rader som börjar med "- " som lista.
 */
export function AnswerText({
  text,
  unverified = [],
  className,
}: {
  text: string;
  unverified?: readonly string[];
  className?: string;
}) {
  const blocks: Array<{ kind: "p" | "ul"; lines: string[] }> = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const item = /^[-•*]\s+(.*)$/.exec(line);
    const kind = item ? "ul" : "p";
    const content = item ? item[1]! : line;
    const last = blocks[blocks.length - 1];
    if (last && last.kind === kind && kind === "ul") last.lines.push(content);
    else blocks.push({ kind, lines: [content] });
  }
  return (
    <div className={cn("flex max-w-3xl flex-col gap-3", className)}>
      {blocks.map((b, i) =>
        b.kind === "ul" ? (
          <ul key={i} className="flex flex-col gap-1.5 text-base text-muted">
            {b.lines.map((l, j) => (
              <li key={j} className="flex gap-2">
                <span aria-hidden className="text-faint">
                  –
                </span>
                <span className="min-w-0 break-words">{withMarks(l, unverified)}</span>
              </li>
            ))}
          </ul>
        ) : (
          <p
            key={i}
            className={cn(
              "text-balance break-words",
              i === 0 ? "text-md text-fg" : "text-base text-muted",
            )}
          >
            {withMarks(b.lines[0]!, unverified)}
          </p>
        ),
      )}
    </div>
  );
}

/** Raden under svaret: stämmer talen med underlaget? */
export function VerificationLine({ verification }: { verification: Verification }) {
  const { checked, unverified } = verification;
  if (unverified.length > 0) {
    return (
      <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
        <StatusTag status="warning">Kontrollera</StatusTag>
        <span>
          {unverified.length === 1
            ? `Talet ${unverified[0]} finns inte i underlaget.`
            : `${formatInt(unverified.length)} tal finns inte i underlaget: ${unverified.join(", ")}.`}{" "}
          Lita bara på talen som står i verktygens resultat nedan.
        </span>
      </p>
    );
  }
  return (
    <p className="flex flex-wrap items-center gap-2 text-sm text-muted">
      <StatusTag status="ok">Kontrollerat</StatusTag>
      <span>
        {checked === 0
          ? "Svaret innehåller inga tal."
          : checked === 1
            ? "Talet i svaret finns i underlaget."
            : `Alla ${formatInt(checked)} tal i svaret finns i underlaget.`}
      </span>
    </p>
  );
}

export type PendingCall = Pick<ToolCallRecord, "id" | "name" | "label" | "input"> & {
  readonly done?: ToolCallRecord;
};

/** Underlaget: varje verktygsanrop med parametrar, resultat, siffror och länkar. */
export function Evidence({
  calls,
  pending = false,
}: {
  calls: readonly PendingCall[];
  pending?: boolean;
}) {
  if (calls.length === 0) {
    return pending ? null : (
      <p className="meta text-subtle">Inga verktyg anropades: svaret bygger inte på någon data.</p>
    );
  }
  return (
    <ol className="flex flex-col">
      {calls.map((c, i) => {
        const r = c.done;
        return (
          <li key={c.id} className="flex min-w-0 flex-col gap-2 border-t border-line py-4">
            <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
              <span className="label text-muted">
                <span className="tnum text-fg">{String(i + 1).padStart(2, "0")}</span>
                <span className="text-faint"> / </span>
                {r?.label ?? c.label}
              </span>
              <span className="meta flex items-center gap-2 text-subtle">
                {r ? (
                  r.ok ? (
                    <span className="tnum">{formatDuration(r.durationMs)}</span>
                  ) : (
                    <StatusTag status="warning">Fel i anropet</StatusTag>
                  )
                ) : (
                  <span aria-live="polite">räknar…</span>
                )}
              </span>
            </div>
            <p className="meta break-words text-subtle">
              <span className="sr-only">Parametrar: </span>
              {c.name}({paramsText(r?.input ?? c.input)})
            </p>
            {r ? (
              <>
                <p className="max-w-3xl text-sm break-words text-fg">{r.summary}</p>
                {r.figures.length > 0 ? (
                  <dl className="flex max-w-3xl flex-col">
                    {r.figures.map((f, j) => (
                      <div
                        key={j}
                        className="flex min-w-0 items-baseline justify-between gap-3 border-b border-line py-1"
                      >
                        <dt className="min-w-0 text-sm break-words text-muted">{f.label}</dt>
                        <dd className="tnum shrink-0 text-right text-sm text-fg">{f.value}</dd>
                      </div>
                    ))}
                  </dl>
                ) : null}
                <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                  {withToolHrefs(r.links).map((l) => (
                    <Link key={l.href + l.label} href={l.href} className={cn("text-sm", linkCls)}>
                      {l.label} →
                    </Link>
                  ))}
                  {r.result !== undefined ? (
                    <details className="w-full min-w-0">
                      <summary className="meta w-fit cursor-pointer text-subtle hover:text-fg">
                        Visa resultatet som modellen fick
                      </summary>
                      <pre className="meta mt-2 max-h-80 overflow-auto rounded-sm border border-line bg-bg p-3 break-words whitespace-pre-wrap text-muted">
                        {JSON.stringify(r.result, null, 2)}
                      </pre>
                    </details>
                  ) : null}
                </div>
              </>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
