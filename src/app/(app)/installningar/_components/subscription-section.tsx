import Link from "next/link";

import {
  customerStateOn,
  invoiceBasis,
  machinesOn,
  mrrOn,
  planOn,
} from "@/analytics/subscriptions/billing";
import { MobileFold } from "@/components/ui/mobile-fold";
import { Card, CardBody } from "@/components/v2/card";
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
}: {
  user: SessionUser;
  organizationId: string;
  today: IsoDate;
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
    <Card
      id="abonnemang"
      className="scroll-mt-24"
      title="Abonnemang"
      actions={aside ? <span className="lk">{aside.replace(/\.$/, "")}</span> : undefined}
    >
      <CardBody className="flex flex-col gap-3">
        <p className="st-p">
          <b>{title}</b>
        </p>
        {operator ? (
          <p className="st-p">
            <Link href="/plattform" className="font-[550] text-v2-ink underline">
              Öppna Plattform →
            </Link>{" "}
            Alla kunder, planer, MRR och fakturaunderlag.
          </p>
        ) : null}
        {sub && months.length > 0 ? (
          <MobileFold
            summary="Visa underlag"
            meta={
              now && now.totals.length > 0
                ? `${monthLabel(current)}: ${now.totals.map((t) => formatMoney(t.netOre, t.currency)).join(" + ")} exkl. moms`
                : undefined
            }
          >
            <div className="flex flex-col gap-3">
              <p className="st-p">
                {mrr
                  ? `${formatInt(machinesOn(sub.machines, today))} automater i drift i dag, ${formatMoney(mrr.amountOre, mrr.currency)} per månad exkl. moms.`
                  : "Inget debiteras i dag."}{" "}
                Varje automat räknas per dag den är i drift. Underlaget visar vad som faktureras;
                inget dras automatiskt.
              </p>
              <div className="v2-table-wrap -mx-[18px] border-y border-v2-line2">
                <table className="v2-table">
                  <caption className="sr-only">Fakturaunderlag per månad</caption>
                  <thead>
                    <tr>
                      <th scope="col">Månad</th>
                      <th scope="col" className="num">
                        Automater
                      </th>
                      <th scope="col" className="num ph-hide">
                        Exkl. moms
                      </th>
                      <th scope="col" className="num">
                        Att betala
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {bases.map((b) => {
                      // Valutor blandas aldrig: byter planen valuta mitt i månaden visas båda.
                      const money = (pick: (t: (typeof b.totals)[number]) => number) =>
                        b.totals.length === 0
                          ? "–"
                          : b.totals.map((t) => formatMoney(pick(t), t.currency, 2)).join(" + ");
                      return (
                        <tr key={b.month}>
                          <td>
                            {monthLabel(b.month)}
                            {b.month === current ? (
                              <span className="block text-v2-xs text-v2-mute">preliminärt</span>
                            ) : null}
                          </td>
                          <td className="num">
                            {formatInt(b.activeMachines)}
                            <span className="block text-v2-xs text-v2-mute">
                              {formatInt(b.billableMachineDays)} dagar
                            </span>
                          </td>
                          <td className="num ph-hide">{money((t) => t.netOre)}</td>
                          <td className="num">{money((t) => t.totalOre)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
              {now ? (
                <p className="st-p">
                  {VAT_LABEL[now.vat.mode]}
                  {sub.customer.vatNumber ? ` · momsnr ${sub.customer.vatNumber}` : ""}.
                  {now.vat.note ? ` ${now.vat.note}` : ""}
                </p>
              ) : null}
            </div>
          </MobileFold>
        ) : null}
      </CardBody>
    </Card>
  );
}
