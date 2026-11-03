"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";
import { formatInt } from "@/lib/format";
import type { ArchiveRow, RecipientRow } from "@/server/reports/service";

import { approveReport, sendReport } from "../actions";
import { ReportStatusTag } from "./report-status";
import { TextArea } from "./text-area";
import { when } from "./when";

const FILES: Record<ArchiveRow["type"], { kind: string; label: string }[]> = {
  butik: [{ kind: "pdf", label: "PDF" }],
  bokforing: [
    { kind: "pdf", label: "PDF" },
    { kind: "xlsx", label: "Excel" },
    { kind: "sie", label: "SIE 4" },
  ],
  delagare: [{ kind: "pdf", label: "PDF" }],
};

const DELIVERY_STATUS = {
  queued: { tag: "neutral", label: "Köad" },
  sent: { tag: "ok", label: "Skickad" },
  delivered: { tag: "ok", label: "Levererad" },
  failed: { tag: "critical", label: "Misslyckades" },
  bounced: { tag: "critical", label: "Studsade" },
} as const;

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col gap-1">
      <dt className="label text-subtle">{label}</dt>
      <dd className="text-base text-fg">{children}</dd>
    </div>
  );
}

/**
 * Granskning och utskick av den senaste versionen för valet: status, filer, godkännande
 * och mottagare. Inget kan skickas förrän rapporten är godkänd (kontrolleras också på
 * servern). Utskicken loggas och syns i ändringsloggen.
 */
export function ReviewPanel({
  report,
  recipients,
  canEdit,
  mailConfigured,
  timeZone,
}: {
  report: ArchiveRow;
  recipients: readonly RecipientRow[];
  canEdit: boolean;
  mailConfigured: boolean;
  timeZone: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const textId = useId();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const deliveredTo = new Set(
    report.deliveries
      .filter((d) => d.status === "sent" || d.status === "delivered" || d.status === "queued")
      .map((d) => d.recipientId),
  );
  const [chosen, setChosen] = useState<Set<string>>(
    () => new Set(recipients.filter((r) => !deliveredTo.has(r.id)).map((r) => r.id)),
  );
  const [followText, setFollowText] = useState("");

  const approved = report.status === "approved" || report.status === "sent";

  function approve() {
    setError(null);
    start(async () => {
      const result = await approveReport({ reportId: report.id });
      if (!result.ok) return setError(result.error);
      toast({ title: "Rapporten är godkänd", description: "Nu kan den skickas.", tone: "ok" });
      router.refresh();
    });
  }

  function send() {
    setError(null);
    const ids = [...chosen];
    start(async () => {
      const resend = ids.some((id) => deliveredTo.has(id));
      const result = await sendReport({
        reportId: report.id,
        recipientIds: ids,
        followText: followText.trim() || null,
        resend,
      });
      if (!result.ok) return setError(result.error);
      const { sent, failed } = result.data;
      // Valet töms efter utskicket: bara de som misslyckades står kvar, så att ett nytt
      // klick inte skickar rapporten en gång till till dem som just fått den.
      const failedEmails = new Set(failed.map((f) => f.email.toLowerCase()));
      setChosen(
        new Set(
          ids.filter((id) => {
            const r = recipients.find((x) => x.id === id);
            return r !== undefined && failedEmails.has(r.email.toLowerCase());
          }),
        ),
      );
      if (failed.length === 0) setFollowText("");
      if (failed.length > 0) {
        setError(
          `${formatInt(failed.length)} utskick misslyckades: ${failed.map((f) => `${f.email} (${f.error})`).join(", ")}`,
        );
      }
      if (sent > 0) {
        toast({
          title: sent === 1 ? "Rapport skickad" : `${formatInt(sent)} rapporter skickade`,
          description: mailConfigured ? undefined : "Sparad i den lokala utkorgen.",
          tone: "ok",
        });
      }
      router.refresh();
    });
  }

  return (
    <div className="grid grid-cols-1 gap-x-8 gap-y-8 lg:grid-cols-12">
      <dl className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-4 self-start border-t border-line pt-4 lg:col-span-5">
        <Fact label="Status">
          <ReportStatusTag status={report.status} />
        </Fact>
        <Fact label="Skapad">
          <span className="tnum">{when(report.generatedAt, timeZone)}</span>
          {report.generatedBy ? (
            <span className="block text-sm text-muted">{report.generatedBy}</span>
          ) : null}
        </Fact>
        <Fact label="Godkänd">
          {report.approvedAt ? (
            <>
              <span className="tnum">{when(report.approvedAt, timeZone)}</span>
              {report.approvedBy ? (
                <span className="block text-sm text-muted">{report.approvedBy}</span>
              ) : null}
            </>
          ) : (
            <span className="text-muted">Inte än</span>
          )}
        </Fact>
        <Fact label="Beräkningsversion">
          <span className="tnum font-mono text-sm">{report.calcVersion}</span>
        </Fact>
        <div className="col-span-2 flex flex-wrap items-center gap-2">
          <a
            href={`/rapport/${report.id}`}
            className="inline-flex h-7 items-center rounded-sm border border-line-strong bg-surface px-2.5 text-sm text-fg transition-colors duration-fast ease-instrument hover:border-line-control hover:bg-hover"
          >
            Öppna
          </a>
          <a
            href={`/rapport/${report.id}/epost`}
            className="inline-flex h-7 items-center rounded-sm border border-line-strong bg-surface px-2.5 text-sm text-fg transition-colors duration-fast ease-instrument hover:border-line-control hover:bg-hover"
          >
            Mejlet
          </a>
          {FILES[report.type].map((f) => (
            <a
              key={f.kind}
              href={`/rapport/${report.id}/fil/${f.kind}`}
              className="inline-flex h-7 items-center gap-1.5 rounded-sm border border-line-strong bg-surface px-2.5 text-sm text-fg transition-colors duration-fast ease-instrument hover:border-line-control hover:bg-hover"
            >
              {f.label}
            </a>
          ))}
        </div>
      </dl>

      <div className="flex min-w-0 flex-col gap-5 lg:col-span-7">
        {report.status === "draft" ? (
          canEdit ? (
            <div className="flex flex-col gap-3 border-t border-line pt-4">
              <p className="text-base text-muted">Läs förhandsvisningen, godkänn sedan.</p>
              <div>
                <Button variant="primary" onClick={approve} loading={pending} iconLeft="check">
                  Godkänn för utskick
                </Button>
              </div>
            </div>
          ) : (
            <p className="border-t border-line pt-4 text-base text-muted">
              Väntar på ägarens godkännande.
            </p>
          )
        ) : null}

        {approved && !report.hasPdf ? (
          <StateMessage
            kind="error"
            compact
            message="PDF:en saknas."
            detail={canEdit ? "Butiken ser den inte förrän den skapats." : undefined}
            action={
              canEdit ? { label: "Skapa PDF →", href: `/rapport/${report.id}/fil/pdf` } : undefined
            }
            className="px-0"
          />
        ) : null}

        {approved && canEdit ? (
          recipients.length === 0 ? (
            <StateMessage
              kind="empty"
              compact
              message="Ingen mottagare för rapporten."
              action={{ label: "Lägg till mottagare →", href: "/rapporter?vy=mottagare" }}
            />
          ) : (
            <fieldset className="flex flex-col gap-4 border-t border-line pt-4">
              <legend className="label mb-3 text-muted">Skicka till</legend>
              <ul className="flex flex-col divide-y divide-line">
                {recipients.map((r) => {
                  const id = `${textId}-${r.id}`;
                  return (
                    <li key={r.id} className="flex min-h-11 items-center gap-3 py-2">
                      <input
                        id={id}
                        type="checkbox"
                        className="size-4 shrink-0 accent-[var(--bl-fg)]"
                        checked={chosen.has(r.id)}
                        onChange={(e) => {
                          const next = new Set(chosen);
                          if (e.target.checked) next.add(r.id);
                          else next.delete(r.id);
                          setChosen(next);
                        }}
                      />
                      <label htmlFor={id} className="flex min-w-0 flex-1 flex-col">
                        <span className="truncate text-base text-fg">{r.name}</span>
                        <span className="meta truncate text-subtle">{r.email}</span>
                      </label>
                      {deliveredTo.has(r.id) ? (
                        <StatusTag status="ok">Har fått den</StatusTag>
                      ) : null}
                    </li>
                  );
                })}
              </ul>
              <TextArea
                id={textId}
                label="Följetext"
                hint="Valfri."
                value={followText}
                maxLength={1000}
                rows={3}
                onChange={(e) => setFollowText(e.target.value)}
              />
              <div className="flex flex-wrap items-center gap-3">
                <Button
                  variant="primary"
                  onClick={send}
                  loading={pending}
                  disabled={chosen.size === 0}
                  iconLeft="external"
                >
                  {chosen.size === 0
                    ? "Välj mottagare"
                    : `Skicka till ${formatInt(chosen.size)} mottagare`}
                </Button>
                {[...chosen].some((id) => deliveredTo.has(id)) ? (
                  <span className="text-sm text-muted">
                    Någon har redan fått den och får den igen.
                  </span>
                ) : null}
              </div>
            </fieldset>
          )
        ) : null}

        {error ? <StateMessage kind="error" compact message={error} className="px-0" /> : null}

        {report.deliveries.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h3 className="label text-muted">Utskick</h3>
            <ul className="flex flex-col divide-y divide-line border-y border-line">
              {[...report.deliveries].reverse().map((d) => {
                const s = DELIVERY_STATUS[d.status];
                return (
                  <li
                    key={d.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2"
                  >
                    <span className="min-w-0 truncate text-base text-fg">{d.email}</span>
                    <StatusTag status={s.tag}>{s.label}</StatusTag>
                    <span className="meta text-subtle">
                      {when(d.sentAt ?? d.createdAt, timeZone)}
                    </span>
                    {d.error ? (
                      <span className="col-span-2 text-sm text-muted">{d.error}</span>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          </div>
        ) : null}
      </div>
    </div>
  );
}
