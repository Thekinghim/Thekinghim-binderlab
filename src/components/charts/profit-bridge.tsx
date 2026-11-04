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
  /** Butiksersättning = provision + hyra, positivt belopp i kronor */
  storeCompensation: number;
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
  labels?: Partial<Record<"revenue" | CostKey | "profit" | "loss" | "unpriced", string>>;
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
export function ProfitBridge({
  revenue,
  vmb,
  purchases,
  fees,
  storeCompensation,
  unpricedRevenue,
  format,
  unit = "kr",
  flag,
  labels = {},
  height = 280,
  summary,
}: ProfitBridgeProps) {
  const profit = revenue - (vmb ?? 0) - purchases - fees - storeCompensation;
  const margin = revenue ? profit / revenue : undefined;
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
      ? [{ label: L.fees, value: -fees, name: "Kortavgifter", ...f("fees") }]
      : []),
    {
      label: L.storeCompensation,
      // Hela ord när platsen inte räcker (ordlistan avråder från förkortningar).
      short: "Till butiken",
      value: -storeCompensation,
      name: "Butiksersättning (butikens del)",
      ...f("storeCompensation"),
    },
    {
      label: resultLabel,
      value: 0,
      total: true,
      name: resultLabel,
      ...(loss ? { flag: true, note: "Under noll" } : {}),
    },
  ];

  const text =
    summary ??
    `${L.revenue} ${format(revenue)} minus ${vmb !== undefined ? `VMB-moms ${format(vmb)}, ` : ""}inköp ${format(purchases)}, avgifter ${format(fees)} och butiksersättning ${format(storeCompensation)} ger ${resultLabel.toLowerCase()} ${format(loss ? -profit : profit)}${margin !== undefined ? `, marginal ${formatPercent(margin)}` : ""}.${unpricedRevenue ? ` ${format(unpricedRevenue)} i intäkt saknar inköpspris och ingår inte.` : ""}`;

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
              label: L.unpriced,
              value: unpricedRevenue,
              note: "Ingår inte",
              name: "Intäkt utan inköpspris",
            }
          : undefined
      }
    />
  );
}
