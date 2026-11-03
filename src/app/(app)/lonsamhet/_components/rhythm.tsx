import { Panel } from "@/components/ui/frame";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { formatInt, NBSP } from "@/lib/format";

import { SalesHeatmap } from "../../automater/_components/charts";
import { hourRange } from "../../automater/_lib/model";
import type { HeatmapView } from "../../automater/_lib/types";
import type { MoverKind, MoverList } from "../_lib/movers";

import { MoversList } from "./movers";

const WEEKDAYS = ["måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag", "söndag"];

function peakCell(heat: HeatmapView): { weekday: number; hour: number } | null {
  let best: { weekday: number; hour: number; v: number } | null = null;
  heat.values.forEach((row, r) =>
    row.forEach((v, c) => {
      if (v > 0 && (best === null || v >= best.v))
        best = { weekday: r, hour: heat.firstHour + c, v };
    }),
  );
  return best;
}

/**
 * Försäljningsrytm (köp per veckodag och timme, värmekarta) och topplistan med förändring
 * mot jämförelseperioden. Samma order som resten av sidan (period och filter).
 */
export function RhythmSection({
  heat,
  days,
  movers,
  compareLabel,
}: {
  heat: HeatmapView;
  days: number;
  movers: Record<MoverKind, MoverList>;
  /** "mot 4 okt.–3 nov." eller null utan jämförelseperiod. */
  compareLabel: string | null;
}) {
  // Samma topp som värmekartan markerar (vid lika: den sista), så att texten och rutan stämmer.
  const peak = peakCell(heat);
  return (
    <div className="grid grid-cols-1 gap-x-10 gap-y-12 lg:grid-cols-12">
      <section aria-labelledby="rytm" className="flex min-w-0 flex-col gap-6 lg:col-span-7">
        <SectionHeader
          id="rytm"
          eyebrow={`Försäljningsrytm · ${formatInt(days)}${NBSP}d`}
          title="När säljer vi?"
          aside={
            peak ? `Flest köp ${WEEKDAYS[peak.weekday] ?? ""} ${hourRange(peak.hour)}.` : undefined
          }
          size="md"
        />
        {heat.total > 0 ? (
          <Panel grid marks className="fade-in">
            <SalesHeatmap heat={heat} days={days} />
          </Panel>
        ) : (
          <StateMessage compact kind="empty" code="0 köp" message="Inga köp med klockslag." />
        )}
      </section>
      <section aria-labelledby="topplista" className="flex min-w-0 flex-col gap-6 lg:col-span-5">
        <SectionHeader
          id="topplista"
          eyebrow="Topplista"
          title="Vad går upp och ned?"
          aside={
            compareLabel ? `Intäkt, ${compareLabel.replace(/\.$/, "")}.` : "Intäkt i perioden."
          }
          size="md"
        />
        <MoversList lists={movers} />
      </section>
    </div>
  );
}
