import { formatInt, formatKronor, formatMarginBp } from "@/lib/format";

import { adviceHeadline, adviceMargin } from "../_lib/advice-text";
import type { PriceAdviceView } from "../_lib/price-advice";
import { TargetMarginControl } from "./target-margin";

/** "249 kr" · "213,21 kr". */
function kr(ore: number): string {
  return formatKronor(ore / 100, { decimals: ore % 100 === 0 ? 0 : 2 });
}

const pct = (bp: number) => formatMarginBp(bp, 0);

/**
 * Prisråd: produkterna under målet med pris, inköpspris, marginal och "Höj till X kr för
 * Y % marginal". Kort: de fem sämsta visas, resten bakom "Visa alla". Bara ett råd; priset
 * ändras i automatens system. Marginalen är före butikernas andel.
 */
export function PriceAdviceSection({
  advice,
  canEdit,
}: {
  advice: PriceAdviceView;
  canEdit: boolean;
}) {
  const { rows, targetBp } = advice;
  const first = rows.slice(0, 5);
  const rest = rows.slice(5);
  const row = (r: (typeof rows)[number]) => (
    <li key={r.titleId} className="flex flex-col gap-1 px-4 py-3" data-testid="prisrad-rad">
      <span className="text-base font-medium [overflow-wrap:anywhere] text-fg">{r.name}</span>
      <span className="tnum text-base text-muted">
        Säljs för {kr(r.salePriceOre)} · inköp {kr(r.unitCostOre)} · marginal{" "}
        <span className="font-medium text-signal-fg">{adviceMargin(r.marginBp, targetBp)}</span>
      </span>
      <span className="tnum text-base text-fg">
        {r.suggestedPriceOre !== null && r.suggestedMarginBp !== null
          ? `Höj till ${kr(r.suggestedPriceOre)} för ${pct(r.suggestedMarginBp)} marginal`
          : "Inget pris når målet. Sänk inköpspriset eller målet."}
      </span>
    </li>
  );
  return (
    <section
      id="prisrad"
      aria-labelledby="prisrad-rubrik"
      className="flex scroll-mt-28 flex-col gap-4 border-t border-line py-8 md:py-12"
    >
      <div className="flex flex-col gap-1">
        <p className="label text-subtle">Prisråd</p>
        <h2 id="prisrad-rubrik" className="text-xl font-medium text-fg">
          {adviceHeadline(rows.length, targetBp)}
        </h2>
      </div>
      {rows.length > 0 ? (
        <>
          <ul className="flex flex-col divide-y divide-line rounded-md border border-line">
            {first.map(row)}
          </ul>
          {rest.length > 0 ? (
            <details>
              <summary className="inline-flex min-h-11 cursor-pointer items-center text-base text-fg underline underline-offset-4">
                Visa alla {formatInt(rows.length)}
              </summary>
              <ul className="mt-2 flex flex-col divide-y divide-line rounded-md border border-line">
                {rest.map(row)}
              </ul>
            </details>
          ) : null}
          <p className="text-base text-fg">
            Priset ändras i automatens system. Appen kan inte ändra det.
          </p>
        </>
      ) : null}
      <TargetMarginControl targetBp={targetBp} canEdit={canEdit} />
      <p className="meta text-subtle">
        Marginalen är före butikernas andel, med senaste priset i automaten (30 dagar) och dagens
        inköpspris.
      </p>
    </section>
  );
}
