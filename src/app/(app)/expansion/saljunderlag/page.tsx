import type { Metadata } from "next";
import Link from "next/link";

import { day, periodText, sentence } from "@/analytics/todos/text";
import {
  ReportDocument,
  ReportKpiRow,
  ReportNote,
  ReportPage,
  ReportSection,
  ReportTitle,
} from "@/components/report";
import type { SearchParamsInput } from "@/components/shell/period-state";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { formatInt } from "@/lib/format";
import { loadContext } from "@/server/data/core";

import { V2PrintButton } from "../../../rapport/_components/v2-print-button";
import "../../../rapport/_components/report-chrome.css";

import { loadSalesDeckPage } from "../_lib/data";
import { hundredthsText, kr, pct } from "../_lib/display";
import { SALES_DECK_MIN_STORES } from "../_lib/model";

export const metadata: Metadata = { title: "Säljunderlag" };

/** 'ÅÅÅÅ-MM-DD' → Date vid lokal midnatt (rapportens perioder är kalenderdagar). */
function localDate(iso: string): Date {
  const [y, m, d] = iso.split("-").map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}

/** Tal utan " kr" för rapportens KPI-rad (enheten står separat). */
function amount(ore: number): string {
  return kr(ore).replace(/\s*kr$/, "");
}

/**
 * Säljunderlag till nya partnerbutiker: vad befintliga partnerbutiker tjänar i snitt per
 * automat och månad, anonymiserat (minst tre butiker, inga namn, inga enskilda belopp).
 * Ett A4-ark i utskriftsläget; "Skriv ut / spara PDF" ger PDF:en. Skalet runt sidan döljs
 * vid utskrift.
 */
export default async function SalesDeckPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  const data = await loadSalesDeckPage(await searchParams);
  const ctx = await loadContext();
  const { deck } = data;
  const ok = deck.status === "ok";
  const period = { start: localDate(data.period.start), end: localDate(data.period.end) };

  return (
    <V2Page
      title="Säljunderlag"
      date={headerDate(new Date(ctx.now), ctx.timeZone)}
      sub={
        <>
          <Link href="/expansion" className="font-[550] text-v2-ink hover:underline">
            <span aria-hidden="true">← </span>
            Expansion
          </Link>
          <span aria-hidden="true">·</span>
          <span>A4 · {periodText(data.period)}</span>
        </>
      }
      tools={<V2PrintButton disabled={!ok} />}
    >
      <style>{`
        @media print {
          body:has([data-sales-deck]) :is(header, aside, nav):not([data-sales-deck] *) { display: none !important; }
          body:has([data-sales-deck]) * { visibility: hidden !important; }
          body:has([data-sales-deck]) [data-sales-deck],
          body:has([data-sales-deck]) [data-sales-deck] * { visibility: visible !important; }
          body:has([data-sales-deck]) [data-sales-deck] { position: absolute; left: 0; top: 0; }
        }
      `}</style>
      {/* Arket på V2:s ljusa skrivbord (som /rapport), inte det mörka. */}
      <div className="bl-desk rp-chrome">
        <div className="py-2 print:p-0" data-sales-deck="">
          <ReportDocument
            title="Säljunderlag för partnerbutiker"
            recipient="Blivande partnerbutik"
            confidentiality={`${data.organizationName} · anonymiserat snitt, minst ${SALES_DECK_MIN_STORES} butiker`}
            period={period}
            generatedAt={new Date(data.generatedAt)}
            tone="mono"
          >
            <ReportPage className="gap-[9mm]">
              <ReportTitle
                eyebrow={`${data.organizationName} · samlarkortsautomat`}
                title={
                  ok
                    ? `En automat ger butiken ${kr(deck.compensationPerMonthOre!)} i månaden.`
                    : "Snittet visas från tre partnerbutiker."
                }
                aside={
                  ok
                    ? sentence(
                        `Snitt för ${formatInt(deck.stores)} partnerbutiker, ${periodText(data.period)}`,
                      )
                    : `Underlaget har ${formatInt(deck.stores)} ${deck.stores === 1 ? "butik" : "butiker"}. Med färre än ${SALES_DECK_MIN_STORES} går en enskild butiks ersättning att räkna ut, så inga belopp visas.`
                }
              />
              {ok ? (
                <>
                  <ReportKpiRow
                    items={[
                      {
                        label: "Ersättning per månad",
                        value: amount(deck.compensationPerMonthOre!),
                        unit: "kr",
                        context: "per automat",
                      },
                      {
                        label: "Per år",
                        value: amount(deck.compensationPerYearOre!),
                        unit: "kr",
                        context: "månaden × 12",
                      },
                      {
                        label: "Försäljning per månad",
                        value: amount(deck.salesPerMonthOre!),
                        unit: "kr",
                        context: "per automat",
                      },
                      {
                        label: "Andel till butiken",
                        value: pct(deck.compensationShareBp ?? 0).replace(/\s*%$/, ""),
                        unit: "%",
                        context: "av försäljningen",
                      },
                    ]}
                  />
                  <ReportSection
                    index={1}
                    eyebrow="Ersättningen"
                    title="Butiken får hälften av vinsten."
                    aside={`${kr(deck.commissionPerMonthOre! + deck.rentPerMonthOre!)} till butiken per automat och månad, i snitt.`}
                  >
                    <ol className="flex flex-col">
                      {[
                        `Vinst = försäljning − inköp av korten − kortavgifter, per månad. Butiken får 50 %.`,
                        `Butiken står bara för plats och el. Vi står för automaten, korten, påfyllning och service. En månad utan vinst ger 0 kr, aldrig en kostnad.`,
                        `Snittet är all ersättning till butikerna delat med antalet automatmånader (${hundredthsText(deck.machineMonthsHundredths)} under perioden). En automat en hel månad räknas som 1.`,
                      ].map((t, i) => (
                        <li
                          key={i}
                          className="grid grid-cols-[7mm_1fr] items-baseline border-t border-line py-[2.4mm] text-[12px] leading-[17px] text-fg last:border-b"
                        >
                          <span className="tnum text-[9.5px] text-subtle">{i + 1}</span>
                          <span>{t}</span>
                        </li>
                      ))}
                    </ol>
                  </ReportSection>
                </>
              ) : null}
              <ReportNote className="mt-auto">
                {sentence(
                  `Källa: betalda order och butiksavtal i Binderlab för ${periodText(data.period)}`,
                )}{" "}
                {data.clippedFrom
                  ? `Räknat från första ordern ${day(data.clippedFrom)}; dagar före den räknas inte. `
                  : ""}
                Beloppen är historiska snitt, inte en utlovad ersättning; utfallet beror på plats
                och försäljning. Inga butiksnamn och inga enskilda butikers belopp redovisas, och
                snittet visas bara när minst {SALES_DECK_MIN_STORES} butiker ingår.
              </ReportNote>
            </ReportPage>
          </ReportDocument>
        </div>
      </div>
    </V2Page>
  );
}
