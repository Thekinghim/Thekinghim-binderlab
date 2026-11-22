import Link from "next/link";

import { ButtonLink } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { formatInt, NBSP } from "@/lib/format";
import { loadPeriod, requireRoute } from "@/server/data/core";
import { loadShops } from "@/server/data/v2/analytics/shops";

import { ShopsView } from "../../_components/v2/shops-view";
import "../../../pengar/_components/money.css";

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Butiker i V2 (/butiker, G4). Ägare, admin och läsare (requireRoute). Data: shops.ts (samma
 * laddare som den gamla listan, avräkningarna och betalningarna, oförändrade).
 */
export async function ShopsPage({ sp }: { sp: SearchParams }) {
  const ctx = await requireRoute("butiker");
  const [data, p] = await Promise.all([loadShops(sp), loadPeriod(sp)]);
  const days = p.key === "idag" ? "i dag" : `${formatInt(p.days)}${NBSP}d`;
  const valj = typeof sp.valj === "string" ? sp.valj : null;
  return (
    <V2Page
      title="Butiker"
      date={headerDate(new Date(ctx.now), ctx.timeZone)}
      period
      tools={
        ctx.canEdit ? (
          <ButtonLink href="/butiker/ny" size="md" className="max-md:hidden">
            Ny butik
          </ButtonLink>
        ) : undefined
      }
    >
      {!data || data.rows.length === 0 ? (
        <Card title="Butiker">
          <Empty
            title="Inga butiker ännu"
            action={
              ctx.canEdit ? (
                <ButtonLink href="/butiker/ny" variant="act">
                  Lägg till butik
                </ButtonLink>
              ) : undefined
            }
          >
            Lägg till butiken, villkoren och automaten på en minut.
          </Empty>
        </Card>
      ) : (
        <ShopsView
          rows={data.rows}
          payItems={data.pay.items}
          settlements={data.pay.settlements.map((s) => ({
            id: s.id,
            storeId: s.storeId,
            month: s.month,
            amountOre: s.amountOre,
            state: s.state,
            paidOn: s.paidOn,
            paidOre: s.paidOre,
            statement: s.statement
              ? {
                  modelText: s.statement.modelText,
                  steps: s.statement.steps.map((x) => ({
                    label: x.label,
                    calculation: x.calculation,
                    amountOre: x.amountOre,
                  })),
                  totalOre: s.statement.totalOre,
                }
              : null,
          }))}
          payments={data.payments.map((x) => ({
            id: x.id,
            storeId: x.storeId,
            paidOn: x.paidOn,
            amountOre: x.amountOre,
            periodStart: x.periodStart,
            periodEnd: x.periodEnd,
            parts: x.parts.map((q) => ({ month: q.month, amountOre: q.amountOre })),
          }))}
          storeOptions={data.pay.storeOptions}
          today={ctx.today}
          month={data.month}
          days={days}
          canEdit={data.canEdit}
          initialId={valj}
        />
      )}
      <p className="g4-note">
        Andelen och att betala räknas som avräkningen.{" "}
        <Link className="underline underline-offset-4" href="/butiker?vy=utbetalning">
          Utbetalning
        </Link>{" "}
        ·{" "}
        <Link className="underline underline-offset-4" href="/butiker?vy=lista">
          Nyckeltal och kontrakt
        </Link>{" "}
        ·{" "}
        <Link className="underline underline-offset-4" href="/butiker?vy=agare">
          Butiksägare
        </Link>
      </p>
    </V2Page>
  );
}
