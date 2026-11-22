import { ScrollToHash } from "@/components/ui/scroll-to-hash";
import { formatInt, formatKronor, formatMarginBp } from "@/lib/format";

import { adviceHeadline, adviceMargin, adviceWhere } from "../_lib/advice-text";
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
    <li
      key={r.titleId}
      className="flex flex-col gap-0.5 border-b border-v2-line2 px-[18px] py-3 last:border-b-0"
      data-testid="prisrad-rad"
    >
      <span className="text-v2-md font-[550] [overflow-wrap:anywhere] text-v2-ink">{r.name}</span>
      <span className="tnum text-v2-sm text-v2-mute">
        Säljs för {kr(r.salePriceOre)}
        {adviceWhere(r.where)} · inköp {kr(r.unitCostOre)} · marginal{" "}
        <span className="font-[550] text-v2-crit-text">{adviceMargin(r.marginBp, targetBp)}</span>
      </span>
      <span className="tnum text-v2-sm text-v2-ink">
        {r.suggestedPriceOre !== null && r.suggestedMarginBp !== null
          ? `Höj till ${kr(r.suggestedPriceOre)} för ${pct(r.suggestedMarginBp)} marginal`
          : "Inget pris når målet. Sänk inköpspriset eller målet."}
      </span>
    </li>
  );
  return (
    <section id="prisrad" aria-labelledby="prisrad-rubrik" className="v2-card scroll-mt-28">
      <ScrollToHash id="prisrad" />
      <div className="v2-card-hd">
        <h2>
          Prisråd
          {rows.length > 0 ? (
            <>
              <span aria-hidden="true">·</span>
              <span className="n">{formatInt(rows.length)}</span>
            </>
          ) : null}
        </h2>
      </div>
      <p id="prisrad-rubrik" className="px-[18px] pt-3 text-v2-md font-[550] text-v2-ink">
        {adviceHeadline(rows.length, targetBp)}
      </p>
      {rows.length > 0 ? (
        <>
          <ul className="mt-2 flex flex-col border-y border-v2-line2">{first.map(row)}</ul>
          {rest.length > 0 ? (
            <details className="border-b border-v2-line2">
              <summary className="flex min-h-11 cursor-pointer items-center px-[18px] text-v2-sm font-[550] text-v2-ink hover:bg-v2-hover">
                Visa alla {formatInt(rows.length)}
              </summary>
              <ul className="flex flex-col border-t border-v2-line2">{rest.map(row)}</ul>
            </details>
          ) : null}
        </>
      ) : null}
      <div className="flex flex-col gap-3 px-[18px] pt-3 pb-4">
        {rows.length > 0 ? (
          <p className="text-v2-sm text-v2-ink">
            Priset ändras i automatens system. Appen kan inte ändra det.
          </p>
        ) : null}
        <TargetMarginControl targetBp={targetBp} canEdit={canEdit} />
        <p className="text-v2-xs text-v2-mute">
          Marginalen är före butikernas andel, med senaste priset i automaten (30 dagar) och dagens
          inköpspris. Har automaterna olika pris räknas det lägsta, och raden säger var.
        </p>
      </div>
    </section>
  );
}
