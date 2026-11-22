import { Card, CardBody } from "@/components/v2/card";
import { Notice } from "@/components/v2/notice";
import { splitRows } from "@/app/rapport/_components/store-report";
import { formatInt } from "@/lib/format";
import {
  asStoreBasis,
  basisNotes,
  invoiceEmptyText,
  invoiceRows,
  invoiceTitle,
  isRev2,
  payerLines,
  recipientLines,
  salesNote,
  splitsOf,
  totalLabel,
  type CompensationStep,
  type StoreReport,
  type StoreWeek,
} from "@/reports";
import { visibleSteps } from "@/server/portal/model";

import { EvidenceDetails } from "./evidence";
import { Lead } from "./page-head";
import { dateText, kr, krExact, monthNameText, pct } from "./text";

/** Avsnitt som både översikten och rapportvyn använder. Allt ur StoreReport (@/reports). */

/** Raden överst i kortet Mest sålda titlar. */
export function TitlesHeader({ report }: { report: StoreReport }) {
  const top = report.topTitles[0];
  return (
    <Lead
      strong={top ? `${top.name} sålde mest.` : "Mest sålda titlar."}
      rest={
        top
          ? `${formatInt(top.orders)} pack, ${pct(top.shareBp)} av försäljningen i ${monthNameText(report.month)}.`
          : undefined
      }
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
  // Har veckan som pågår inte sålt än, säger den senaste veckan med försäljning mer.
  const latest =
    current && current.orders === 0
      ? report.weeks.filter((w) => w.range.end < current.range.start && w.orders > 0).at(-1)
      : undefined;
  const lead = best ? `Bästa veckan: ${nbsp(best.label)}.` : "Försäljning per vecka.";
  const rest = best
    ? `${kr(best.revenueOre)} på ${formatInt(best.orders)} pack.`
    : latest
      ? `${nbsp(latest.label)}: ${kr(latest.revenueOre)} på ${formatInt(latest.orders)} pack.`
      : current
        ? `Vecka ${current.week} pågår: ${kr(current.revenueOre)} på ${formatInt(current.orders)} pack hittills.`
        : undefined;
  return (
    <Card title="Per vecka">
      <CardBody>
        <Lead strong={lead} rest={rest} />
      </CardBody>
      <div className="v2-table-wrap border-t border-v2-line">
        <table className="v2-table">
          <caption className="sr-only">Försäljning per vecka</caption>
          <thead>
            <tr>
              <th scope="col">Vecka</th>
              <th scope="col" className="num">
                Pack
              </th>
              <th scope="col" className="num">
                Försäljning
              </th>
            </tr>
          </thead>
          <tbody>
            {report.weeks.map((w) => {
              const future = isFuture(w);
              return (
                <tr key={w.key}>
                  <th scope="row" className="text-left font-[450] text-v2-ink">
                    {nbsp(w.label)}
                    {future ? (
                      <span className="text-v2-faint"> · kommer</span>
                    ) : w === current ? (
                      <span className="text-v2-faint"> · pågår</span>
                    ) : w.partial ? (
                      <span className="text-v2-faint"> · del</span>
                    ) : null}
                  </th>
                  <td className="num text-v2-mute">
                    {future ? <span aria-label="Inte än">–</span> : formatInt(w.orders)}
                  </td>
                  <td className="num">
                    {future ? <span aria-label="Inte än">–</span> : kr(w.revenueOre)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

const STEP_LABEL: Record<CompensationStep["kind"], string> = {
  share: "Andel",
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
  const total = totalText(report, "Totalt");
  if (hasAgreement && splitsOf(c).length > 0) return <SplitSection report={report} />;
  // Hyran nämns bara när avtalet har hyra (de flesta har ingen).
  const rent = c.rentOre !== 0 || c.rentParts.length > 0;
  return (
    <Card title="Er ersättning" id="ersattning">
      <CardBody className="flex flex-col gap-3">
        <Lead
          // Hela kronor i meningen, som nyckeltalet; öret står i uträkningen under.
          strong={`${kr(c.totalOre)} till ${report.store.name}.`}
          rest={hasAgreement ? withPeriod(c.modelText) : "Inget avtal är registrerat för månaden."}
        />
        {!hasAgreement ? (
          <Notice tone="info" title="Inget avtal registrerat">
            Operatören har inte registrerat ert avtal i Binderlab, så ingen ersättning räknas.
            Kontakta operatören om ni har ett avtal.
          </Notice>
        ) : null}
      </CardBody>
      {hasAgreement ? (
        <ol className="pt-steps border-t border-v2-line">
          {steps.map((s, i) => (
            <li key={`${s.kind}-${i}`} className="pt-step">
              <span className="k">{STEP_LABEL[s.kind]}</span>
              <span className="l">{s.label}</span>
              <span className="c">{s.calculation}</span>
              <span className="v">{krExact(s.amountOre)}</span>
              <EvidenceDetails
                evidence={s.evidence}
                summary="Underlag"
                className="col-span-2 mt-1"
              />
            </li>
          ))}
          <li className="pt-step total">
            <span className="l">{total}</span>
            <span className="c">
              Provision {krExact(c.commissionOre)}
              {rent ? ` + hyra ${krExact(c.rentOre)}` : null}
            </span>
            <span className="v">{krExact(c.totalOre)}</span>
          </li>
        </ol>
      ) : null}
      {c.rentParts.length > 0 ? (
        <CardBody className="border-t border-v2-line">
          <p className="pt-note">
            Hyran räknas per dag när avtalet ändras mitt i månaden:{" "}
            {c.rentParts
              .map(
                (p) =>
                  `${krExact(p.monthlyRentOre)} per månad ${dateText(p.start)}–${dateText(p.end)} (${formatInt(p.days)} av ${formatInt(c.daysInMonth)} dagar)`,
              )
              .join("; ")}
            .
          </p>
        </CardBody>
      ) : null}
    </Card>
  );
}

/**
 * Vinstdelning: avtalet och en kort tabell Försäljning → Er andel. I översikten (live)
 * finns inga inköpspriser; då står andelen i månadsrapporten.
 */
function SplitSection({ report }: { report: StoreReport }) {
  const c = report.compensation;
  const rows = splitRows(c, isRev2(asStoreBasis(report.basis)));
  return (
    <Card title="Er andel" id="ersattning">
      <CardBody>
        <Lead
          strong={
            c.pending
              ? "Er andel räknas i månadsrapporten."
              : `${krExact(c.totalOre)} till ${report.store.name}.`
          }
          rest={`Avtal: ${withPeriod(c.modelText)}`}
        />
      </CardBody>
      <div className="v2-table-wrap border-t border-v2-line">
        <table className="v2-table">
          <caption className="sr-only">Vinstdelningen för månaden</caption>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key}>
                <th
                  scope="row"
                  className={`text-left ${r.strong ? "font-[650] text-v2-ink" : "font-[450] text-v2-mute"}`}
                >
                  {r.label}
                </th>
                <td className="num">
                  {r.amountOre === null ? (
                    <span className="text-v2-mute">i månadsrapporten</span>
                  ) : (
                    krExact(r.amountOre)
                  )}
                </td>
              </tr>
            ))}
          </tbody>
          {c.pending ? null : (
            <tfoot>
              <tr>
                <th scope="row" className="text-left font-[650]">
                  {totalText(report, "Er andel")}
                </th>
                <td className="num text-v2-lg">{krExact(c.totalOre)}</td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
      <CardBody className="border-t border-v2-line">
        <EvidenceDetails evidence={c.evidence} summary="Så räknas er andel" />
      </CardBody>
    </Card>
  );
}

/**
 * Rubriken på raden som avslutar uträkningen: som i PDF:en för en sparad rapport med
 * underlaget ("Er ersättning totalt, exklusive moms"), annars som förut.
 */
function totalText(report: StoreReport, fallback: string): string {
  const basis = asStoreBasis(report.basis);
  return isRev2(basis) ? totalLabel(basis) : fallback;
}

/** Etiketten utan radbrytning inne i "v. 44 (1 nov.)". */
function nbsp(text: string): string {
  return text.replace(/ /g, "\u00a0");
}

/** Meningen med exakt en avslutande punkt. */
function withPeriod(text: string): string {
  return /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
}

/**
 * Underlaget för butikens bokföring, som i den sparade rapporten: vilket bolag som betalar
 * ersättningen, mottagaren, avtalet och momsen. Ingenting för rapporter från före
 * uppgifterna fanns (eller för översiktens siffror, som inte är en sparad rapport).
 */
export function BasisSection({ report }: { report: StoreReport }) {
  const basis = asStoreBasis(report.basis);
  if (!basis) return null;
  const rows = invoiceRows(basis, report);
  const empty = rows.length === 0 ? invoiceEmptyText(basis, report) : null;
  return (
    <Card title="Underlag för bokföringen" id="underlag">
      <CardBody className="flex flex-col gap-4">
        <dl className="grid gap-x-8 gap-y-5 md:grid-cols-3">
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="v2-lab">Ersättningen betalas av</dt>
            <dd className="flex flex-col gap-0.5">
              {payerLines(basis, report.machines.length).map((line, i) => (
                <span
                  key={`${i}-${line}`}
                  className={i === 0 ? "font-[550]" : "tnum text-v2-sm text-v2-mute"}
                >
                  {line}
                </span>
              ))}
            </dd>
          </div>
          <div className="flex min-w-0 flex-col gap-1">
            <dt className="v2-lab">Mottagare</dt>
            <dd className="flex flex-col gap-0.5">
              {recipientLines(basis, report.store.name).map((line, i) => (
                <span
                  key={`${i}-${line}`}
                  className={i === 0 ? "font-[550]" : "tnum text-v2-sm text-v2-mute"}
                >
                  {line}
                </span>
              ))}
            </dd>
          </div>
          {empty ? (
            <div className="flex min-w-0 flex-col gap-1">
              <dt className="v2-lab">{invoiceTitle(basis)}</dt>
              <dd className="text-v2-sm text-v2-mute">{empty}</dd>
            </div>
          ) : rows.length > 0 ? (
            <div className="flex min-w-0 flex-col gap-1">
              <dt className="v2-lab">{invoiceTitle(basis)}</dt>
              <dd className="flex flex-col">
                {rows.map((row) => (
                  <span
                    key={row.key}
                    className={
                      row.strong
                        ? "flex items-baseline justify-between gap-4 border-t border-v2-line2 pt-1 font-[650]"
                        : "flex items-baseline justify-between gap-4 pb-1 text-v2-sm text-v2-mute"
                    }
                  >
                    <span>{row.label}</span>
                    <span className="tnum whitespace-nowrap">{krExact(row.amountOre)}</span>
                  </span>
                ))}
              </dd>
            </div>
          ) : null}
        </dl>
        <p className="pt-note">{basisNotes(basis, report, report.store.name).join(" ")}</p>
        {isRev2(basis) ? <p className="pt-note">{salesNote(report, report.store.name)}</p> : null}
      </CardBody>
    </Card>
  );
}
