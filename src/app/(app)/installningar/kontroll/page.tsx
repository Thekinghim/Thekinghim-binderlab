import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";

import type { CheckResult, CheckStatus } from "@/analytics/self-check";
import { wallClockIn } from "@/components/shell/period-state";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag, type Status } from "@/components/ui/status-tag";
import { formatDateTime, formatDuration } from "@/lib/format";
import { requireRoute, requireViewer } from "@/server/data/core";
import { loadSelfCheckFor } from "@/server/self-check/service";

import { MerHead } from "../_components/mer-head";
import { RunSelfCheckButton } from "./run-button";

export const metadata: Metadata = { title: "Kontroll" };

// "Kör kontrollen nu" kör alla kontroller i en server action (normalt några sekunder).
export const maxDuration = 60;

const CHECK_TAG: Record<CheckStatus, { status: Status; label: string }> = {
  pass: { status: "ok", label: "Stämmer" },
  warn: { status: "warning", label: "Varning" },
  fail: { status: "critical", label: "Fel" },
  skip: { status: "neutral", label: "Inget att kontrollera" },
};

const RUN_LABEL = {
  ok: "Allt stämmer",
  warning: "Bara varningar",
  failed: "Fel hittade",
  error: "Kunde inte köras",
} as const;

function rise(i: number): CSSProperties {
  return { "--i": i } as CSSProperties;
}

function CheckCard({ check }: { check: CheckResult }) {
  const tag = CHECK_TAG[check.status];
  const shown = check.findings;
  return (
    <li
      className="flex flex-col gap-3 border-t border-line py-5 first:border-t-0 md:py-6"
      data-check={check.id}
      data-status={check.status}
    >
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h3 className="text-lg font-medium text-fg">{check.title}</h3>
        <StatusTag status={tag.status}>{tag.label}</StatusTag>
      </div>
      <p className="max-w-[72ch] text-base text-muted">{check.summary}</p>
      {shown.length > 0 ? (
        <ul className="flex max-w-[80ch] flex-col gap-1.5 text-sm">
          {shown.map((f, i) => (
            <li key={i} className="flex gap-2">
              <span
                aria-hidden
                className={
                  f.level === "fail"
                    ? "mt-1.5 inline-block size-2 shrink-0 bg-signal"
                    : "mt-1.5 inline-block size-2 shrink-0 border border-line-control"
                }
              />
              <span className="min-w-0 break-words text-fg">
                <span className="sr-only">{f.level === "fail" ? "Fel: " : "Varning: "}</span>
                {f.text}
                {f.link && f.link !== check.link ? (
                  <>
                    {" "}
                    <Link href={f.link} className="text-muted underline underline-offset-2">
                      Rätta
                    </Link>
                  </>
                ) : null}
              </span>
            </li>
          ))}
          {check.more > 0 ? <li className="text-muted">Och {check.more} till.</li> : null}
        </ul>
      ) : null}
      {check.status === "fail" || check.status === "warn" ? (
        <div>
          <Link
            href={check.link}
            className="inline-flex h-9 items-center gap-2 rounded-sm border border-line-strong bg-surface px-3.5 text-base text-fg hover:bg-hover max-md:min-h-11"
          >
            Till {check.linkLabel}
            <span aria-hidden className="text-faint">
              →
            </span>
          </Link>
        </div>
      ) : null}
    </li>
  );
}

/**
 * Daglig kontroll: Binderlab kontrollerar sina egna siffror varje morgon (05:37) och när
 * ägaren eller admin trycker "Kör kontrollen nu". Varje kontroll grön eller röd med en
 * förklaring och länk till sidan där det rättas. Ägare och admin (requireRoute skickar
 * andra till sin startsida; loadSelfCheckFor kontrollerar rollen igen mot databasen).
 */
export default async function SelfCheckPage() {
  const ctx = await requireRoute("installningar");
  const data = await loadSelfCheckFor(await requireViewer());
  const tz = ctx.timeZone;
  const now = new Date(ctx.now);
  const when = (iso: string) =>
    formatDateTime(wallClockIn(new Date(iso), tz), { now: wallClockIn(now, tz) });
  const latest = data.latest;
  const failedChecks = latest?.checks.filter((c) => c.status === "fail").length ?? 0;
  const title = !latest
    ? "Kontrollen har inte körts än."
    : latest.status === "error"
      ? "Kontrollen kunde inte köras."
      : failedChecks > 0
        ? `${failedChecks} av ${latest.checks.length} kontroller hittade fel.`
        : `Alla ${latest.checks.length} kontroller stämmer.`;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 px-4 pt-8 pb-16 max-md:gap-6 md:gap-12 md:px-8 md:pt-12">
      <MerHead
        eyebrow="Kontroll"
        title={title}
        tone={latest ? (failedChecks > 0 || latest.status === "error" ? "bad" : "good") : undefined}
        line="Binderlab kontrollerar sina egna siffror varje morgon kl. 05:37. Kontrollen läser bara, den ändrar ingenting."
        meta={
          latest
            ? [
                {
                  label: "Senast",
                  value: `${when(latest.ranAt)} · ${latest.trigger === "manual" ? (latest.ranBy ?? "för hand") : "schemalagd"}`,
                },
                { label: "Tid", value: formatDuration(latest.durationMs) },
              ]
            : undefined
        }
        actions={<RunSelfCheckButton />}
      />

      {latest?.error ? (
        <div className="rise" style={rise(1)}>
          <StateMessage kind="error" message="Kontrollen kunde inte köras." detail={latest.error} />
        </div>
      ) : null}

      {latest && latest.checks.length > 0 ? (
        <section aria-labelledby="kontroller" className="rise flex flex-col gap-4" style={rise(2)}>
          <SectionHeader
            id="kontroller"
            size="md"
            title="Kontrollerna."
            aside={`${RUN_LABEL[latest.status]}.`}
          />
          <ul className="flex flex-col">
            {latest.checks.map((c) => (
              <CheckCard key={c.id} check={c} />
            ))}
          </ul>
        </section>
      ) : !latest ? (
        <div className="rise" style={rise(1)}>
          <StateMessage
            kind="empty"
            code="Inte körd"
            message="Ingen kontroll än."
            detail="Den första körs i morgon bitti, eller nu med knappen ovan."
          />
        </div>
      ) : null}

      {data.history.length > 1 ? (
        <section aria-labelledby="tidigare" className="rise flex flex-col gap-4" style={rise(3)}>
          <SectionHeader id="tidigare" size="md" title="Tidigare körningar." />
          <ul className="flex flex-col text-sm">
            {data.history.slice(1).map((r) => (
              <li
                key={r.id}
                className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 border-t border-line py-2.5"
              >
                <span className="text-fg">
                  {when(r.ranAt)}
                  <span className="text-muted">
                    {" "}
                    · {r.trigger === "manual" ? (r.ranBy ?? "för hand") : "schemalagd"}
                  </span>
                </span>
                <StatusTag
                  status={
                    r.status === "ok" ? "ok" : r.status === "warning" ? "warning" : "critical"
                  }
                >
                  {r.status === "failed" ? `${r.failed} fel` : RUN_LABEL[r.status]}
                </StatusTag>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
