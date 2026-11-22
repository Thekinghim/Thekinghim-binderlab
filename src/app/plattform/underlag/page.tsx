import type { Metadata } from "next";
import Link from "next/link";

import { sumByCurrency } from "@/analytics/subscriptions/billing";
import { PrintButton } from "@/components/report/print-button";
import { Empty } from "@/components/v2/empty";
import { addMonths, monthEnd, type IsoMonth } from "@/domain";
import { formatInt } from "@/lib/format";
import {
  VAT_LABEL,
  basisSpecification,
  formatMoney,
  formatMoneyList,
  monthLabel,
  parseMonthParam,
  plural,
} from "@/server/subscriptions/model";
import { loadInvoiceBasisFor } from "@/server/subscriptions/service";

import { requirePlatform } from "../_lib/context";

export const metadata: Metadata = { title: "Fakturaunderlag" };

/**
 * Fakturaunderlaget för en månad: en sida per kund (automatdagar, belopp, moms) som går att
 * skriva ut eller spara som PDF, och hela månaden som CSV. Inget faktureras automatiskt.
 * ?manad=ÅÅÅÅ-MM (standard innevarande) och ?kund=<id> (en kund).
 */
export default async function InvoiceBasisPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { user, today } = await requirePlatform();
  const params = await searchParams;
  const current = today.slice(0, 7) as IsoMonth;
  const month = parseMonthParam(params.manad, current);
  const only = typeof params.kund === "string" ? params.kund : null;
  const all = await loadInvoiceBasisFor(user, month);
  const rows = only ? all.filter((r) => r.customer.id === only) : all;
  const preliminary = monthEnd(month) >= today;
  const net = sumByCurrency(
    rows.flatMap((r) => r.basis.totals.map((t) => ({ currency: t.currency, amountOre: t.netOre }))),
  );
  const gross = sumByCurrency(
    rows.flatMap((r) =>
      r.basis.totals.map((t) => ({ currency: t.currency, amountOre: t.totalOre })),
    ),
  );
  const q = (m: IsoMonth) => `/plattform/underlag?manad=${m}${only ? `&kund=${only}` : ""}`;
  const csvHref = `/plattform/underlag/csv?manad=${month}${only ? `&kund=${only}` : ""}`;

  return (
    <div className="flex flex-col gap-[14px] max-[900px]:gap-3">
      <header className="flex flex-col gap-3" data-print="hide">
        <h1 className="text-v2-xl font-[650] text-v2-ink">
          <span className="tnum">{formatMoneyList(net)}</span> exkl. moms
        </h1>
        <p className="-mt-2 text-v2-md text-v2-mute">
          {monthLabel(month)} · {plural(rows.length, "kund", "kunder")} · att fakturera inkl. moms{" "}
          <span className="tnum">{formatMoneyList(gross)}</span>.
          {preliminary ? " Preliminärt: månaden pågår." : ""}
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <Link href={q(addMonths(month, -1))} className="v2-btn">
            ← {monthLabel(addMonths(month, -1))}
          </Link>
          {month < current ? (
            <Link href={q(addMonths(month, 1))} className="v2-btn">
              {monthLabel(addMonths(month, 1))} →
            </Link>
          ) : null}
          <a href={csvHref} className="v2-btn" download>
            Ladda ner CSV
          </a>
          <PrintButton />
          {only ? (
            <Link href={`/plattform/underlag?manad=${month}`} className="v2-btn plain">
              Visa alla kunder
            </Link>
          ) : null}
        </div>
      </header>

      {rows.length === 0 ? (
        <div className="v2-card">
          <Empty title="Inga kunder med plan." />
        </div>
      ) : (
        <div className="v2-stack">
          {rows.map(({ customer: c, basis: b }) => (
            <article
              key={c.id}
              data-theme="light"
              className="v2-card break-inside-avoid p-5 text-v2-ink md:p-8 print:break-after-page print:p-0 print:shadow-none"
              aria-label={`Underlag ${c.name}`}
            >
              <div className="flex flex-wrap items-start justify-between gap-4">
                <div className="flex min-w-0 flex-col gap-1">
                  <p className="text-v2-sm text-v2-mute">Fakturaunderlag · {monthLabel(month)}</p>
                  <h2 className="text-v2-xl font-[650] break-words">{c.name}</h2>
                  <p className="text-sm text-muted">
                    Land {c.customer.countryCode ?? "SE"}
                    {c.customer.vatNumber ? ` · Momsnr ${c.customer.vatNumber}` : ""} ·{" "}
                    {VAT_LABEL[b.vat.mode]}
                  </p>
                </div>
                <div className="text-right">
                  <p className="label text-subtle">Från</p>
                  <p>Binderlab</p>
                  {preliminary ? <p className="text-sm text-signal-fg">Preliminärt</p> : null}
                </div>
              </div>

              <div className="-mx-5 mt-6 overflow-x-auto px-5 md:mx-0 md:px-0">
                <table className="w-full border-collapse text-sm md:text-base">
                  <caption className="sr-only">Rader för {c.name}</caption>
                  <thead>
                    <tr className="border-b border-line-strong text-left">
                      <th scope="col" className="label py-2 pr-3 font-normal text-subtle">
                        Vad
                      </th>
                      <th
                        scope="col"
                        className="label px-3 py-2 text-right font-normal text-subtle"
                      >
                        <span className="md:hidden">Dagar</span>
                        <span className="max-md:hidden">Automatdagar</span>
                      </th>
                      <th
                        scope="col"
                        className="label hidden px-3 py-2 text-right font-normal text-subtle md:table-cell"
                      >
                        Pris/mån
                      </th>
                      <th
                        scope="col"
                        className="label py-2 pl-3 text-right font-normal text-subtle"
                      >
                        Belopp
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.lines.length === 0 ? (
                      <tr className="border-b border-line">
                        <td colSpan={4} className="py-3 text-muted">
                          {basisSpecification(b)}.
                        </td>
                      </tr>
                    ) : (
                      b.lines.map((l) => (
                        <tr
                          key={`${l.currency}-${l.pricePerMachineOre}`}
                          className="border-b border-line"
                        >
                          <td className="py-2 pr-3">
                            Automater i drift
                            <span className="tnum block text-sm text-muted md:hidden">
                              à {formatMoney(l.pricePerMachineOre, l.currency, 2)}/mån
                            </span>
                          </td>
                          <td className="tnum px-3 py-2 text-right">
                            {formatInt(l.machineDays)} / {formatInt(b.daysInMonth)}
                          </td>
                          <td className="tnum hidden px-3 py-2 text-right md:table-cell">
                            {formatMoney(l.pricePerMachineOre, l.currency, 2)}
                          </td>
                          <td className="tnum py-2 pl-3 text-right">
                            {formatMoney(l.netOre, l.currency, 2)}
                          </td>
                        </tr>
                      ))
                    )}
                  </tbody>
                  <tfoot>
                    {b.totals.map((t) => (
                      <tr key={t.currency}>
                        <td colSpan={4} className="pt-3">
                          <dl className="ml-auto grid max-w-xs grid-cols-2 gap-y-1 text-right">
                            <dt className="text-muted">Exkl. moms</dt>
                            <dd className="tnum">{formatMoney(t.netOre, t.currency, 2)}</dd>
                            <dt className="text-muted">Moms {formatInt(b.vat.rateBp / 100)} %</dt>
                            <dd className="tnum">{formatMoney(t.vatOre, t.currency, 2)}</dd>
                            <dt className="text-fg">Att betala</dt>
                            <dd className="tnum text-lg">
                              {formatMoney(t.totalOre, t.currency, 2)}
                            </dd>
                          </dl>
                        </td>
                      </tr>
                    ))}
                  </tfoot>
                </table>
              </div>

              <p className="mt-4 text-sm text-muted">
                {plural(b.activeMachines, "automat", "automater")} var aktiva i månaden (
                {formatInt(b.machineDays)} automatdagar
                {b.trialMachineDays > 0
                  ? `, varav ${formatInt(b.trialMachineDays)} i provperioden`
                  : ""}
                ). Pris per automat och månad, räknat per dag: pris × automatdagar ÷{" "}
                {formatInt(b.daysInMonth)}.
              </p>
              {b.vat.note ? <p className="mt-2 text-sm text-fg">{b.vat.note}</p> : null}
            </article>
          ))}
        </div>
      )}
    </div>
  );
}
