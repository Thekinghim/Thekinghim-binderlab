import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { formatInt } from "@/lib/format";
import type { CompensationStep, StoreReport, StoreWeek } from "@/reports";
import { visibleSteps } from "@/server/portal/model";

import { EvidenceDetails } from "./evidence";
import { dateText, kr, krExact, monthNameText, pct } from "./text";

/** Avsnitt som både översikten och rapportvyn använder. Allt ur StoreReport (@/reports). */

export function TitlesHeader({ report }: { report: StoreReport }) {
  const top = report.topTitles[0];
  return (
    <SectionHeader
      index={3}
      eyebrow="Mest sålda titlar"
      title={top ? `${top.name} sålde mest.` : "Mest sålda titlar."}
      aside={
        top
          ? `${formatInt(top.orders)} pack, ${pct(top.shareBp)} av försäljningen i ${monthNameText(report.month)}.`
          : undefined
      }
      size="md"
    />
  );
}

/**
 * Försäljning per vecka. Med `today` (pågående månad) visas kommande veckor med
 * "–" i stället för 0, och "Bästa veckan" först när minst två hela veckor är slut.
 */
export function WeeksBlock({ report, today }: { report: StoreReport; today?: string }) {
  const isFuture = (w: StoreWeek) => today !== undefined && w.range.start > today;
  const isOver = (w: StoreWeek) => today === undefined || w.range.end < today;
  const whole = report.weeks.filter((w) => !w.partial && isOver(w));
  const best =
    whole.length >= 2
      ? whole.reduce<StoreWeek | null>(
          (b, w) => (b === null || w.revenueOre > b.revenueOre ? w : b),
          null,
        )
      : today === undefined
        ? report.weeks.reduce<StoreWeek | null>(
            (b, w) => (w.orders > 0 && (b === null || w.revenueOre > b.revenueOre) ? w : b),
            null,
          )
        : null;
  const current =
    today !== undefined
      ? report.weeks.find((w) => w.range.start <= today && w.range.end >= today)
      : undefined;
  return (
    <>
      <SectionHeader
        index="03.2"
        eyebrow="Per vecka"
        title={best ? `Bästa veckan: ${nbsp(best.label)}.` : "Försäljning per vecka."}
        aside={
          best
            ? `${kr(best.revenueOre)} på ${formatInt(best.orders)} pack.`
            : current
              ? `Vecka ${current.week} pågår: ${kr(current.revenueOre)} på ${formatInt(current.orders)} pack hittills.`
              : undefined
        }
        size="md"
      />
      <table className="w-full text-base">
        <caption className="sr-only">Försäljning per vecka</caption>
        <thead>
          <tr className="border-b border-line-strong">
            <th scope="col" className="label h-9 text-left font-normal text-subtle">
              Vecka
            </th>
            <th scope="col" className="label h-9 pl-3 text-right font-normal text-subtle">
              Pack
            </th>
            <th scope="col" className="label h-9 pl-3 text-right font-normal text-subtle">
              Försäljning
            </th>
          </tr>
        </thead>
        <tbody>
          {report.weeks.map((w) => {
            const future = isFuture(w);
            return (
              <tr key={w.key} className="h-11 border-b border-line">
                <th scope="row" className="text-left font-normal text-fg">
                  {nbsp(w.label)}
                  {future ? (
                    <span className="meta text-subtle"> · kommer</span>
                  ) : w === current ? (
                    <span className="meta text-subtle"> · pågår</span>
                  ) : w.partial ? (
                    <span className="meta text-subtle"> · del</span>
                  ) : null}
                </th>
                <td className="tnum pl-3 text-right text-muted">
                  {future ? <span aria-label="Inte än">–</span> : formatInt(w.orders)}
                </td>
                <td className="tnum pl-3 text-right whitespace-nowrap text-fg">
                  {future ? <span aria-label="Inte än">–</span> : kr(w.revenueOre)}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

const STEP_LABEL: Record<CompensationStep["kind"], string> = {
  commission: "Provision",
  no_commission: "Utan provision",
  no_agreement: "Utan avtal",
  rent: "Hyra",
  total: "Totalt",
};

export function CompensationSection({
  report,
  hasAgreement,
}: {
  report: StoreReport;
  hasAgreement: boolean;
}) {
  const c = report.compensation;
  const steps = visibleSteps(c.steps);
  return (
    <section
      className="flex flex-col gap-10 border-t border-line py-16"
      aria-labelledby="ersattning"
    >
      <SectionHeader
        id="ersattning"
        index={4}
        eyebrow="Er ersättning"
        title={`${krExact(c.totalOre)} till ${report.store.name}.`}
        aside={hasAgreement ? withPeriod(c.modelText) : "Inget avtal är registrerat för månaden."}
        meta={[
          { label: "Provision", value: krExact(c.commissionOre) },
          { label: "Hyra", value: krExact(c.rentOre) },
          { label: "Totalt", value: krExact(c.totalOre) },
        ]}
      />
      {!hasAgreement ? (
        <StateMessage
          kind="not-configured"
          message="Operatören har inte registrerat ert avtal i Binderlab, så ingen ersättning räknas."
          detail="Kontakta operatören om ni har ett avtal om provision eller hyra."
        />
      ) : (
        <ol className="flex flex-col border-t border-line-strong">
          {steps.map((s, i) => (
            <li
              key={`${s.kind}-${i}`}
              className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6 gap-y-1 border-b border-line py-4 md:grid-cols-[10rem_minmax(0,1fr)_auto]"
            >
              <span className="label text-subtle">{STEP_LABEL[s.kind]}</span>
              <div className="col-span-2 flex min-w-0 flex-col gap-1 md:col-span-1">
                <span className="text-base text-fg">{s.label}</span>
                <span className="text-sm text-muted">{s.calculation}</span>
                <EvidenceDetails evidence={s.evidence} summary="Underlag" className="mt-1" />
              </div>
              <span className="tnum col-start-2 row-start-1 text-right text-md text-fg md:col-start-3">
                {krExact(s.amountOre)}
              </span>
            </li>
          ))}
          <li className="grid grid-cols-[minmax(0,1fr)_auto] items-baseline gap-x-6 py-4 md:grid-cols-[10rem_minmax(0,1fr)_auto]">
            <span className="label text-fg">Totalt</span>
            <span className="hidden text-sm text-muted md:block">
              Provision {krExact(c.commissionOre)} + hyra {krExact(c.rentOre)}
            </span>
            <span className="tnum text-right text-xl font-medium text-fg">
              {krExact(c.totalOre)}
            </span>
          </li>
        </ol>
      )}
      {c.rentParts.length > 0 ? (
        <p className="max-w-2xl text-sm text-muted">
          Hyran räknas per dag när avtalet ändras mitt i månaden:{" "}
          {c.rentParts
            .map(
              (p) =>
                `${krExact(p.monthlyRentOre)} per månad ${dateText(p.start)}–${dateText(p.end)} (${formatInt(p.days)} av ${formatInt(c.daysInMonth)} dagar)`,
            )
            .join("; ")}
          .
        </p>
      ) : null}
    </section>
  );
}

/** Etiketten utan radbrytning inne i "v. 44 (1 nov.)". */
function nbsp(text: string): string {
  return text.replace(/ /g, "\u00a0");
}

/** Meningen med exakt en avslutande punkt. */
function withPeriod(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}
