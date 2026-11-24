import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Badge } from "@/components/v2/badge";
import { ButtonLink } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { requireRoute, requireViewer } from "@/server/data/core";
import { loadPayoutsPageFor } from "@/server/payouts/service";

import { dayMonth, krExact } from "../../_components/fmt";
import { payoutBadge, warningViews } from "../_lib/model";
import { PayoutLines, Warnings } from "../_components/lines";
import "../_components/utbetalningar.css";

export const metadata: Metadata = { title: "Betala så här" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * En utbetalning (/pengar/utbetalningar/[id]): "Pengar in" och sammanfattningen, sedan
 * "Betala ut" med en rad per mottagare, Varför? och Markera som betald, och summan som
 * alltid är beloppet. Ägare och admin.
 */
export default async function PayoutPage({ params }: { params: Promise<{ id: string }> }) {
  const [ctx, { id }] = await Promise.all([requireRoute("utbetalningar"), params]);
  if (!UUID.test(id)) notFound();
  const viewer = await requireViewer();
  const now = new Date(ctx.now);
  const page = await loadPayoutsPageFor(viewer, now, { payoutId: id.toLowerCase() });
  const p = page.payouts[0];
  if (!p) notFound();
  const names = new Map(
    p.lines.flatMap((l) => l.stores.map((c) => [c.storeId, c.storeName] as const)),
  );
  const warnings = warningViews(
    p.allocation?.warnings ?? [],
    (s) => names.get(s) ?? "En butik",
    null,
  );
  const badge = payoutBadge(p.unpaidLines, p.allocation !== null);
  const t = p.allocation?.totals;

  return (
    <V2Page
      title="Betala så här"
      date={headerDate(now, ctx.timeZone)}
      tools={
        <ButtonLink href="/pengar/utbetalningar" size="sm">
          Alla utbetalningar
        </ButtonLink>
      }
    >
      <div className="ut" data-testid="utbetalning">
        <Card className="ut-full">
          <div className="ut-hero">
            <div>
              <div className="lbl">
                Pengar in{p.paidOn ? ` ${dayMonth(p.paidOn)}` : ""} · gäller {p.periodText}
                {p.basis === "inferred" ? " (uträknat)" : ""}
              </div>
              <div className="big" data-testid="amount-in">
                {krExact(p.amountOre)}
              </div>
            </div>
            <Badge tone={badge.tone}>{badge.text}</Badge>
          </div>
          {p.summary ? <p className="ut-summary">{p.summary}</p> : null}
          {p.basis === "inferred" && p.inferredNote ? (
            <p className="ut-summary">{p.inferredNote}</p>
          ) : null}
        </Card>

        <div className="ut-full">
          <Warnings items={warnings} />
        </div>

        <Card title="Betala ut">
          {p.allocation ? (
            <PayoutLines payout={p} today={page.today} />
          ) : (
            <div className="ut-empty">
              Uträkningen kunde inte göras än. Försök igen om en stund.
            </div>
          )}
        </Card>

        {t ? (
          <Card title="Så räknade vi">
            <div className="ut-rows">
              {[
                ["Försäljning", t.grossOre],
                ["Återbetalt till kunder", -t.refundsOre],
                ["Väntat från Nayax efter avgift", t.expectedNetOre],
                ["Pengar in", t.amountOre],
                ["Till butikerna", -t.storesOre],
                ["Inköpet tillbaka till partnern", -t.partnerReimbOre],
                ["Moms att spara", -t.vatOre],
                ["Vinst att dela", t.profitOre],
              ].map(([label, ore]) => (
                <div key={label as string} className="ut-row">
                  <div className="nm">{label}</div>
                  <div className={(ore as number) < 0 ? "am" : "am"}>{krExact(ore as number)}</div>
                </div>
              ))}
            </div>
          </Card>
        ) : null}
      </div>
    </V2Page>
  );
}
