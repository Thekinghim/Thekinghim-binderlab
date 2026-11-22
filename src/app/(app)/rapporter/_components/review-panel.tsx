"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { ButtonLink } from "@/components/v2/button";
import { Notice } from "@/components/v2/notice";
import { StatusTag } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";
import { formatInt, formatSek } from "@/lib/format";
import { AGREEMENT_MISSING_MESSAGE } from "@/reports/store-basis";
import type { ArchiveRow, RecipientRow, StaleDraft } from "@/server/reports/service";

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

/** Bokföringsunderlagets SIE är ett underlag: bokhållaren importerar månadspaketet. */
export const UNDERLAG_TEXT =
  "SIE-filen här är ett underlag, inte för import. Bokhållaren importerar månadspaketet under";

const DELIVERY_STATUS = {
  queued: { tag: "neutral", label: "Köad" },
  sent: { tag: "ok", label: "Skickad" },
  delivered: { tag: "ok", label: "Levererad" },
  failed: { tag: "critical", label: "Misslyckades" },
  bounced: { tag: "critical", label: "Studsade" },
} as const;

function Fact({
  label,
  children,
  className,
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`flex min-w-0 flex-col gap-1 ${className ?? ""}`}>
      <dt className="v2-lab">{label}</dt>
      <dd className="text-v2-md text-v2-ink">{children}</dd>
    </div>
  );
}

/**
 * Granskning och utskick av den senaste versionen för valet: status, filer, godkännande
 * och mottagare. Inget kan skickas förrän rapporten är godkänd (kontrolleras också på
 * servern). Utskicken loggas och syns i ändringsloggen. En äldre butiksrapport (gamla
 * mallen, `report.legacy`) kan inte godkännas eller skickas: en ny version skapas först.
 */
export function ReviewPanel({
  report,
  stale = null,
  recipients,
  canEdit,
  mailConfigured,
  shareMode = false,
  timeZone,
}: {
  /** Dela-läget (ingen e-post): mottagarna och "Skicka till" visas inte; Dela står överst. */
  shareMode?: boolean;
  report: ArchiveRow;
  /** Utkastets siffror stämmer inte längre: godkänn är låst tills en ny version finns. */
  stale?: StaleDraft | null;
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
  // Äldre rapport (gamla mallen): visas kort, men skickas först som ny version.
  const legacy = report.legacy;
  // Butiksrapporten som underlag för butikens bokföring: saknar rapporten vårt företagsnamn
  // eller organisationsnummer (eller hela blocket, en rapport från före det fanns) räcker
  // den inte för butikens revisor. Varnar tills den är skickad; godkännandet låses inte.
  const gaps = report.type === "butik" && report.status !== "sent" ? report.basisGaps : undefined;
  const basisWarning =
    legacy || gaps === undefined || (gaps !== null && gaps.length === 0)
      ? null
      : gaps === null
        ? {
            message: "Rapporten visar inte vilket bolag som betalar.",
            detail: canEdit
              ? "Butikens revisor behöver det. Skapa ny version ovan."
              : "Butikens revisor behöver det.",
            action: undefined,
          }
        : {
            message: `Rapporten saknar ${gaps.join(" och ")}.`,
            detail: canEdit
              ? "Butikens revisor behöver veta vilket bolag som betalar. Fyll i under Inställningar och skapa sedan en ny version."
              : "Butikens revisor behöver veta vilket bolag som betalar.",
            action: canEdit
              ? { label: "Öppna Inställningar →", href: "/installningar#foretaget" }
              : undefined,
          };

  // Rapporten säger inte vilket avtal som gäller: avtalsformen är inte vald för butiken och
  // inget undertecknat kontrakt gäller perioden. Varnar tills den är skickad; låser inget.
  const agreementWarning =
    !legacy && report.type === "butik" && report.status !== "sent" && report.agreementMissing
      ? {
          message: `${AGREEMENT_MISSING_MESSAGE}.`,
          detail: canEdit
            ? "Välj Skriftligt avtal eller Muntligt avtal för butiken och skapa sedan en ny version."
            : "Butikens revisor behöver veta vilket avtal ersättningen vilar på.",
          action:
            canEdit && report.storeId
              ? {
                  label: "Välj avtalsform →",
                  href: `/butiker/${encodeURIComponent(report.storeId)}?vy=kontakt#avtalsform`,
                }
              : undefined,
        }
      : null;

  // Rapporten har inte butikens bolag (butiken har ingen ägare): butikens revisor behöver
  // bolagets juridiska namn och org.nr. Varnar tills den är skickad; låser inget.
  const recipientWarning =
    !legacy && report.type === "butik" && report.status !== "sent" && report.recipientMissing
      ? {
          message: "Rapporten visar inte butikens bolag.",
          detail: canEdit
            ? "Butikens revisor behöver bolagets namn och org.nr. Välj butikens ägare och skapa sedan en ny version."
            : "Butikens revisor behöver bolagets namn och org.nr.",
          action:
            canEdit && report.storeId
              ? {
                  label: "Välj ägare →",
                  href: `/butiker/${encodeURIComponent(report.storeId)}?vy=kontakt#agare`,
                }
              : undefined,
        }
      : null;

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
      <dl className="grid min-w-0 grid-cols-2 gap-x-6 gap-y-4 self-start border-t border-v2-line2 pt-4 lg:col-span-5">
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
        {/* Teknisk detalj: tar plats på telefonen utan att säga ägaren något. */}
        <Fact label="Beräkningsversion" className="max-md:hidden">
          <span className="tnum text-v2-sm">{report.calcVersion}</span>
        </Fact>
        <div className="col-span-2 flex flex-wrap items-center gap-2">
          <a href={`/rapport/${report.id}`} className="v2-btn sm touch">
            Öppna
          </a>
          <a hidden={shareMode} href={`/rapport/${report.id}/epost`} className="v2-btn sm touch">
            Mejlet
          </a>
          {FILES[report.type].map((f) => (
            <a
              key={f.kind}
              href={`/rapport/${report.id}/fil/${f.kind}`}
              className="v2-btn sm touch"
            >
              {f.label}
            </a>
          ))}
        </div>
        {report.type === "bokforing" ? (
          <p className="text-sm text-muted sm:col-span-2" data-which-sie>
            {UNDERLAG_TEXT}{" "}
            <a href="/ekonomi?vy=bokforing" className="text-fg underline underline-offset-4">
              Ekonomi → Bokföring
            </a>
          </p>
        ) : null}
      </dl>

      <div className="flex min-w-0 flex-col gap-5 lg:col-span-7">
        {legacy ? (
          <div className="border-t border-v2-line2 pt-4">
            <Warn
              message="Rapporten är gjord med den gamla mallen."
              detail={
                !canEdit
                  ? undefined
                  : shareMode
                    ? "Tryck Dela överst. Då skapas en ny, kort rapport."
                    : "Skapa ny version ovan. Den blir kort."
              }
            />
          </div>
        ) : report.status === "draft" && stale ? (
          <div className="border-t border-v2-line2 pt-4">
            <Warn
              message={
                stale.draftOre !== null && stale.nowOre !== null && stale.draftOre !== stale.nowOre
                  ? `Siffrorna har ändrats: ${formatSek(stale.draftOre / 100)} i utkastet, ${formatSek(stale.nowOre / 100)} nu.`
                  : "Rapporten har ändrats sedan utkastet skapades."
              }
              detail={canEdit ? "Skapa ny version ovan och godkänn den." : undefined}
            />
          </div>
        ) : report.status === "draft" ? (
          canEdit ? (
            <div className="flex flex-col gap-3 border-t border-v2-line2 pt-4">
              <p className="text-base text-muted">
                {shareMode
                  ? "Läs förhandsvisningen. Godkänn här, eller tryck Dela överst."
                  : "Läs förhandsvisningen, godkänn sedan."}
              </p>
              <div>
                <Button variant="primary" onClick={approve} loading={pending} iconLeft="check">
                  {shareMode ? "Godkänn" : "Godkänn för utskick"}
                </Button>
              </div>
            </div>
          ) : (
            <p className="border-t border-v2-line2 pt-4 text-base text-muted">
              Väntar på ägarens godkännande.
            </p>
          )
        ) : null}

        {basisWarning ? (
          <Warn
            message={basisWarning.message}
            detail={basisWarning.detail}
            action={basisWarning.action}
          />
        ) : null}

        {agreementWarning ? (
          <Warn
            message={agreementWarning.message}
            detail={agreementWarning.detail}
            action={agreementWarning.action}
          />
        ) : null}

        {recipientWarning ? (
          <Warn
            message={recipientWarning.message}
            detail={recipientWarning.detail}
            action={recipientWarning.action}
          />
        ) : null}

        {approved && !legacy && !report.hasPdf ? (
          <Warn
            message="PDF:en saknas."
            detail={canEdit ? "Butiken ser den inte förrän den skapats." : undefined}
            action={
              canEdit ? { label: "Skapa PDF →", href: `/rapport/${report.id}/fil/pdf` } : undefined
            }
          />
        ) : null}

        {approved && !legacy && canEdit && !shareMode ? (
          recipients.length === 0 ? (
            <Notice
              tone="info"
              title="Ingen mottagare för rapporten."
              action={
                <ButtonLink href="/rapporter?vy=mottagare" size="sm" touch>
                  Lägg till mottagare →
                </ButtonLink>
              }
            />
          ) : (
            <fieldset className="flex flex-col gap-4 border-t border-v2-line2 pt-4">
              <legend className="v2-lab mb-3">Skicka till</legend>
              <ul className="flex flex-col divide-y divide-v2-line2">
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

        {error ? <Warn message={error} /> : null}

        {report.deliveries.length > 0 ? (
          <div className="flex flex-col gap-2">
            <h3 className="v2-lab">Utskick</h3>
            <ul className="flex flex-col divide-y divide-v2-line2 border-y border-v2-line2">
              {[...report.deliveries].reverse().map((d) => {
                const s = DELIVERY_STATUS[d.status];
                return (
                  <li
                    key={d.id}
                    className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 py-2"
                  >
                    <span className="min-w-0 truncate text-base text-fg">
                      {d.email ?? "Delad för hand"}
                    </span>
                    <StatusTag status={s.tag}>{d.manual ? "Delad för hand" : s.label}</StatusTag>
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

/** Ett fel eller något som saknas i rapporten (V2-notis med en länk till åtgärden). */
function Warn({
  message,
  detail,
  action,
}: {
  message: string;
  detail?: string;
  action?: { label: string; href: string };
}) {
  return (
    <Notice
      tone="critical"
      title={message}
      action={
        action ? (
          <ButtonLink href={action.href} size="sm" touch>
            {action.label}
          </ButtonLink>
        ) : null
      }
    >
      {detail}
    </Notice>
  );
}
