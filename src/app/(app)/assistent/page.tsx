import type { Metadata } from "next";

import { FoldCard } from "@/app/(app)/installningar/_components/fold-card";
import "@/app/(app)/installningar/_components/settings.css";
import { Badge } from "@/components/v2/badge";
import { Card, CardBody } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { KeyValues } from "@/components/v2/key-values";
import { V2Page } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
import { formatInt, formatRelative } from "@/lib/format";
import { getAssistantConfig } from "@/server/assistant/config";
import {
  countFor,
  listRecentFor,
  loadConversationFor,
  type LogRecord,
} from "@/server/assistant/log";
import { toolsForRole } from "@/server/assistant/tools";
import { loadContext } from "@/server/data/core";
import { requireUser } from "@/server/session";

import { loadAdvisorStateFor } from "@/server/assistant/advisor/service";
import { getActiveOrganization } from "@/server/session";

import { AssistantChat } from "./_components/assistant-chat";
import { Suggestions } from "./_components/suggestions";
import { AnswerText, Evidence, VerificationLine } from "./_components/evidence";

export const metadata: Metadata = { title: "Assistent" };

/** Vad varje verktyg räknar, för användaren (modellen läser verktygens egna beskrivningar). */
const TOOL_ABOUT: Record<string, string> = {
  nyckeltal: "Intäkt, vinst, marginal och order för en period, mot perioden före.",
  lonsamhet: "Lönsamhet per automat, butik, titel, månad, vecka eller dag.",
  iakttagelser: "Det som sticker ut i perioden, med regel och underlag.",
  inkopsforslag: "Vad som ska beställas i dag, hur mycket och när, utifrån prognos och lager.",
  prognos: "Försäljningsprognos för de kommande fyra veckorna, med intervall.",
  salda_pack: "Sålda pack per titel, automat eller dag.",
  lager: "Lagersaldo i automater och våra lager just nu.",
  rackvidd: "Hur många dagar lagret i varje automat räcker vid nuvarande takt.",
  att_gora: "Punkterna i Att göra, mest brådskande först.",
  hitta: "Automater, butiker och titlar med namn och kod.",
  forandring: "Varför vinsten ändrades: mot perioden före, per automat, butik eller titel.",
  butiksandel: "Vad butikerna får enligt avtalet, per månad och i snitt.",
  inkopspriser: "Inköpspris, vad varje order lämnar och marginal per titel.",
  tid_monster: "Försäljning per timme och veckodag.",
  slutsalt: "Vad slutsålda fack kostade i förlorad försäljning.",
  vart_lager: "Vårt lager hemma: pack, räckvidd och veckans behov.",
  besoksplan: "Veckans besök och packlistor, i ordning.",
  automat_status: "Status per automat: i drift, tyst, fel.",
  avtal: "Avtalen: villkor, slutdatum och uppsägning.",
  bokforing: "Bokföringens månader: klara, skickade, siffror.",
  synk: "Hämtningen från Awish: status och senaste gången.",
  foresla_knapp: "Knappar till rätt sida för nästa steg (ändrar inget).",
};

const ECONOMY_EXAMPLES = [
  "Vilken automat tjänade mest i oktober?",
  "Vad ska jag beställa inför nästa vecka?",
  "Hur gick förra veckan jämfört med veckan innan?",
  "Vilka titlar har lägst marginal de senaste 30 dagarna?",
];
const REFILLER_EXAMPLES = [
  "Vad behöver fyllas på i dag?",
  "Hur många pack finns kvar i BL-002?",
  "Vilka titlar sålde mest förra veckan?",
];

const STATUS_LABEL: Record<LogRecord["status"], { status: "ok" | "warning"; text: string }> = {
  answered: { status: "ok", text: "Kontrollerat" },
  unverified: { status: "warning", text: "Tal saknas i underlaget" },
  refused: { status: "warning", text: "Avböjd" },
  limit: { status: "warning", text: "Avbruten" },
  error: { status: "warning", text: "Fel" },
};

/**
 * Assistenten: frågor på svenska som besvaras med verktyg som räknar ur beräkningslagret
 * (aldrig fri SQL), med underlag och kontroll av talen. Alla roller; påfyllaren får bara
 * lagerverktyg (urvalet görs på servern, i src/server/assistant).
 */
export default async function AssistentPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const [ctx, user, organization, sp] = await Promise.all([
    loadContext(),
    requireUser(),
    getActiveOrganization(),
    searchParams,
  ]);
  // "Fråga assistenten" från ett förslag: frågan fylls i, skickas inte.
  const prefill = typeof sp.fraga === "string" ? sp.fraga.slice(0, 2000) : "";
  // "Öppna i Assistent" från AI-panelen: samma samtal (bara användarens egna rader, under RLS).
  const samtal =
    typeof sp.samtal === "string" && /^[0-9a-f-]{36}$/i.test(sp.samtal)
      ? sp.samtal.toLowerCase()
      : null;
  const config = getAssistantConfig();
  const tools = toolsForRole(ctx.role);
  // Bara rader som rollen får se nu (en nedgraderad användare ser inte gamla ekonomisvar).
  const [recent, asked, advisor, earlier] = await Promise.all([
    listRecentFor(user, ctx.organization.id, 10, { role: ctx.role }),
    countFor(user, ctx.organization.id, { role: ctx.role }),
    organization ? loadAdvisorStateFor({ user, organization }) : Promise.resolve(null),
    samtal
      ? loadConversationFor(user, ctx.organization.id, samtal, { role: ctx.role })
      : Promise.resolve([]),
  ]);
  const ready = config.status === "ready";
  const local = ready && config.provider === "local";
  const modelLabel = ready ? (local ? "lokal testmodell" : config.model) : "–";

  const verified = recent.filter((r) => r.status === "answered").length;
  const title = ready ? "Fråga om er data." : "Assistenten är av.";
  const aside = !ready
    ? config.status === "not-configured"
      ? "Kräver nyckel till Claude API."
      : `${config.variable} har ett ogiltigt värde.`
    : undefined;

  const notConfigured = ready
    ? null
    : config.status === "not-configured"
      ? {
          // Rubriken säger redan varför; här bara vad som gäller i rutan.
          message: "Frågor går inte än.",
          detail: "",
        }
      : { message: config.message, detail: "Rätta värdet och starta om servern." };

  return (
    <V2Page
      title="Assistent"
      sub={
        <>
          <b>{title}</b> {aside ? `${aside} ` : null}
          {`Modell ${modelLabel}`}
          {recent.length > 0
            ? ` · ${formatInt(verified)} av ${formatInt(recent.length)} kontrollerade`
            : ""}
          .
        </>
      }
    >
      <SubNav />
      <div className="v2-cols">
        <div className="v2-stack">
          <Card title={<span id="fraga">Fråga</span>}>
            <CardBody>
              <AssistantChat
                ready={ready}
                local={local}
                modelLabel={modelLabel}
                examples={ctx.canSeeEconomy ? ECONOMY_EXAMPLES : REFILLER_EXAMPLES}
                notConfigured={notConfigured}
                initialQuestion={prefill}
                initialConversationId={earlier.length > 0 ? samtal : null}
                initialTurns={earlier.map((e) => ({ question: e.question, answer: e.answer }))}
              />
            </CardBody>
          </Card>

          {advisor ? (
            <Card
              title={<span id="forslag">Förslag</span>}
              actions={
                <span className="lk">
                  {advisor.lastRun
                    ? `Körd ${formatRelative(new Date(advisor.lastRun.createdAt))}`
                    : "Varje morgon"}
                </span>
              }
            >
              <CardBody>
                <Suggestions
                  items={advisor.suggestions}
                  manualLeft={advisor.manualLeft}
                  canGenerate={ready && !local}
                  emptyText={
                    advisor.staleCount > 0
                      ? "Priser eller inställningar har ändrats. Nya förslag kommer i morgon bitti."
                      : "Inga förslag just nu."
                  }
                />
              </CardBody>
            </Card>
          ) : null}

          <Card
            title={<span id="logg">Dina frågor</span>}
            actions={
              <span className="lk">
                {recent.length === 0
                  ? `${formatInt(asked)} frågor`
                  : `Senast ${formatRelative(new Date(recent[0]!.createdAt))}`}
              </span>
            }
          >
            {recent.length > 0 ? (
              <ol className="st-list">
                {recent.map((r) => (
                  <li key={r.id} className="!py-0">
                    <details className="group">
                      <summary className="flex min-h-11 cursor-pointer list-none flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6 [&::-webkit-details-marker]:hidden">
                        <span className="min-w-0 text-v2-md font-[550] break-words text-v2-ink">
                          {r.question}
                        </span>
                        <span className="flex shrink-0 items-center gap-3">
                          <Badge
                            tone={STATUS_LABEL[r.status].status === "ok" ? "success" : "warning"}
                          >
                            {STATUS_LABEL[r.status].text}
                          </Badge>
                          <span className="text-v2-xs text-v2-mute tabular-nums">
                            {formatRelative(new Date(r.createdAt))}
                          </span>
                        </span>
                      </summary>
                      <div className="flex flex-col gap-4 pb-4">
                        {r.answer ? (
                          <AnswerText text={r.answer} unverified={r.verification.unverified} />
                        ) : (
                          <p className="st-p">{r.error ?? "Inget svar."}</p>
                        )}
                        {r.status === "answered" || r.status === "unverified" ? (
                          <VerificationLine verification={r.verification} />
                        ) : null}
                        <div className="flex flex-col gap-1">
                          <span className="v2-lab">Underlag · {r.model}</span>
                          <Evidence calls={r.toolCalls.map((c) => ({ ...c, done: c }))} />
                        </div>
                      </div>
                    </details>
                  </li>
                ))}
              </ol>
            ) : (
              <Empty title="Inga frågor ännu.">Det du frågar sparas här, bara för dig.</Empty>
            )}
          </Card>
        </div>

        <div className="v2-stack">
          <Card
            id="installning"
            className="scroll-mt-24"
            title={<span id="installning-rubrik">{ready ? "Ansluten" : "Inte ansluten"}</span>}
            actions={<Badge tone={ready ? "success" : "neutral"}>{ready ? "På" : "Av"}</Badge>}
          >
            <CardBody className="flex flex-col gap-3">
              <p className="st-p">
                {ready
                  ? local
                    ? "Lokal testmodell utan AI (bara i utveckling)."
                    : `Claude API med ${config.model}.`
                  : "Nyckeln sätts i miljövariablerna, aldrig i appen."}
              </p>
              {/* Variabelnamnen är för driften: bakom "Visa detaljer", inte i sidans första läsning. */}
              <details className="group text-v2-sm">
                <summary className="inline-flex min-h-11 cursor-pointer list-none items-center gap-1 text-v2-mute transition-colors hover:text-v2-ink [&::-webkit-details-marker]:hidden">
                  <span aria-hidden className="text-v2-faint group-open:rotate-90">
                    ›
                  </span>
                  Visa detaljer för driften
                </summary>
                <KeyValues
                  className="mt-1"
                  items={[
                    {
                      label: "ASSISTANT_PROVIDER",
                      value: ready
                        ? config.provider
                        : (process.env.ASSISTANT_PROVIDER ?? "anthropic"),
                    },
                    {
                      label: "ANTHROPIC_API_KEY",
                      value: process.env.ANTHROPIC_API_KEY?.trim() ? "satt" : "saknas",
                    },
                    {
                      label: "ANTHROPIC_MODEL",
                      value: process.env.ANTHROPIC_MODEL?.trim() || "claude-opus-5-5 (standard)",
                    },
                  ]}
                />
              </details>
            </CardBody>
          </Card>

          <FoldCard id="verktyg" title="Verktyg" aside={`${formatInt(tools.length)} st`}>
            <ul className="st-list">
              {tools.map((t) => (
                <li key={t.name} className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-v2-md font-[550] text-v2-ink">{t.title}</span>
                  <span className="text-v2-sm text-v2-mute">{TOOL_ABOUT[t.name] ?? ""}</span>
                </li>
              ))}
            </ul>
          </FoldCard>
        </div>
      </div>
    </V2Page>
  );
}
