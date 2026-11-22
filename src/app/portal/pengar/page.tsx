import type { Metadata } from "next";

import { Badge } from "@/components/v2/badge";
import { ButtonLink } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { advanceLine, advancesFor, advanceTotal } from "@/server/settlements/advance";
import { payoutDueDate, STATE_LABEL } from "@/server/settlements/model";
import { requirePortalContext } from "@/server/portal/session";
import { loadPortalMoney, type PortalContract } from "@/server/portal/settlements";

import { PortalPage } from "../_components/page-head";
import { dateText, kr, monthText } from "../_components/text";

export const metadata: Metadata = { title: "Avräkning" };

function contractStatus(c: PortalContract): string {
  if (c.terminatedOn) return `Uppsagt, slutar ${dateText(c.terminatedOn)}`;
  if (c.signedAt) {
    const who = c.signerName ? ` av ${c.signerName}` : "";
    return `Signerat ${dateText(c.signedAt.slice(0, 10))}${who}`;
  }
  return "Inte signerat än";
}

/**
 * Butikens pengar: avräkningen per månad (belopp, betald eller inte, PDF) och avtalet.
 * Allt via portal_settlements och portal_contracts (bara den egna butiken).
 */
export default async function PortalMoneyPage() {
  const ctx = await requirePortalContext();
  const { settlements, contracts, advances } = await loadPortalMoney(ctx);
  // Det som redan betalats i förskott för månaden (betalning för en egen period) dras av.
  const advanceOf = (s: (typeof settlements)[number]) =>
    advancesFor(advances, ctx.store.storeId, s.month);
  const leftOf = (s: (typeof settlements)[number]) => s.amountOre - advanceTotal(advanceOf(s));
  const unpaid = settlements.filter((s) => s.state === "unpaid" && leftOf(s) > 0);
  const toCome = unpaid.reduce((n, s) => n + leftOf(s), 0);
  const latest = settlements[0];

  return (
    <PortalPage
      title="Avräkning"
      sub={
        <>
          <b>
            {unpaid.length > 0
              ? `${kr(toCome)} på väg till er.`
              : latest
                ? "Allt är utbetalt."
                : "Ingen avräkning än."}
          </b>{" "}
          {unpaid.length > 0
            ? `Betalas senast ${dateText(payoutDueDate(unpaid[unpaid.length - 1]!.month))}.`
            : latest
              ? `Senaste: ${monthText(latest.month)}.`
              : "Första avräkningen kommer den 1:a nästa månad."}
        </>
      }
    >
      <div className="v2-cols">
        <Card title="Avräkningar">
          {settlements.length === 0 ? (
            <Empty
              title="Ingen avräkning än."
              action={<ButtonLink href="/portal">Till översikten</ButtonLink>}
            >
              Översikten visar er andel löpande.
            </Empty>
          ) : (
            <ul className="pt-list" aria-label="Avräkningar">
              {settlements.map((s) => (
                <li key={s.id} className="pt-item">
                  <div className="t">
                    <b>{monthText(s.month)}</b>
                    <small>
                      {s.state === "paid" && s.paidOn
                        ? `Betald ${dateText(s.paidOn)}`
                        : s.state === "unpaid"
                          ? `Senast ${dateText(payoutDueDate(s.month))}`
                          : (s.statement?.modelText ?? "")}
                    </small>
                    {s.state === "unpaid" && advanceLine(advanceOf(s)) ? (
                      <span className="text-v2-sm text-v2-ink">
                        {advanceLine(advanceOf(s))}. Kvar {kr(Math.max(0, leftOf(s)))}.
                      </span>
                    ) : null}
                  </div>
                  <div className="a">
                    <span className="pt-amount text-v2-lg">{kr(Math.abs(s.amountOre))}</span>
                    <Badge
                      tone={s.state === "unpaid" || s.state === "owed" ? "warning" : "success"}
                    >
                      {s.state === "owed" ? "Ni betalar" : STATE_LABEL[s.state]}
                    </Badge>
                    <a href={`/portal/avrakning/${s.id}`} className="v2-btn sm touch" download>
                      PDF
                    </a>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Ert avtal" id="ert-avtal">
          {contracts.length === 0 ? (
            <Empty title="Inget avtal finns här än." />
          ) : (
            <ul className="pt-list">
              {contracts.map((c) => (
                <li key={c.id} className="pt-item">
                  <div className="t">
                    <b>{c.title ?? "Placeringsavtal"}</b>
                    <small>
                      Från {dateText(c.validFrom)} · {contractStatus(c)}
                    </small>
                  </div>
                  {c.hasFile ? (
                    <div className="a">
                      <a href={`/portal/avtal/${c.id}`} className="v2-btn sm touch" download>
                        Ladda ner
                      </a>
                    </div>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </PortalPage>
  );
}
