"use client";

import { useState, type ReactNode } from "react";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Segmented } from "@/components/ui/segmented";
import { TableSkeleton } from "@/components/ui/skeleton";
import { StatusTag } from "@/components/ui/status-tag";
import { StateMessage, StateRow, type StateMessageProps } from "@/components/ui/state-message";
import { formatDate, formatInt, formatSek } from "@/lib/format";
import type { Model } from "../model";
import { machineStates, type Machine, type Totals } from "../sample-data";
import { MachineCell } from "./metrics";
import { SpecSection, Sub } from "./section";

type Kind = StateMessageProps["kind"];
type Mode = "ready" | "loading" | Kind;

const kindNames: Record<Kind, string> = {
  empty: "Tomt",
  "no-results": "Ingen träff",
  error: "Fel",
  "loading-failed": "Ej laddad",
  offline: "Ur drift",
  denied: "Behörighet",
  "not-configured": "Ej inställd",
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

const modes: ReadonlyArray<{ mode: Mode; name: string }> = [
  { mode: "ready", name: "Klart" },
  { mode: "loading", name: "Laddar" },
  ...order.map((k) => ({ mode: k as Mode, name: kindNames[k] })),
];

/** Antal lägen som visas: klart, laddar och sju tomma lägen och fellägen. */
export const STATE_COUNT = modes.length;

const diagnostics = [
  { label: "Begärans id", value: "req_7f3a91c2e04b" },
  { label: "Tid", value: "2 nov. 14:19:04" },
  { label: "Tjänst", value: "awish-api · eu-north-1" },
  { label: "Svar", value: "503, tjänsten svarar inte" },
];

/** Blocklägen i automattabellen. Copy för verksamhetens tre automater. */
const blocks: Record<Kind, Omit<StateMessageProps, "kind">> = {
  empty: {
    message: "Inga köp av Black Bolt i BL-002 sedan 31 okt. 16:40.",
    detail: "Fack 3 är tomt. De andra fem facken säljer som vanligt.",
    action: { label: "Registrera påfyllning" },
    secondaryAction: { label: "Visa lagerhistorik" },
  },
  "no-results": {
    message: "Inga automater matchar ”Kista”.",
    detail: "De tre automaterna står i Göteborg, Malmö och Helsingborg.",
    action: { label: "Rensa sökningen" },
  },
  error: {
    code: "503",
    message: "Kunde inte hämta lagersaldo från Awish.",
    detail: "Senaste lyckade synk 14:32. Saldot nedan kan vara upp till 15 min gammalt.",
    action: { label: "Försök igen" },
    diagnostics,
  },
  "loading-failed": {
    code: "2 av 5",
    message: "Diagrammen Köp per timme och Intäkt per titel laddades inte.",
    detail: "De andra tre diagrammen och alla nyckeltal är kompletta.",
    action: { label: "Ladda om de två" },
    diagnostics: [
      { label: "Begärans id", value: "req_19b0c6d2a771" },
      { label: "Tid", value: "2 nov. 14:21:40" },
      { label: "Svar", value: "Tidsgräns 10 s överskreds" },
    ],
  },
  offline: {
    code: "BL-003",
    message: "Automaten har inte svarat sedan 14:05.",
    detail: "Köp under avbrottet sparas i automaten och räknas in när den kopplar upp igen.",
    action: { label: "Felsök uppkoppling" },
    secondaryAction: { label: "Ring Väla Centrum" },
  },
  denied: {
    message: "Du ser försäljning men inte inköpspriser för BL-002.",
    detail: "Rollen Ägare eller Administratör krävs. Ägare för kontot är Wilhelm Lindqvist.",
    action: { label: "Begär behörighet" },
  },
  "not-configured": {
    message: "Ingen påfyllningsgräns är satt för BL-003.",
    detail: "Utan gräns kan panelen inte varna innan ett fack tar slut.",
    action: { label: "Ställ in gräns" },
    secondaryAction: { label: "Kopiera från BL-001" },
  },
};

/** Inline-lägen: samma lägen som de står i en tabellrad, kortare copy. */
const rows: Record<Kind, Omit<StateMessageProps, "kind">> = {
  empty: { message: "Inga köp sedan 31 okt. 16:40.", action: { label: "Fyll på" } },
  "no-results": { code: "0 av 3", message: "Inget matchar ”Kista”.", action: { label: "Rensa" } },
  error: {
    code: "503",
    message: "Lagersaldo hämtades inte.",
    detail: "Synk 14:32.",
    action: { label: "Försök igen" },
    diagnostics,
  },
  "loading-failed": {
    message: "Ordrar 42701–42799 kom inte fram.",
    action: { label: "Hämta igen" },
  },
  offline: { code: "BL-003", message: "Tyst sedan 14:05.", action: { label: "Felsök" } },
  denied: { message: "Inköpspriser dolda.", action: { label: "Begär behörighet" } },
  "not-configured": { message: "Ingen påfyllningsgräns.", action: { label: "Ställ in" } },
};

const rules: { rule: string; example: string }[] = [
  {
    rule: "Säg vad som saknas, var och när.",
    example: "Inga köp av Black Bolt i BL-002 sedan 31 okt. 16:40. Inte: Ingen data.",
  },
  {
    rule: "Ge en åtgärd som går att göra här, med verbet först.",
    example: "Försök igen · Rensa sökningen · Begär behörighet",
  },
  {
    rule: "Prefixet bär statusen i text. Glyfens form upprepar den.",
    example: "FEL · UR DRIFT · SAKNAR BEHÖRIGHET · EJ LADDAD",
  },
  {
    rule: "I ett tillståndsmeddelande står signalfärgen bara på glyfen, och bara vid fel.",
    example: "Fel och Ej laddad har signalglyf. Tomt, ur drift och behörighet är grå.",
  },
  {
    rule: "Skriv vad som fortfarande gäller.",
    example: "Senaste lyckade synk 14:32. De andra diagrammen är kompletta.",
  },
  {
    rule: "Tekniska uppgifter bakom Visa detaljer. Aldrig ett felspår.",
    example: "Begärans id, tid, tjänst och svarskod. Går att kopiera.",
  },
  {
    rule: "Inga ursäkter, utrop eller illustrationer.",
    example: "Inte: Hoppsan! Något gick fel.",
  },
];

type Row = { machine: Machine; totals: Totals };

const stateOf = (m: Machine) => machineStates.find((x) => x.machineId === m.id);

const readyColumns: Column<Row>[] = [
  {
    key: "machine",
    header: "Automat",
    render: (r) => <MachineCell row={{ machine: r.machine, status: stateOf(r.machine) }} />,
  },
  {
    key: "status",
    header: "Status",
    hideOnMobile: true,
    render: (r) => {
      const s = machineStates.find((x) => x.machineId === r.machine.id);
      return s ? (
        <StatusTag status={s.status}>{s.status === "ok" ? undefined : s.statusText}</StatusTag>
      ) : null;
    },
  },
  {
    key: "revenue",
    header: "Intäkt",
    numeric: true,
    render: (r) => formatSek(r.totals.revenue / 100),
  },
];

/** Diagramyta där läget ersätter ritytan men axeln står kvar. Ingen egen ram. */
function ChartSlot({
  label,
  meta,
  ticks,
  children,
}: {
  label: string;
  meta: string;
  ticks: ReadonlyArray<string>;
  children: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col">
      <div className="flex items-baseline justify-between gap-3">
        <span className="label truncate text-muted">{label}</span>
        <span className="label shrink-0 text-subtle">{meta}</span>
      </div>
      <div className="mt-6 flex-1">{children}</div>
      <div aria-hidden className="mt-6 border-t border-line-strong" />
      <div aria-hidden className="meta tnum mt-1.5 flex justify-between text-subtle">
        {ticks.map((t) => (
          <span key={t}>{t}</span>
        ))}
      </div>
    </div>
  );
}

export function StatesSection({ index, model }: { index: number; model: Model }) {
  const n = String(index).padStart(2, "0");
  const [mode, setMode] = useState<Mode>("ready");
  const ready: Row[] = model.machines.map((m) => ({ machine: m.machine, totals: m.totals }));
  const dates = model.chart.dates;
  const ticks = [dates[0], dates[Math.floor(dates.length / 2)], dates[dates.length - 1]]
    .filter((d): d is Date => Boolean(d))
    .map((d) => formatDate(d, { year: "never" }));
  const days = `${formatInt(dates.length)} d`;

  return (
    <SpecSection
      id="tillstand"
      index={index}
      eyebrow="Tillstånd"
      title={`Samma tabell i ${STATE_COUNT} lägen.`}
      aside="Varje tomt läge och fel säger vad som saknas och vad du kan göra."
      space="tight"
    >
      <div className="flex min-w-0 flex-col gap-12 lg:col-span-8">
        <Sub index={`${n}.1`} label={`Automater · ${model.rangeLabel}`} meta="välj läge">
          <div className="flex min-w-0 flex-col rounded-md border border-line bg-surface">
            <div className="border-b border-line px-4 py-3 md:px-5">
              <Segmented<Mode>
                label="Tabellens läge"
                size="sm"
                value={mode}
                onChange={setMode}
                options={modes.map((m) => ({ value: m.mode, label: m.name }))}
              />
            </div>
            <div className="min-h-[300px] px-4 md:px-5" aria-live="polite">
              {mode === "ready" ? (
                <div className="py-2">
                  <DataTable
                    caption="Automater med status och intäkt"
                    columns={readyColumns}
                    rows={ready}
                    rowKey={(r) => r.machine.id}
                    dense
                    stickyFirstColumn={false}
                    surface="surface"
                  />
                </div>
              ) : mode === "loading" ? (
                <div className="py-2" aria-busy>
                  <span className="sr-only">Laddar automater</span>
                  <TableSkeleton rows={3} />
                </div>
              ) : (
                <StateMessage key={mode} kind={mode} {...blocks[mode]} className="-mx-4 md:-mx-5" />
              )}
            </div>
          </div>
        </Sub>

        <Sub index={`${n}.3`} label="I ett diagram" meta="axeln står kvar">
          <div className="grid gap-8 sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
            <ChartSlot label="Intäkt per dag · BL-003" meta={days} ticks={ticks}>
              <StateMessage
                compact
                kind="offline"
                code="BL-003"
                message="Tyst sedan 14:05."
                action={{ label: "Felsök" }}
                className="px-0"
              />
            </ChartSlot>
            <ChartSlot label="Marginal per titel" meta={days} ticks={ticks}>
              <StateMessage
                compact
                kind="denied"
                message="Kräver rollen Ägare."
                action={{ label: "Begär" }}
                className="px-0"
              />
            </ChartSlot>
          </div>
        </Sub>
      </div>

      {/* Inline: som rader i en tabell */}
      <Sub index={`${n}.2`} label="I en tabellrad" meta="kompakt" className="lg:col-span-4">
        <table className="w-full border-collapse text-left">
          <caption className="sr-only">Alla lägen som en rad i automattabellen</caption>
          <thead>
            <tr>
              <th
                scope="col"
                className="label h-9 border-b border-line-strong font-normal text-subtle"
              >
                Automat
              </th>
              <th
                scope="col"
                className="label h-9 border-b border-line-strong text-right font-normal text-subtle"
              >
                Intäkt
              </th>
            </tr>
          </thead>
          {order.map((k) => (
            <tbody key={k}>
              <StateRow colSpan={2} kind={k} {...rows[k]} className="[&>div]:px-0" />
            </tbody>
          ))}
        </table>
      </Sub>

      <Sub
        index={`${n}.4`}
        label="Formuleringar"
        meta={`${rules.length} regler`}
        className="lg:col-span-12"
      >
        <ol>
          {rules.map((r, i) => (
            <li
              key={r.rule}
              className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-3 border-b border-line py-3 first:pt-0 md:grid-cols-[2rem_minmax(0,5fr)_minmax(0,7fr)] md:gap-x-8"
            >
              <span className="meta tnum pt-0.5 text-subtle">{String(i + 1).padStart(2, "0")}</span>
              <span className="text-base text-fg">{r.rule}</span>
              <span className="col-start-2 mt-1 text-sm text-subtle md:col-start-3 md:mt-0">
                {r.example}
              </span>
            </li>
          ))}
        </ol>
      </Sub>
    </SpecSection>
  );
}
