"use client";

import { formatMarginBp, formatPercent } from "@/lib/format";
import type { AxisUnit } from "./axis";
import { WaterfallChart, type WaterfallStep } from "./waterfall-chart";

type CostKey = "vmb" | "purchases" | "fees" | "storeCompensation";

export type ProfitBridgeProps = {
  /** Intäkt för prissatta order, i kronor (öre / 100) */
  revenue: number;
  /**
   * VMB-moms (vinstmarginalbeskattning), positivt belopp i kronor. Utelämnad = inget steg
   * (organisationen redovisar inte VMB).
   */
  vmb?: number;
  /** Inköp, positivt belopp i kronor */
  purchases: number;
  /** Avgifter (kortavgifter), positivt belopp i kronor */
  fees: number;
  /**
   * Butiksersättning = provision + hyra, positivt belopp i kronor. Utelämnad = inget eget
   * steg (beloppet ligger då i ett annat steg, t.ex. "Avgifter och butiker").
   */
  storeCompensation?: number;
  /** Intäkt för order utan inköpspris. Visas bredvid som "Ingår inte". */
  unpricedRevenue?: number;
  /** Exakt belopp i läsrutan, t.ex. formatSek eller v => formatKronor(v) */
  format: (v: number) => string;
  /** Axelns enhet, standard "kr" (kr/tkr/mkr väljs automatiskt) */
  unit?: AxisUnit;
  /** Kostnadspost som kräver åtgärd, t.ex. inköp över budget */
  flag?: { step: CostKey; note: string };
  /** Etiketter, om de ska avvika från standard */
  /** `loss` ersätter `profit` som etikett när resultatet är negativt (standard "Förlust"). */
  /**
   * `storeCompensationShort`: kort etikett för butiksersättningen när platsen inte räcker
   * (standard "Till butiken"; för alla butiker "Till butikerna").
   */
  labels?: Partial<
    Record<"revenue" | CostKey | "profit" | "loss" | "unpriced" | "storeCompensationShort", string>
  >;
  /**
   * Marginalen som andel (0,121), när den redan är räknad (t.ex. nyckeltalets bp / 10 000),
   * så att vattenfallet visar exakt samma tal som nyckeltalen. Utelämnad = vinst / intäkt.
   */
  margin?: number;
  /**
   * Marginalen i bp (nyckeltalets tal). Ges den visas marginalen i vattenfallet och i texten
   * med formatMarginBp, samma funktion som nyckeltalet, så att procenten alltid är lika.
   */
  marginBp?: number;
  height?: number;
  /** Skärmläsartext. Standard: en mening med alla belopp och marginalen. */
  summary?: string;
};

/**
 * Lönsamhetsbrygga (fas 4): Intäkt → (VMB-moms) → Inköp → Avgifter → Butiksersättning → Vinst,
 * för prissatta order, enligt docs/berakningar.md avsnitt 5. Avdragen ritas
 * som minskningar och summerar exakt till vinsten. Negativ vinst heter
 * "Förlust" och flaggas (signal + "! Under noll"), eftersom den kräver åtgärd.
 */
export function ProfitBridge(props: ProfitBridgeProps) {
  const { format, unit = "kr", height = 280, unpricedRevenue } = props;
  const { steps, text, unpricedLabel } = profitBridgeModel(props);
  return (
    <WaterfallChart
      steps={steps}
      format={format}
      unit={unit}
      height={height}
      summary={text}
      totalShareText={props.marginBp === undefined ? undefined : formatMarginBp(props.marginBp)}
      excluded={
        unpricedRevenue
          ? {
              label: unpricedLabel,
              value: unpricedRevenue,
              note: "Ingår inte",
              name: "Intäkt utan inköpspris",
            }
          : undefined
      }
    />
  );
}

export type ProfitBarRow = {
  label: string;
  /** Beloppet i kronor: intäkten och resultatet som de är, avdragen negativa. */
  value: number;
  kind: "revenue" | "cost" | "result" | "loss";
  /** Stapelns längd, 0–1 av intäkten (minst en synlig strimma för belopp över 0). */
  share: number;
};

/**
 * Raderna i den liggande bryggan (telefon): samma steg och samma belopp som vattenfallet,
 * en rad per steg med resultatet sist. Ren funktion (testas).
 */
export function profitBarRows(props: ProfitBridgeProps): ProfitBarRow[] {
  const { steps } = profitBridgeModel(props);
  const profit = steps.reduce((sum, s) => sum + s.value, 0);
  const scale = Math.max(props.revenue, ...steps.map((s) => Math.abs(s.value)), Math.abs(profit));
  const share = (v: number) =>
    scale > 0 && v !== 0 ? Math.max(0.02, Math.min(1, Math.abs(v) / scale)) : 0;
  return steps.map((s, i) => {
    const value = s.total ? profit : s.value;
    return {
      label: s.label,
      value,
      kind: s.total ? (profit < 0 ? "loss" : "result") : i === 0 ? "revenue" : "cost",
      share: share(value),
    };
  });
}

const BAR_FILL: Record<ProfitBarRow["kind"], string> = {
  revenue: "var(--bl-data-3)",
  cost: "var(--bl-fg-muted)",
  result: "var(--bl-data-1)",
  loss: "var(--bl-signal)",
};

/**
 * Bryggan för telefon: liggande staplar i stället för det höga vattenfallet. En rad per
 * steg (Intäkt, Inköp, …, Vår vinst) med beloppet sist på raden och en tunn stapel under,
 * i skala mot intäkten. Samma tal och samma text för skärmläsare som ProfitBridge.
 */
export function ProfitBars(props: ProfitBridgeProps) {
  const { format, unpricedRevenue, marginBp } = props;
  const { text, unpricedLabel } = profitBridgeModel(props);
  const rows = profitBarRows(props);
  return (
    <div data-profit-bars>
      <p className="sr-only">{text}</p>
      <ul className="flex flex-col gap-2.5" aria-hidden>
        {rows.map((r) => {
          const strong = r.kind === "result" || r.kind === "loss" || r.kind === "revenue";
          return (
            <li key={r.label} className="flex flex-col gap-1">
              <span className="flex items-baseline justify-between gap-3 text-sm">
                <span className={strong ? "min-w-0 text-fg" : "min-w-0 text-muted"}>{r.label}</span>
                <span
                  className={
                    r.kind === "loss"
                      ? "tnum shrink-0 font-medium text-signal-fg"
                      : r.kind === "result"
                        ? "tnum shrink-0 font-medium text-fg"
                        : "tnum shrink-0 text-fg"
                  }
                >
                  {r.kind === "cost" && r.value !== 0 ? "−" : ""}
                  {format(Math.abs(r.value))}
                </span>
              </span>
              <span className="block h-1.5 w-full rounded-full bg-line">
                <span
                  className="block h-full rounded-full"
                  style={{ width: `${r.share * 100}%`, background: BAR_FILL[r.kind] }}
                />
              </span>
            </li>
          );
        })}
      </ul>
      {marginBp !== undefined || unpricedRevenue ? (
        <p className="meta mt-2.5 text-subtle" aria-hidden>
          {[
            marginBp !== undefined ? `Marginal ${formatMarginBp(marginBp)}` : null,
            unpricedRevenue ? `${unpricedLabel}: ${format(unpricedRevenue)}, ingår inte` : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </p>
      ) : null}
    </div>
  );
}

/** Stegen och skärmläsartexten för bryggan. Ren funktion (testas). */
export function profitBridgeModel({
  revenue,
  vmb,
  purchases,
  fees,
  storeCompensation,
  unpricedRevenue,
  format,
  flag,
  labels = {},
  summary,
  margin: marginIn,
  marginBp,
}: ProfitBridgeProps): { steps: WaterfallStep[]; text: string; unpricedLabel: string } {
  const profit = revenue - (vmb ?? 0) - purchases - fees - (storeCompensation ?? 0);
  const margin = marginIn ?? (revenue ? profit / revenue : undefined);
  const marginText =
    marginBp !== undefined
      ? formatMarginBp(marginBp)
      : margin !== undefined
        ? formatPercent(margin)
        : undefined;
  const L = {
    revenue: labels.revenue ?? "Intäkt",
    vmb: labels.vmb ?? "VMB-moms",
    purchases: labels.purchases ?? "Inköp",
    fees: labels.fees ?? "Avgifter",
    storeCompensation: labels.storeCompensation ?? "Butiksersättning",
    profit: labels.profit ?? "Vinst",
    loss: labels.loss ?? "Förlust",
    unpriced: labels.unpriced ?? "Utan pris",
  };
  const loss = profit < 0;
  const resultLabel = loss ? L.loss : L.profit;
  const f = (k: CostKey) => (flag?.step === k ? { flag: true, note: flag.note } : {});

  const steps: WaterfallStep[] = [
    { label: L.revenue, value: revenue, name: `${L.revenue}, prissatta order` },
    ...(vmb !== undefined
      ? [{ label: L.vmb, value: -vmb, name: "VMB-moms (vinstmarginalbeskattning)", ...f("vmb") }]
      : []),
    { label: L.purchases, value: -purchases, name: "Inköp av pack", ...f("purchases") },
    // Steg som är 0 ritas inte (design.md 7): med kortavgift 0 % hoppar bryggan över avgifterna.
    ...(fees !== 0 || flag?.step === "fees"
      ? [{ label: L.fees, value: -fees, name: labels.fees ?? "Kortavgifter", ...f("fees") }]
      : []),
    ...(storeCompensation !== undefined
      ? [
          {
            label: L.storeCompensation,
            // Hela ord när platsen inte räcker (ordlistan avråder från förkortningar).
            short: labels.storeCompensationShort ?? "Till butiken",
            value: -storeCompensation,
            name: L.storeCompensation,
            ...f("storeCompensation"),
          },
        ]
      : []),
    {
      label: resultLabel,
      value: 0,
      total: true,
      name: resultLabel,
      ...(loss ? { flag: true, note: "Under noll" } : {}),
    },
  ];

  // Bara vanliga ord får liten bokstav; en butiks namn i etiketten ("Sega gubben 50 % av
  // vinsten") skrivs som det är.
  const lowerFirst = (t: string) =>
    /^(Butik|Till )/.test(t) ? t.charAt(0).toLowerCase() + t.slice(1) : t;
  const text =
    summary ??
    `${L.revenue} ${format(revenue)} minus ${vmb !== undefined ? `VMB-moms ${format(vmb)}, ` : ""}inköp ${format(purchases)}, ${L.fees.toLowerCase()} ${format(fees)}${storeCompensation !== undefined ? ` och ${lowerFirst(L.storeCompensation)} ${format(storeCompensation)}` : ""} ger ${resultLabel.toLowerCase()} ${format(loss ? -profit : profit)}${marginText !== undefined ? `, marginal ${marginText}` : ""}.${unpricedRevenue ? ` ${format(unpricedRevenue)} i intäkt saknar inköpspris och ingår inte.` : ""}`;

  return { steps, text, unpricedLabel: L.unpriced };
}
