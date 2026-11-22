import type { Metadata } from "next";
import Link from "next/link";

import type { CheckResult, CheckStatus } from "@/analytics/self-check";
import { wallClockIn } from "@/components/shell/period-state";
import { Badge, type BadgeTone } from "@/components/v2/badge";
import { ButtonLink } from "@/components/v2/button";
import { Card, CardBody } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { Notice } from "@/components/v2/notice";
import { V2Page } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
import { cn } from "@/lib/cn";
import { formatDateTime, formatDuration } from "@/lib/format";
import { requireRoute, requireViewer } from "@/server/data/core";
import { loadSelfCheckFor } from "@/server/self-check/service";

import "../_components/settings.css";
import { RunSelfCheckButton } from "./run-button";

export const metadata: Metadata = { title: "Kontroll" };

// "Kör kontrollen nu" kör alla kontroller i en server action (normalt några sekunder).
export const maxDuration = 60;

const CHECK_TAG: Record<CheckStatus, { tone: BadgeTone; label: string }> = {
  pass: { tone: "success", label: "Stämmer" },
  warn: { tone: "warning", label: "Varning" },
  fail: { tone: "critical", label: "Fel" },
  skip: { tone: "neutral", label: "Inget att kontrollera" },
};

const RUN_LABEL = {
  ok: "Allt stämmer",
  warning: "Bara varningar",
  failed: "Fel hittade",
  error: "Kunde inte köras",
} as const;

const RUN_TONE = {
  ok: "success",
  warning: "warning",
  failed: "critical",
  error: "critical",
} as const;

function CheckCard({ check }: { check: CheckResult }) {
  const tag = CHECK_TAG[check.status];
  const shown = check.findings;
  return (
    <li className="flex flex-col gap-2" data-check={check.id} data-status={check.status}>
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h3 className="text-v2-md font-[650] text-v2-ink">{check.title}</h3>
        <Badge tone={tag.tone}>{tag.label}</Badge>
      </div>
      <p className="st-p max-w-[72ch]">{check.summary}</p>
      {shown.length > 0 ? (
        <ul className="flex max-w-[80ch] flex-col gap-1.5 text-v2-sm">
          {shown.map((f, i) => (
            <li key={i} className="flex items-baseline gap-2">
              <span
                aria-hidden
                className={cn("v2-dot shrink-0", f.level === "fail" ? "critical" : "warning")}
              />
              <span className="min-w-0 break-words text-v2-ink">
                <span className="sr-only">{f.level === "fail" ? "Fel: " : "Varning: "}</span>
                {f.text}
                {f.link && f.link !== check.link ? (
                  <>
                    {" "}
                    <Link href={f.link} className="text-v2-mute underline underline-offset-2">
                      Rätta
                    </Link>
                  </>
                ) : null}
              </span>
            </li>
          ))}
          {check.more > 0 ? <li className="text-v2-mute">Och {check.more} till.</li> : null}
        </ul>
      ) : null}
      {check.status === "fail" || check.status === "warn" ? (
        <div className="pt-1">
          <ButtonLink href={check.link} touch>
            Till {check.linkLabel} <span aria-hidden>→</span>
          </ButtonLink>
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
  const bad = latest ? failedChecks > 0 || latest.status === "error" : false;
  const by = (r: { trigger: string; ranBy: string | null }) =>
    r.trigger === "manual" ? (r.ranBy ?? "för hand") : "schemalagd";

  return (
    <V2Page
      title="Kontroll"
      sub={
        <>
          <b className={bad ? "text-v2-crit-text" : undefined}>{title}</b>{" "}
          {latest
            ? `Senast ${when(latest.ranAt)} · ${by(latest)} · ${formatDuration(latest.durationMs)}.`
            : "Körs varje morgon kl. 05:37."}
        </>
      }
    >
      <SubNav />
      <div className="v2-cols">
        <div className="v2-stack">
          {latest?.error ? (
            <Notice tone="critical" title="Kontrollen kunde inte köras.">
              {latest.error}
            </Notice>
          ) : null}

          {latest && latest.checks.length > 0 ? (
            <Card
              title={<span id="kontroller">Kontrollerna</span>}
              actions={<Badge tone={RUN_TONE[latest.status]}>{RUN_LABEL[latest.status]}</Badge>}
            >
              <ul className="st-list" aria-labelledby="kontroller">
                {latest.checks.map((c) => (
                  <CheckCard key={c.id} check={c} />
                ))}
              </ul>
            </Card>
          ) : !latest ? (
            <Card>
              <Empty title="Ingen kontroll än.">
                Den första körs i morgon bitti, eller nu med knappen.
              </Empty>
            </Card>
          ) : null}
        </div>

        <div className="v2-stack">
          <Card title="Kör kontrollen">
            <CardBody className="flex flex-col gap-3">
              <p className="st-p">
                Binderlab kontrollerar sina egna siffror varje morgon kl. 05:37. Kontrollen läser
                bara, den ändrar ingenting.
              </p>
              <RunSelfCheckButton />
            </CardBody>
          </Card>

          {data.history.length > 1 ? (
            <Card title={<span id="tidigare">Tidigare körningar</span>}>
              <ul className="st-list text-v2-sm" aria-labelledby="tidigare">
                {data.history.slice(1).map((r) => (
                  <li
                    key={r.id}
                    className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1"
                  >
                    <span className="text-v2-ink tabular-nums">
                      {when(r.ranAt)}
                      <span className="text-v2-mute"> · {by(r)}</span>
                    </span>
                    <Badge tone={RUN_TONE[r.status]}>
                      {r.status === "failed" ? `${r.failed} fel` : RUN_LABEL[r.status]}
                    </Badge>
                  </li>
                ))}
              </ul>
            </Card>
          ) : null}
        </div>
      </div>
    </V2Page>
  );
}
