import Link from "next/link";
import type { CSSProperties } from "react";

import {
  customerStateOn,
  invoiceBasis,
  machinesOn,
  mrrOn,
  planOn,
} from "@/analytics/subscriptions/billing";
import { MobileFold } from "@/components/ui/mobile-fold";
import { SectionHeader } from "@/components/ui/section-header";
import { addMonths, monthOf, type IsoDate } from "@/domain";
import { formatInt } from "@/lib/format";
import type { SessionUser } from "@/server/access";
import { VAT_LABEL, dayLabel, formatMoney, monthLabel } from "@/server/subscriptions/model";
import {
  isPlatformOperatorFor,
  loadMySubscriptionFor,
  type MySubscription,
} from "@/server/subscriptions/service";

/** Kundens egna ord för läget (plattformen säger "Betalar"). */
const CUSTOMER_STATE = {
  active: "Aktivt.",
  trial: "Provperiod.",
  paused: "Pausat.",
  ended: "Avslutat.",
} as const;

async function safeLoad(user: SessionUser, organizationId: string): Promise<MySubscription | null> {
  try {
    return await loadMySubscriptionFor(user, organizationId);
  } catch {
    return null;
  }
}

/**
 * Inställningar → Abonnemang: organisationens plan hos Binderlab och fakturaunderlaget för
 * de senaste månaderna. Bara läsning (planen ändras av Binderlab). Ägare och admin; RPC:n
 * my_subscription nekar andra. Plattformsoperatörer får en länk till /plattform.
 */
export async function SubscriptionSection({
  user,
  organizationId,
  today,
  index,
}: {
  user: SessionUser;
  organizationId: string;
  today: IsoDate;
  index: number;
}) {
  const [sub, operator] = await Promise.all([
    safeLoad(user, organizationId),
    isPlatformOperatorFor(user).catch(() => false),
  ]);
  if (!sub && !operator) return null;

  const plan = sub ? planOn(sub.periods, today) : null;
  const state = sub ? customerStateOn(sub, today) : "none";
  const mrr = sub ? mrrOn(sub, today) : null;
  const current = monthOf(today);
  // Innevarande och tre månader bakåt, men aldrig före planens första dag.
  const firstMonth = sub?.periods[0] ? monthOf(sub.periods[0].validFrom) : null;
  const months = firstMonth
    ? [0, -1, -2, -3].map((i) => addMonths(current, i)).filter((m) => m >= firstMonth)
    : [];
  const bases = sub ? months.map((m) => invoiceBasis(sub, m)) : [];
  const now = bases[0];
  const title = plan
    ? `Abonnemang: ${formatMoney(plan.pricePerMachineOre, plan.currency)} per automat och månad.`
    : operator
      ? "Ni driver plattformen."
      : "Inget abonnemang ännu.";
  const aside =
    state === "trial" && sub?.customer.trialEndsOn
      ? `Provperiod till och med ${dayLabel(sub.customer.trialEndsOn)}.`
      : state === "none"
        ? undefined
        : CUSTOMER_STATE[state];

  return (
    <section
      id="abonnemang"
      aria-labelledby="abonnemang-rubrik"
      className="rise flex scroll-mt-28 flex-col gap-8 max-md:gap-3"
      style={{ "--i": index } as CSSProperties}
    >
      <SectionHeader id="abonnemang-rubrik" size="md" title={title} aside={aside} />
      {operator ? (
        <p>
          <Link href="/plattform" className="text-fg underline">
            Öppna Plattform →
          </Link>{" "}
          <span className="text-muted">Alla kunder, planer, MRR och fakturaunderlag.</span>
        </p>
      ) : null}
      {sub && months.length > 0 ? (
        <MobileFold
          summary="Visa underlag"
          meta={
            now && now.totals[0]
              ? `${monthLabel(current)}: ${formatMoney(now.totals[0].netOre, now.totals[0].currency)}`
              : undefined
          }
        >
          <div className="flex max-w-3xl flex-col gap-4">
            <p className="text-muted">
              {mrr
                ? `${formatInt(machinesOn(sub.machines, today))} automater i drift i dag, ${formatMoney(mrr.amountOre, mrr.currency)} per månad exkl. moms.`
                : "Inget debiteras i dag."}{" "}
              Varje automat räknas per dag den är i drift. Binderlab fakturerar i efterskott; inget
              dras automatiskt.
            </p>
            <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
              <table className="w-full border-collapse text-base">
                <caption className="sr-only">Fakturaunderlag per månad</caption>
                <thead>
                  <tr className="border-b border-line-strong text-left">
                    <th scope="col" className="label h-9 pr-3 font-normal text-subtle">
                      Månad
                    </th>
                    <th scope="col" className="label h-9 px-3 text-right font-normal text-subtle">
                      Automater
                    </th>
                    <th
                      scope="col"
                      className="label hidden h-9 px-3 text-right font-normal text-subtle md:table-cell"
                    >
                      Exkl. moms
                    </th>
                    <th scope="col" className="label h-9 pl-3 text-right font-normal text-subtle">
                      Att betala
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {bases.map((b) => {
                    const t = b.totals[0];
                    return (
                      <tr key={b.month} className="border-b border-line">
                        <td className="py-2.5 pr-3 text-fg">
                          {monthLabel(b.month)}
                          {b.month === current ? (
                            <span className="block text-sm text-subtle">preliminärt</span>
                          ) : null}
                        </td>
                        <td className="tnum px-3 py-2.5 text-right">
                          {formatInt(b.activeMachines)}
                          <span className="block text-sm text-subtle">
                            {formatInt(b.billableMachineDays)} dagar
                          </span>
                        </td>
                        <td className="tnum hidden px-3 py-2.5 text-right md:table-cell">
                          {t ? formatMoney(t.netOre, t.currency, 2) : "–"}
                        </td>
                        <td className="tnum py-2.5 pl-3 text-right">
                          {t ? formatMoney(t.totalOre, t.currency, 2) : "–"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {now ? (
              <p className="text-sm text-muted">
                {VAT_LABEL[now.vat.mode]}
                {sub.customer.vatNumber ? ` · momsnr ${sub.customer.vatNumber}` : ""}.
                {now.vat.note ? ` ${now.vat.note}` : ""}
              </p>
            ) : null}
          </div>
        </MobileFold>
      ) : null}
    </section>
  );
}
