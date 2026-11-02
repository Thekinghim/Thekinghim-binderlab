import type { Metadata } from "next";
import Link from "next/link";

import { periodText, sentence } from "@/analytics/todos/text";
import {
  PrintButton,
  ReportDocument,
  ReportKpiRow,
  ReportNote,
  ReportPage,
  ReportSection,
  ReportTitle,
} from "@/components/report";
import type { SearchParamsInput } from "@/components/shell/period-state";
import { formatInt } from "@/lib/format";

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
  const { deck } = data;
  const ok = deck.status === "ok";
  const period = { start: localDate(data.period.start), end: localDate(data.period.end) };

  return (
    <div className="bl-desk min-h-full">
      <style>{`
        @media print {
          body:has([data-sales-deck]) :is(header, aside, nav):not([data-sales-deck] *) { display: none !important; }
          body:has([data-sales-deck]) * { visibility: hidden !important; }
          body:has([data-sales-deck]) [data-sales-deck],
          body:has([data-sales-deck]) [data-sales-deck] * { visibility: visible !important; }
          body:has([data-sales-deck]) [data-sales-deck] { position: absolute; left: 0; top: 0; }
        }
      `}</style>
      <div data-print="hide" className="border-b border-line bg-bg">
        <div className="mx-auto flex max-w-[1280px] flex-wrap items-center justify-between gap-3 px-4 py-3 md:px-8">
          <nav aria-label="Sökväg" className="label flex min-w-0 items-center gap-2 text-subtle">
            <Link href="/expansion#saljunderlag" className="rounded-xs text-muted hover:text-fg">
              Expansion
            </Link>
            <span aria-hidden className="text-faint">
              /
            </span>
            <span className="truncate">Säljunderlag · A4 · {periodText(data.period)}</span>
          </nav>
          <PrintButton disabled={!ok} />
        </div>
      </div>
      <main className="px-4 py-6 md:px-8 md:py-12 print:p-0" data-sales-deck="">
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
                  title="Provision på försäljningen och hyra för platsen."
                  aside={`Provision ${kr(deck.commissionPerMonthOre!)} och hyra ${kr(deck.rentPerMonthOre!)} per automat och månad, i snitt.`}
                >
                  <ol className="flex flex-col">
                    {[
                      `Provisionen räknas på varje sålt pack, på beloppet exklusive moms, enligt butikens avtal.`,
                      `Hyran är ett fast belopp per månad enligt avtalet och betalas oavsett försäljning.`,
                      `Snittet är all ersättning till butikerna delat med antalet automatmånader (${hundredthsText(deck.machineMonthsHundredths)} under perioden). En automat en hel månad räknas som 1.`,
                    ].map((t, i) => (
                      <li
                        key={i}
                        className="grid grid-cols-[7mm_1fr] items-baseline border-t border-line py-[2.4mm] text-[12px] leading-[17px] text-fg last:border-b"
                      >
                        <span className="tnum font-mono text-[9.5px] text-subtle">{i + 1}</span>
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
              Beloppen är historiska snitt, inte en utlovad ersättning; utfallet beror på plats och
              försäljning. Inga butiksnamn och inga enskilda butikers belopp redovisas, och snittet
              visas bara när minst {SALES_DECK_MIN_STORES} butiker ingår.
            </ReportNote>
          </ReportPage>
        </ReportDocument>
      </main>
    </div>
  );
}
