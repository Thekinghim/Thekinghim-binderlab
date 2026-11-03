import type { Metadata } from "next";

import { SectionHeader } from "@/components/ui/section-header";
import { StatusTag } from "@/components/ui/status-tag";
import { formatInt, formatRelative } from "@/lib/format";
import { getAssistantConfig } from "@/server/assistant/config";
import { countFor, listRecentFor, type LogRecord } from "@/server/assistant/log";
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
  lager: "Lagersaldo i automater och centrallager just nu.",
  rackvidd: "Hur många dagar lagret i varje automat räcker vid nuvarande takt.",
  att_gora: "Punkterna i Att göra, mest brådskande först.",
  hitta: "Automater, butiker och titlar med namn och kod.",
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
  const config = getAssistantConfig();
  const tools = toolsForRole(ctx.role);
  // Bara rader som rollen får se nu (en nedgraderad användare ser inte gamla ekonomisvar).
  const [recent, asked, advisor] = await Promise.all([
    listRecentFor(user, ctx.organization.id, 10, { role: ctx.role }),
    countFor(user, ctx.organization.id, { role: ctx.role }),
    organization ? loadAdvisorStateFor({ user, organization }) : Promise.resolve(null),
  ]);
  const ready = config.status === "ready";
  const local = ready && config.provider === "local";
  const modelLabel = ready ? (local ? "lokal testmodell" : config.model) : "–";

  const verified = recent.filter((r) => r.status === "answered").length;
  const title = ready ? "Fråga om er data." : "Assistenten är inte påslagen.";
  const aside = !ready
    ? config.status === "not-configured"
      ? "Den kräver en nyckel till Claude API."
      : `${config.variable} har ett ogiltigt värde.`
    : recent.length > 0
      ? `${formatInt(verified)} av dina ${formatInt(recent.length)} senaste svar hade alla tal i underlaget.`
      : "Varje tal kontrolleras mot underlaget.";

  const notConfigured = ready
    ? null
    : config.status === "not-configured"
      ? {
          message: "Assistenten är inte påslagen.",
          detail: "Nyckeln sätts i miljövariablerna.",
        }
      : { message: config.message, detail: "Rätta värdet och starta om servern." };

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 px-4 pt-8 pb-16 md:gap-12 md:px-8 md:pt-12">
      <SectionHeader
        className="rise"
        as="h1"
        size="xl"
        eyebrow="Assistent"
        title={title}
        aside={aside}
        meta={[{ label: "Modell", value: modelLabel }]}
      />

      <section
        aria-labelledby="fraga"
        className="rise flex flex-col gap-6"
        style={{ "--i": 1 } as React.CSSProperties}
      >
        <h2 id="fraga" className="sr-only">
          Samtal
        </h2>
        <AssistantChat
          ready={ready}
          local={local}
          modelLabel={modelLabel}
          examples={ctx.canSeeEconomy ? ECONOMY_EXAMPLES : REFILLER_EXAMPLES}
          notConfigured={notConfigured}
          initialQuestion={prefill}
        />
      </section>

      {advisor ? (
        <section
          aria-labelledby="forslag"
          className="rise flex flex-col gap-4"
          style={{ "--i": 2 } as React.CSSProperties}
        >
          <SectionHeader
            id="forslag"
            size="sm"
            title="Förslag."
            aside={
              advisor.lastRun
                ? `Senaste körning ${formatRelative(new Date(advisor.lastRun.createdAt))}.`
                : "Tas fram varje morgon."
            }
          />
          <Suggestions
            items={advisor.suggestions}
            manualLeft={advisor.manualLeft}
            canGenerate={ready && !local}
            emptyText="Inga öppna förslag. Nya tas fram varje morgon."
          />
        </section>
      ) : null}

      <details
        className="rise rounded-md border border-line bg-surface p-4 md:p-5"
        style={{ "--i": 3 } as React.CSSProperties}
      >
        <summary className="flex cursor-pointer list-none items-baseline justify-between gap-4">
          <h2 className="text-md font-medium text-fg">Om assistenten</h2>
          <span className="meta text-subtle">
            {`${formatInt(tools.length)} verktyg · ${formatInt(asked)} frågor`}
          </span>
        </summary>
        <div className="mt-6 flex flex-col gap-10">
          <section aria-labelledby="verktyg" className="flex flex-col gap-6">
            <SectionHeader id="verktyg" size="sm" title="Verktyg." />
            <dl className="grid grid-cols-1 gap-x-8 lg:grid-cols-2">
              {tools.map((t) => (
                <div key={t.name} className="flex min-w-0 flex-col gap-1 border-t border-line py-3">
                  <dt className="flex flex-wrap items-baseline gap-x-3">
                    <span className="text-base text-fg">{t.title}</span>
                    <span className="meta text-subtle">{t.name}</span>
                  </dt>
                  <dd className="text-sm text-muted">{TOOL_ABOUT[t.name] ?? ""}</dd>
                </div>
              ))}
            </dl>
          </section>

          <section aria-labelledby="logg" className="flex flex-col gap-6">
            <SectionHeader
              id="logg"
              size="sm"
              title="Dina senaste frågor."
              aside={
                recent.length === 0
                  ? "Inga ännu."
                  : `Senast ${formatRelative(new Date(recent[0]!.createdAt))}.`
              }
            />
            {recent.length > 0 ? (
              <ol className="flex flex-col">
                {recent.map((r) => (
                  <li key={r.id} className="border-t border-line">
                    <details className="group">
                      <summary className="flex cursor-pointer flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
                        <span className="min-w-0 text-base break-words text-fg">{r.question}</span>
                        <span className="flex shrink-0 items-center gap-3">
                          <StatusTag status={STATUS_LABEL[r.status].status}>
                            {STATUS_LABEL[r.status].text}
                          </StatusTag>
                          <span className="meta tnum text-subtle">
                            {formatRelative(new Date(r.createdAt))}
                          </span>
                        </span>
                      </summary>
                      <div className="flex flex-col gap-4 pb-6">
                        {r.answer ? (
                          <AnswerText text={r.answer} unverified={r.verification.unverified} />
                        ) : (
                          <p className="text-sm text-muted">{r.error ?? "Inget svar."}</p>
                        )}
                        {r.status === "answered" || r.status === "unverified" ? (
                          <VerificationLine verification={r.verification} />
                        ) : null}
                        <div className="flex flex-col gap-1">
                          <span className="label text-muted">Underlag · {r.model}</span>
                          <Evidence calls={r.toolCalls.map((c) => ({ ...c, done: c }))} />
                        </div>
                      </div>
                    </details>
                  </li>
                ))}
              </ol>
            ) : null}
          </section>

          <section
            id="installning"
            aria-labelledby="installning-rubrik"
            className="flex scroll-mt-28 flex-col gap-6"
          >
            <SectionHeader
              id="installning-rubrik"
              size="sm"
              title={ready ? "Ansluten." : "Inte ansluten."}
              aside={
                ready
                  ? local
                    ? "Lokal testmodell utan AI (bara i utveckling)."
                    : `Claude API med ${config.model}.`
                  : "Nyckeln sätts i miljövariablerna, aldrig i appen."
              }
            />
            {/* Variabelnamnen är för driften: bakom "Visa detaljer", inte i sidans första läsning. */}
            <details className="group max-w-3xl text-sm">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1 rounded-xs font-mono text-xs text-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden">
                <span aria-hidden className="text-faint group-open:rotate-90">
                  ›
                </span>
                Visa detaljer för driften
              </summary>
              <dl className="meta mt-3 grid grid-cols-1 gap-y-2 text-muted sm:grid-cols-[auto_1fr] sm:gap-x-8">
                <dt className="text-subtle">ASSISTANT_PROVIDER</dt>
                <dd className="text-fg">
                  {ready ? config.provider : (process.env.ASSISTANT_PROVIDER ?? "anthropic")}
                </dd>
                <dt className="text-subtle">ANTHROPIC_API_KEY</dt>
                <dd className="text-fg">
                  {process.env.ANTHROPIC_API_KEY?.trim() ? "satt" : "saknas"}
                </dd>
                <dt className="text-subtle">ANTHROPIC_MODEL</dt>
                <dd className="text-fg">
                  {process.env.ANTHROPIC_MODEL?.trim() || "claude-opus-5-5 (standard)"}
                </dd>
              </dl>
            </details>
          </section>
        </div>
      </details>
    </div>
  );
}
