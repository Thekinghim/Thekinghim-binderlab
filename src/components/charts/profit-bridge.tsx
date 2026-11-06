"use client";

import { formatPercent } from "@/lib/format";
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
}: ProfitBridgeProps): { steps: WaterfallStep[]; text: string; unpricedLabel: string } {
  const profit = revenue - (vmb ?? 0) - purchases - fees - (storeCompensation ?? 0);
  const margin = marginIn ?? (revenue ? profit / revenue : undefined);
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
    `${L.revenue} ${format(revenue)} minus ${vmb !== undefined ? `VMB-moms ${format(vmb)}, ` : ""}inköp ${format(purchases)}, ${L.fees.toLowerCase()} ${format(fees)}${storeCompensation !== undefined ? ` och ${lowerFirst(L.storeCompensation)} ${format(storeCompensation)}` : ""} ger ${resultLabel.toLowerCase()} ${format(loss ? -profit : profit)}${margin !== undefined ? `, marginal ${formatPercent(margin)}` : ""}.${unpricedRevenue ? ` ${format(unpricedRevenue)} i intäkt saknar inköpspris och ingår inte.` : ""}`;

  return { steps, text, unpricedLabel: L.unpriced };
}
