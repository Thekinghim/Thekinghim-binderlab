import type { Metadata } from "next";
import { Suspense } from "react";

import type { SearchParamsInput } from "@/components/shell/period-state";
import { StoreShareToggle } from "@/components/shell/store-share-toggle";
import { requestStoreShareView } from "@/server/data/core";
import { formatInt } from "@/lib/format";

import { DataStartNote, EvidenceDetails } from "../../expansion/_components/evidence";
import { loadUnitEconomicsPage } from "../../expansion/_lib/data";
import { kr, paybackShort } from "../../expansion/_lib/display";
import { evidenceLinks } from "../../expansion/_lib/model";
import { periodText } from "@/analytics/todos/text";
import { unstable_rethrow } from "next/navigation";

import "../../drift/_components/ops.css";
import { lastPurchase } from "./_lib/last-purchase";
import { loadInvestmentsFor } from "../../expansion/_lib/service";
import { currentViewer } from "../../expansion/_lib/session";
import {
  ComparisonTable,
  InvestmentsSection,
  ProfitPerDayChart,
  UnitEconomicsKpis,
} from "./_components/unit-economics-view";

export const metadata: Metadata = { title: "Enhetsekonomi" };

/**
 * Enhetsekonomi per automat: investering (inköp + installation), intäkt och vinst per dag,
 * återbetalningstid och avkastning, sida vid sida. Siffrorna kommer från domänens
 * `unitEconomics` via `compareUnitEconomics` (@/analytics/expansion), för perioden och
 * filtret i skalet. Investeringarna registreras här (ägare och admin).
 */
export default async function EnhetsekonomiPage({
  searchParams,
}: {
  searchParams: Promise<SearchParamsInput>;
}) {
  const sp = await searchParams;
  const [data, shareToggle] = await Promise.all([
    loadUnitEconomicsPage(sp),
    requestStoreShareView(),
  ]);
  // Länken "Registrera investering" från en automat (?automat=) öppnar investeringarna.
  const param = (name: string): string | undefined => {
    const v =
      "get" in sp && typeof sp.get === "function"
        ? sp.get(name)
        : (sp as Record<string, unknown>)[name];
    const one = Array.isArray(v) ? v[0] : v;
    return typeof one === "string" && one !== "" ? one : undefined;
  };
  const forMachine = param("automat");
  const openInvestments = Boolean(forMachine) || data.investments.length === 0;
  // Startklar-länken "Lägg in vad automaten kostade" (?automat=<id>&ny=1): rutan öppnas direkt
  // med automaten vald. Bara så länge automaten inte har någon kostnad inlagd: annars skulle
  // en omladdning (eller bakåt-knappen) öppna den förifyllda rutan igen, ett tryck från att
  // samma kostnad sparas två gånger.
  const openNew =
    param("ny") === "1" &&
    Boolean(forMachine) &&
    !data.investments.some((i) => i.machineId === forMachine && i.amountOre > 0);
  // Förifyllt från senaste automaten: sidans lista är filtrerad på automaten (?automat=),
  // så alla automaters investeringar läses för sig, bara när rutan ska öppnas.
  let template: { amountOre: number; depreciationMonths: number | null; code: string } | null =
    null;
  if (openNew && data.ctx.canEdit) {
    try {
      const last = lastPurchase(
        await loadInvestmentsFor(await currentViewer()),
        forMachine ?? null,
      );
      const code = last ? data.names.machines.find((m) => m.id === last.machineId)?.code : null;
      if (last && code) {
        template = { amountOre: last.amountOre, depreciationMonths: last.depreciationMonths, code };
      }
    } catch (error) {
      unstable_rethrow(error);
      console.error("[enhetsekonomi] Senaste investeringen kunde inte läsas:", error);
    }
  }
  const { comparison, period } = data;
  const codes = Object.fromEntries(data.names.machines.map((m) => [m.id, m.code ?? m.name]));
  const names = {
    stores: (id: string) => data.names.stores.find((s) => s.id === id)?.name ?? id,
    machines: (id: string) => {
      const m = data.names.machines.find((x) => x.id === id);
      return m ? `${m.code} ${m.name}` : id;
    },
  };
  const investmentOre = comparison.rows.reduce((s, r) => s + r.investmentOre, 0);
  const bookValueOre = comparison.rows.reduce((s, r) => s + r.bookValueOre, 0);
  const paid = comparison.rows.filter((r) => r.paybackTenths !== null);
  const fastest = [...paid].sort((a, b) => a.paybackTenths! - b.paybackTenths!)[0];
  const best = comparison.rows.find((r) => r.machineId === comparison.bestMachineId);

  const title =
    comparison.averageProfitPerDayOre === null
      ? "Enhetsekonomi per automat."
      : `Vinst ${kr(comparison.averageProfitPerDayOre)} per automat och dag.`;

  return (
    // Skalets kontextrad (period, Eget intervall, Butik/Automat) gäller här och står kvar
    // ovanför; sidan själv är V2-kort (ingen V2Page, så att filtret inte döljs).
    <div className="v2-page-body" data-testid="enhetsekonomi-v2">
      <div className="v2-stack">
        <div className="flex flex-col gap-1 px-0.5">
          <h1 className="text-v2-xl font-[650] text-v2-ink">{title}</h1>
          <p className="ops-p">{comparison.text}</p>
        </div>

        <div className="ops-bar">
          <KeyValuesInline
            items={[
              { label: "Period", value: periodText(period.period) },
              { label: "Automater", value: formatInt(comparison.rows.length) },
              {
                label: "Betalar sig snabbast",
                value: fastest
                  ? `${codes[fastest.machineId] ?? ""} ${paybackShort(fastest.paybackTenths)}`
                  : "–",
              },
            ]}
          />
          {/* Vinsten före butikernas andel; med knappen efter den (samma regel som Lönsamhet). */}
          <Suspense fallback={null}>
            <StoreShareToggle on={shareToggle} />
          </Suspense>
        </div>
        <DataStartNote clippedFrom={period.clippedFrom} requested={period.requested} />
        <EvidenceDetails
          evidence={comparison.evidence}
          links={evidenceLinks(comparison.evidence, names, 0)}
        />

        <UnitEconomicsKpis
          averageProfitPerDayOre={comparison.averageProfitPerDayOre}
          averageRevenuePerDayOre={comparison.averageRevenuePerDayOre}
          investmentOre={investmentOre}
          bookValueOre={bookValueOre}
          comparison={`${periodText(period.period)}, ${formatInt(period.days)} dagar`}
        />

        <section aria-labelledby="per-dag" className="v2-card">
          <div className="v2-card-hd">
            <h2>Vinst per dag</h2>
          </div>
          <div className="px-[18px] pt-3.5 pb-4 max-[900px]:px-4">
            <h3 id="per-dag" className="text-v2-lg font-[650] text-v2-ink">
              {best ? `${best.name} leder.` : "Vinst per automat och dag."}
            </h3>
            <p className="ops-p">
              {comparison.averageProfitPerDayOre === null
                ? "Ingen automat var placerad i perioden."
                : `En automat tjänar i snitt ${kr(comparison.averageProfitPerDayOre)} per dag.`}
            </p>
            <div className="mt-4">
              <ProfitPerDayChart rows={comparison.rows} codes={codes} />
            </div>
          </div>
        </section>

        <section aria-labelledby="sida-vid-sida" className="v2-card">
          <div className="v2-card-hd">
            <h2>Alla automater</h2>
            <span className="tnum text-v2-xs text-v2-mute">
              {formatInt(comparison.rows.length)}
            </span>
          </div>
          <div className="px-[18px] pt-3.5 max-[900px]:px-4">
            <h3 id="sida-vid-sida" className="text-v2-lg font-[650] text-v2-ink">
              Vad de kostade och när de har betalat sig.
            </h3>
            <p className="ops-p">
              {fastest
                ? `${fastest.name} betalar sig snabbast, på ${paybackShort(fastest.paybackTenths)}.`
                : investmentOre === 0
                  ? "Ingen investering registrerad."
                  : "Ingen automat återbetalas med nuvarande vinst."}
            </p>
          </div>
          <div className="px-[18px] pt-3 pb-2 max-[900px]:px-4">
            <ComparisonTable
              rows={comparison.rows}
              units={data.units}
              codes={codes}
              period={period.period}
            />
          </div>
          <details className="ops-more border-t border-v2-line2 px-[18px] py-1.5 max-[900px]:px-4">
            <summary>Underlag per automat</summary>
            <ul className="flex flex-col">
              {comparison.rows.map((r) => (
                <li key={r.machineId} className="flex flex-col gap-2 border-t border-v2-line2 py-3">
                  <p className="text-v2-sm text-v2-ink">{r.text}.</p>
                  <EvidenceDetails evidence={r.evidence} links={evidenceLinks(r.evidence, names)} />
                </li>
              ))}
            </ul>
          </details>
        </section>

        <section aria-labelledby="investeringar" className="v2-card">
          <details open={openInvestments} className="group">
            <summary className="v2-card-hd cursor-pointer list-none [&::-webkit-details-marker]:hidden">
              <h2 id="investeringar">Investeringar</h2>
              <span className="tnum text-v2-xs text-v2-mute">
                {`${kr(investmentOre)} · ${formatInt(data.investments.length)} poster`}
              </span>
            </summary>
            <div className="flex flex-col gap-4 px-[18px] pt-3.5 pb-4 max-[900px]:px-4">
              <div>
                <p className="text-v2-lg font-[650] text-v2-ink">{`${kr(investmentOre)} investerat.`}</p>
                <p className="ops-p">
                  {`${formatInt(data.investments.length)} poster, bokfört värde ${kr(bookValueOre)}. Inköp och installation per automat.`}
                </p>
              </div>
              <InvestmentsSection
                investments={data.investments}
                machines={data.names.machines}
                canEdit={data.ctx.canEdit}
                today={data.ctx.today}
                forMachineId={forMachine}
                openNew={openNew}
                template={template}
              />
            </div>
          </details>
        </section>
      </div>
    </div>
  );
}

/** Etikett och värde på en rad (Period · Automater · Betalar sig snabbast). */
function KeyValuesInline({ items }: { items: ReadonlyArray<{ label: string; value: string }> }) {
  return (
    <dl className="flex flex-wrap gap-x-5 gap-y-1 text-v2-sm">
      {items.map((it) => (
        <div key={it.label} className="flex items-baseline gap-1.5">
          <dt className="text-v2-mute">{it.label}</dt>
          <dd className="tnum font-[550] text-v2-ink">{it.value}</dd>
        </div>
      ))}
    </dl>
  );
}
