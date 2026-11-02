"use client";

import { Fragment, useState, type ReactNode } from "react";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage, StateRow, type StateMessageProps } from "@/components/ui/state-message";
import { cn } from "@/lib/cn";

type Kind = StateMessageProps["kind"];

const kindNames: Record<Kind, string> = {
  empty: "Tomt",
  "no-results": "Inga träffar",
  error: "Fel",
  offline: "Offline",
  denied: "Behörighet",
  "loading-failed": "Ej laddad",
  "not-configured": "Ej konfigurerad",
};

const order: Kind[] = [
  "empty",
  "no-results",
  "error",
  "loading-failed",
  "offline",
  "denied",
  "not-configured",
];

const diagnostics = [
  { label: "Request-id", value: "req_7f3a91c2e04b" },
  { label: "Tid", value: "2 nov. 15:19:04" },
  { label: "Tjänst", value: "lager-api · eu-north-1" },
  { label: "Svar", value: "503 Service Unavailable" },
];

/** Blocklägen: fyller en panel. Copy för automaten BL-014 Kista Galleria. */
const blocks: Record<Kind, Omit<StateMessageProps, "kind">> = {
  empty: {
    message: "Inga försäljningar 1–30 nov. för BL-014.",
    detail: "Automaten installerades 28 okt. och har inte rapporterat något köp sedan dess.",
    action: { label: "Kontrollera uppkoppling" },
    secondaryAction: { label: "Visa installationslogg" },
  },
  "no-results": {
    message: "Inga automater matchar ”Kista” med status Kritisk.",
    detail: "41 automater finns i Stockholm. Filtret Status döljer 39 av dem.",
    action: { label: "Rensa filter" },
    secondaryAction: { label: "Sök i alla regioner" },
  },
  error: {
    code: "503",
    message: "Kunde inte hämta lagersaldo.",
    detail: "Senaste lyckade synk 14:32. Saldot nedan kan vara upp till 47 min gammalt.",
    action: { label: "Försök igen" },
    diagnostics,
  },
  "loading-failed": {
    code: "2 av 6",
    message: "Diagrammen Marginal per pack och Påfyllnad laddades inte.",
    detail: "Övriga fyra diagram och alla nyckeltal på sidan är kompletta.",
    action: { label: "Ladda om de två" },
    diagnostics: [
      { label: "Request-id", value: "req_19b0c6d2a771" },
      { label: "Tid", value: "2 nov. 15:21:40" },
      { label: "Svar", value: "Tidsgräns 10 s överskreds" },
    ],
  },
  offline: {
    code: "BL-014",
    message: "Automaten har inte svarat sedan 1 nov. 17:17.",
    detail: "Köp under avbrottet sparas i automaten och räknas in när den kopplar upp igen.",
    action: { label: "Felsök uppkoppling" },
    secondaryAction: { label: "Kontakta platsvärd" },
  },
  denied: {
    message: "Du ser försäljning men inte inköpspriser för BL-014.",
    detail: "Rollen Ekonomi krävs. Administratör för kontot är Anna Lindqvist.",
    action: { label: "Begär behörighet" },
  },
  "not-configured": {
    message: "Inga påfyllningsgränser är satta för BL-014.",
    detail: "Utan gräns kan panelen inte varna innan ett fack tar slut.",
    action: { label: "Ställ in gränser" },
    secondaryAction: { label: "Kopiera från BL-009" },
  },
};

/** Inline-lägen: samma lägen som de står i en tabell, kortare copy. */
const rows: Record<Kind, Omit<StateMessageProps, "kind">> = {
  empty: {
    message: "Inga försäljningar 1–30 nov.",
    action: { label: "Visa okt." },
  },
  "no-results": {
    code: "0 av 41",
    message: "Inget matchar ”Kista”.",
    action: { label: "Rensa filter" },
  },
  error: {
    code: "503",
    message: "Lagersaldo hämtades inte.",
    detail: "Synk 14:32.",
    action: { label: "Försök igen" },
    diagnostics,
  },
  "loading-failed": {
    message: "Rad 2 001–4 000 kom inte fram.",
    action: { label: "Hämta igen" },
  },
  offline: {
    code: "BL-022",
    message: "Tyst sedan 1 nov. 17:17.",
    action: { label: "Felsök" },
  },
  denied: {
    message: "Inköpspriser dolda.",
    action: { label: "Begär behörighet" },
  },
  "not-configured": {
    message: "Ingen påfyllningsgräns.",
    action: { label: "Ställ in" },
  },
};

const rules: { rule: string; example: string }[] = [
  {
    rule: "Säg vad som saknas, var och när.",
    example: "Inga försäljningar 1–30 nov. för BL-014. Inte: Ingen data.",
  },
  {
    rule: "Ge en åtgärd som går att göra här, med verbet först.",
    example: "Försök igen · Rensa filter · Begär behörighet",
  },
  {
    rule: "Prefixet bär statusen i text. Glyfens form upprepar den.",
    example: "FEL · OFFLINE · SAKNAR BEHÖRIGHET · EJ LADDAD",
  },
  {
    rule: "Signalfärg bara för fel som kräver åtgärd, och bara på glyfen.",
    example: "Fel och Ej laddad. Tomt, offline och behörighet är grå.",
  },
  {
    rule: "Skriv vad som fortfarande gäller.",
    example: "Senaste lyckade synk 14:32. Övriga diagram är kompletta.",
  },
  {
    rule: "Tekniska uppgifter bakom Visa detaljer. Aldrig stacktrace.",
    example: "Request-id, tid, tjänst och svarskod. Går att kopiera.",
  },
  {
    rule: "Inga ursäkter, utrop eller illustrationer.",
    example: "Inte: Hoppsan! Något gick fel.",
  },
];

/** Diagrampanel där läget ersätter ritytan men axeln står kvar. */
function PanelSlot({
  label,
  meta,
  children,
}: {
  label: string;
  meta: string;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col rounded-md border border-line bg-surface">
      <div className="flex items-center justify-between gap-3 px-3 pt-3">
        <span className="label truncate text-muted">{label}</span>
        <span className="label shrink-0 text-subtle">{meta}</span>
      </div>
      <div className="mt-8 flex-1">{children}</div>
      <div aria-hidden className="mx-3 mb-3 border-t border-line-strong" />
      <div aria-hidden className="label tnum mx-3 -mt-2 mb-3 flex justify-between text-faint">
        <span>1</span>
        <span>15</span>
        <span>30</span>
      </div>
    </div>
  );
}

export function StatesSection({ index }: { index: number }) {
  const [kind, setKind] = useState<Kind>("error");
  const block = blocks[kind];

  return (
    <section
      id="tomma-lagen"
      aria-labelledby="tomma-lagen-title"
      className="border-t border-line py-16 md:py-20"
    >
      <SectionHeader
        id="tomma-lagen-title"
        index={index}
        eyebrow="Tillstånd · Tomt och fel"
        title="Sju lägen, en rad i monospace och en åtgärd."
        aside="Prefixet säger vad, meningen säger var och när."
      />

      <div className="mt-10 grid gap-3 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-3">
          {/* Block: fyller en panel */}
          <div className="flex min-w-0 flex-1 flex-col rounded-md border border-line bg-surface">
            <div className="flex items-center justify-between gap-3 border-b border-line px-5 py-3 md:px-6">
              <span className="label truncate text-muted">Lagersaldo · BL-014 Kista Galleria</span>
              <span className="label shrink-0 text-subtle">Block</span>
            </div>
            <div
              role="group"
              aria-label="Läge"
              className="flex flex-wrap gap-1 border-b border-line px-4 py-2 md:px-5"
            >
              {order.map((k) => (
                <button
                  key={k}
                  type="button"
                  aria-pressed={k === kind}
                  onClick={() => setKind(k)}
                  className={cn(
                    "h-7 rounded-xs px-2 font-mono text-xs transition-colors duration-[120ms] ease-instrument",
                    k === kind ? "bg-hover text-fg" : "text-subtle hover:text-fg",
                  )}
                >
                  {kindNames[k]}
                </button>
              ))}
            </div>
            <StateMessage key={kind} kind={kind} {...block} className="min-h-[320px] flex-1" />
          </div>

          {/* Kompakt i panel: ersätter diagrammets yta, axeln står kvar */}
          <div className="grid gap-3 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <PanelSlot label="Intäkt per dag · BL-022" meta="1–30 nov.">
              <StateMessage
                compact
                kind="offline"
                code="BL-022"
                message="Tyst sedan 1 nov. 17:17."
                action={{ label: "Felsök" }}
              />
            </PanelSlot>
            <PanelSlot label="Marginal per pack" meta="Nov.">
              <StateMessage
                compact
                kind="denied"
                message="Kräver rollen Ekonomi."
                action={{ label: "Begär" }}
              />
            </PanelSlot>
          </div>
        </div>

        {/* Inline: som rader i en tabell */}
        <div className="min-w-0 overflow-hidden rounded-md border border-line bg-surface">
          <div className="flex items-center justify-between gap-3 border-b border-line px-3 py-3">
            <span className="label text-muted">Automater · Stockholm</span>
            <span className="label shrink-0 text-subtle">Inline</span>
          </div>
          <table className="w-full border-collapse text-left">
            <thead>
              <tr>
                <th
                  scope="col"
                  className="label h-9 border-b border-line-strong px-3 font-normal text-subtle"
                >
                  Automat
                </th>
                <th
                  scope="col"
                  className="label h-9 border-b border-line-strong px-3 text-right font-normal text-subtle"
                >
                  Intäkt nov.
                </th>
              </tr>
            </thead>
            <tbody>
              {order.map((k) => (
                <Fragment key={k}>
                  <tr>
                    <th
                      scope="rowgroup"
                      colSpan={2}
                      className="h-7 border-b border-line bg-bg px-3 text-left font-mono text-xs font-normal text-subtle"
                    >
                      {kindNames[k]}
                    </th>
                  </tr>
                  <StateRow colSpan={2} kind={k} {...rows[k]} />
                </Fragment>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {/* Copy-regler */}
      <div className="mt-12 grid gap-x-12 gap-y-6 md:grid-cols-[minmax(0,1fr)_minmax(0,2fr)]">
        <div>
          <p className="label text-subtle">Copy-regler</p>
          <p className="mt-2 max-w-xs text-base text-muted">
            Gäller tomma lägen, fel och toasts. Meningen ska gå att läsa högt för en kollega i
            telefon.
          </p>
        </div>
        <ol className="border-t border-line">
          {rules.map((r, i) => (
            <li
              key={r.rule}
              className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 border-b border-line py-3 md:grid-cols-[2rem_minmax(0,1fr)_minmax(0,1fr)] md:gap-x-6"
            >
              <span className="label tnum pt-0.5 text-subtle">
                {String(i + 1).padStart(2, "0")}
              </span>
              <span className="text-base text-fg">{r.rule}</span>
              <span className="col-start-2 mt-1 font-mono text-xs text-subtle md:col-start-3 md:mt-0 md:pt-0.5">
                {r.example}
              </span>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
