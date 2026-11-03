import type { PriceChangeScenario } from "@/analytics/scenarios";
import type { SiteEstimate } from "@/analytics/expansion";
import { hundredths, signedKr, signedPct } from "@/analytics/expansion";
import { StateMessage } from "@/components/ui/state-message";
import { cn } from "@/lib/cn";
import { formatInt, MISSING } from "@/lib/format";

import { hundredthsText, kr, krExact, paybackShort, pct, pctOrMissing } from "../_lib/display";
import type { EvidenceLink } from "../_lib/model";
import { EstimateTag, EvidenceDetails } from "./evidence";

const CONFIDENCE: Record<"low" | "medium" | "high", string> = {
  low: "Låg",
  medium: "Medel",
  high: "Hög",
};

/** Mätvärden i rad: etikett i mono, värde, och intervall under. */
function Facts({
  items,
}: {
  items: ReadonlyArray<{ label: string; value: string; sub?: string; primary?: boolean }>;
}) {
  return (
    <dl className="grid grid-cols-2 border-y border-line lg:grid-cols-4">
      {items.map((it, i) => (
        <div
          key={it.label}
          className={cn(
            "flex min-w-0 flex-col gap-2 py-4 pr-4",
            i % 2 === 1 && "border-l border-line pl-4",
            i >= 2 && "border-t border-line lg:border-t-0",
            i === 2 && "lg:border-l lg:pl-4",
          )}
        >
          <dt className="label truncate text-muted">{it.label}</dt>
          <dd className={cn("tnum text-fg", it.primary ? "text-2xl" : "text-xl")}>{it.value}</dd>
          {it.sub ? <dd className="meta tnum text-subtle">{it.sub}</dd> : null}
        </div>
      ))}
    </dl>
  );
}

/** Uppskattningen för en ny plats: svar, intervall, platserna den bygger på och vad som valdes bort. */
export function SiteEstimateView({
  estimate,
  links,
  investmentNote,
}: {
  estimate: SiteEstimate;
  links: EvidenceLink[];
  investmentNote?: string;
}) {
  if (estimate.status !== "ok") {
    // Har ingen butik tillräckligt lång historik är det tiden som saknas, inte
    // platsprofilerna: då jämförs inte butiken med sig själv ("Mest lik: X, 100 %").
    const onlyShort =
      estimate.excluded.length > 0 &&
      estimate.excluded.every((e) => e.reason === "short-history" || e.reason === "excluded");
    return (
      <div className="flex flex-col gap-4">
        <StateMessage
          kind="empty"
          code="Inget underlag"
          message={
            onlyShort
              ? "Ingen butik har sålt länge nog för en uppskattning: det krävs 28 automatdagar med försäljningsdata."
              : estimate.text
          }
          detail={
            onlyShort
              ? "Automatdagar räknas från första ordern, inte från när automaten ställdes ut. Uppskattningen räknas när en butik har 28 dagar."
              : estimate.detail
          }
          action={
            onlyShort
              ? undefined
              : { label: "Fyll i platsprofiler", href: "/expansion?vy=pipeline#platsprofiler" }
          }
        />
        {estimate.excluded.length > 0 ? <Excluded estimate={estimate} /> : null}
      </div>
    );
  }
  const p = estimate.profitPerMonthOre!;
  const pb = estimate.paybackTenths!;
  const range = (r: { low: number; high: number }, f: (v: number) => string) =>
    r.low === r.high ? undefined : `${f(r.low)} till ${f(r.high)}`;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-3">
        <EstimateTag />
        <p className="max-w-3xl min-w-0 flex-1 text-md text-fg">{estimate.text}</p>
      </div>
      <Facts
        items={[
          {
            label: "Vinst per månad",
            value: kr(p.expected),
            sub: range(p, kr),
            primary: true,
          },
          {
            label: "Återbetalningstid",
            value: estimate.investmentOre === 0 ? MISSING : paybackShort(pb.expected),
            sub:
              estimate.investmentOre === 0
                ? "investering saknas"
                : pb.low === pb.high
                  ? undefined
                  : `${paybackShort(pb.low)} till ${pb.high === null ? "aldrig" : paybackShort(pb.high)}`,
          },
          {
            label: "Avkastning per år",
            value: pctOrMissing(estimate.annualReturnBp?.expected),
            sub: estimate.annualReturnBp ? range(estimate.annualReturnBp, pct) : undefined,
          },
          {
            label: "Säkerhet",
            value: estimate.confidence ? CONFIDENCE[estimate.confidence] : MISSING,
            sub: `${estimate.basis.length} ${estimate.basis.length === 1 ? "plats" : "platser"}`,
          },
        ]}
      />
      <p className="max-w-3xl text-sm text-muted">
        {estimate.detail}
        {investmentNote ? ` ${investmentNote}` : ""}
      </p>
      <div className="relative min-w-0 overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-base">
          <caption className="sr-only">Platserna uppskattningen bygger på</caption>
          <thead>
            <tr className="border-b border-line-strong">
              {["Plats", "Likhet", "Automatmån.", "Intäkt/mån", "Vinst/mån", "Återbetalning"].map(
                (h, i) => (
                  <th
                    key={h}
                    scope="col"
                    className={cn(
                      "label h-9 font-normal text-subtle",
                      i === 0 ? "text-left" : "pl-4 text-right",
                    )}
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody>
            {estimate.basis.map((b) => (
              <tr key={b.storeId} className="border-b border-line align-top">
                <td className="py-2.5 pr-4">
                  <span className="block text-fg">{b.name}</span>
                  <span className="block text-sm text-muted">{b.similarity.text}</span>
                </td>
                <td className="tnum py-2.5 pl-4 text-right">{pct(b.similarity.scoreBp)}</td>
                <td className="tnum py-2.5 pl-4 text-right">
                  {hundredthsText(b.machineMonthsHundredths)}
                </td>
                <td className="tnum py-2.5 pl-4 text-right">{kr(b.revenuePerMonthOre)}</td>
                <td className="tnum py-2.5 pl-4 text-right">{kr(b.profitPerMonthOre)}</td>
                <td className="tnum py-2.5 pl-4 text-right">{paybackShort(b.paybackTenths)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {estimate.excluded.length > 0 ? <Excluded estimate={estimate} /> : null}
      <EvidenceDetails evidence={estimate.evidence} links={links} />
    </div>
  );
}

function Excluded({ estimate }: { estimate: SiteEstimate }) {
  return (
    <div className="flex flex-col gap-2">
      <p className="label text-subtle">Inte med i underlaget</p>
      <ul className="flex flex-col">
        {estimate.excluded.map((e) => (
          <li key={e.storeId} className="border-t border-line py-2 text-sm text-muted">
            {e.text}
          </li>
        ))}
      </ul>
    </div>
  );
}

/** Känslighetsanalysen för en prisändring: svar, nuläge mot nytt och tabell per elasticitet. */
export function PriceChangeView({
  scenario,
  links,
}: {
  scenario: PriceChangeScenario;
  links: EvidenceLink[];
}) {
  if (scenario.status !== "ok") {
    return (
      <StateMessage
        kind="empty"
        code="Inga sålda pack"
        message={scenario.text}
        detail={scenario.detail}
      />
    );
  }
  const s = scenario.selected;
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start gap-3">
        <EstimateTag />
        <p className="max-w-3xl min-w-0 flex-1 text-md text-fg">{scenario.text}</p>
      </div>
      <Facts
        items={[
          {
            label: "Vinständring",
            value: signedKr(s.profitChangeOre),
            sub: s.profitChangeBp === null ? undefined : `${signedPct(s.profitChangeBp)} mot i dag`,
            primary: true,
          },
          {
            label: "Snittpris",
            value: krExact(scenario.newAveragePriceOre ?? 0),
            sub: `i dag ${krExact(scenario.averagePriceOre ?? 0)}`,
          },
          {
            label: "Bidrag per pack",
            value: krExact(scenario.newContributionPerPackOre ?? 0),
            sub: `i dag ${krExact(scenario.contributionPerPackOre ?? 0)}`,
          },
          {
            label: "Brytpunkt",
            value:
              scenario.breakEvenVolumeChangeBp === null
                ? MISSING
                : signedPct(scenario.breakEvenVolumeChangeBp),
            sub: "volymändring för samma vinst",
          },
        ]}
      />
      <p className="max-w-3xl text-sm text-muted">{scenario.detail}</p>
      <div className="relative min-w-0 overflow-x-auto">
        <table className="w-full min-w-[560px] border-collapse text-base">
          <caption className="sr-only">Utfall per antagen elasticitet</caption>
          <thead>
            <tr className="border-b border-line-strong">
              {["Elasticitet", "Volym", "Pack", "Intäkt", "Vinst", "Ändring"].map((h, i) => (
                <th
                  key={h}
                  scope="col"
                  className={cn(
                    "label h-9 font-normal text-subtle",
                    i === 0 ? "text-left" : "pl-4 text-right",
                  )}
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {scenario.table.map((r) => {
              const selected = r.elasticityHundredths === s.elasticityHundredths;
              return (
                <tr
                  key={r.elasticityHundredths}
                  className={cn("border-b border-line", selected && "bg-hover")}
                  aria-current={selected ? "true" : undefined}
                >
                  <td className="tnum py-2.5 font-mono text-sm">
                    {hundredths(r.elasticityHundredths)}
                    {selected ? <span className="text-subtle"> · vald</span> : null}
                  </td>
                  <td className="tnum py-2.5 pl-4 text-right">{signedPct(r.volumeChangeBp)}</td>
                  <td className="tnum py-2.5 pl-4 text-right">{formatInt(r.units)}</td>
                  <td className="tnum py-2.5 pl-4 text-right">{kr(r.revenueOre)}</td>
                  <td className="tnum py-2.5 pl-4 text-right">{kr(r.profitOre)}</td>
                  <td className="tnum py-2.5 pl-4 text-right">{signedKr(r.profitChangeOre)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <EvidenceDetails evidence={scenario.evidence} links={links} />
    </div>
  );
}
