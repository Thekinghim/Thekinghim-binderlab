import type { Metadata } from "next";
import Link from "next/link";

import { Badge } from "@/components/v2/badge";
import { Button, ButtonLink } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { V2Page, headerDate } from "@/components/v2/shell/page";
import { requireRoute, requireViewer } from "@/server/data/core";
import { loadPayoutsPageFor } from "@/server/payouts/service";

import { dayMonth, krExact } from "../_components/fmt";
import { payoutBadge, warningViews } from "./_lib/model";
import { AddPayout } from "./_components/add-payout";
import { RecipientList, Warnings } from "./_components/lines";
import "./_components/utbetalningar.css";

export const metadata: Metadata = { title: "Utbetalningar" };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Pengar → Utbetalningar (/pengar/utbetalningar): "Att betala just nu" över alla
 * utbetalningar från Nayax, en rad per mottagare med Betala, varningarna med en åtgärd var
 * och utbetalningarna (nyast först). Ägare och admin.
 */
export default async function PayoutsPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const [ctx, sp] = await Promise.all([requireRoute("utbetalningar"), searchParams]);
  const viewer = await requireViewer();
  const now = new Date(ctx.now);
  const page = await loadPayoutsPageFor(viewer, now);
  const storeNames = new Map<string, string>();
  for (const p of page.payouts) {
    for (const l of p.lines) for (const c of l.stores) storeNames.set(c.storeId, c.storeName);
  }
  const latest = page.payouts[0] ?? null;
  const warnings = warningViews(
    [
      ...page.warnings,
      ...page.payouts
        .filter((p) => p.unpaidLines > 0)
        .flatMap((p) => p.allocation?.warnings ?? [])
        .filter((w) => w.code !== "DIFF_EXPECTED" && w.code !== "NEGATIVE_OWNER"),
      ...(latest && latest.unpaidLines > 0 ? (latest.allocation?.warnings ?? []) : []).filter(
        (w) => w.code === "DIFF_EXPECTED" || w.code === "NEGATIVE_OWNER",
      ),
    ],
    (id) => storeNames.get(id) ?? "En butik",
    latest ? `/pengar/utbetalningar/${latest.id}` : null,
  );
  const ownerLineIds = page.payouts
    .flatMap((p) => p.lines)
    .filter((l) => l.kind === "owner" && l.leftOre > 0)
    .map((l) => l.id);
  const allPaid = page.recipients.length === 0;
  const add = (
    <AddPayout
      today={page.today}
      defaultOpen={sp["lagg-in"] === "1"}
      trigger={
        <Button size="lg" variant="act" data-testid="add-payout">
          Lägg in utbetalning från Nayax
        </Button>
      }
    />
  );

  return (
    <V2Page title="Utbetalningar" date={headerDate(now, ctx.timeZone)}>
      <div className="ut" data-testid="utbetalningar">
        <Card className="ut-full">
          <div className="ut-hero">
            <div>
              <div className="lbl">{allPaid ? "Att betala" : "Att betala just nu"}</div>
              <div className="big" data-testid="to-pay">
                {krExact(page.toPayOre)}
              </div>
            </div>
            <div className="acts">
              {add}
              {!allPaid ? (
                <ButtonLink href="/pengar/utbetalningar/export" size="lg" prefetch={false}>
                  Ladda ner betallista
                </ButtonLink>
              ) : null}
            </div>
          </div>
        </Card>

        <div className="ut-full">
          <Warnings items={warnings} />
        </div>

        <Card title="Betala ut" count={page.recipients.length || null}>
          {allPaid && page.ownerLeftOre === 0 ? (
            <div className="ut-empty" data-testid="all-paid">
              <b>Allt betalt ✓</b>
              Nästa gång Nayax betalar, lägg in utbetalningen här.
            </div>
          ) : (
            <>
              {allPaid ? (
                <div className="ut-empty" data-testid="all-paid">
                  <b>Allt betalt ✓</b>
                </div>
              ) : null}
              <RecipientList
                recipients={page.recipients}
                ownerLeftOre={page.ownerLeftOre}
                ownerLineIds={ownerLineIds}
                today={page.today}
              />
            </>
          )}
        </Card>

        <Card title="Utbetalningar från Nayax" count={page.payouts.length || null}>
          {page.payouts.length === 0 ? (
            <div className="ut-empty">Inga utbetalningar än.</div>
          ) : (
            <div className="ut-list">
              {page.payouts.slice(0, 50).map((p) => {
                const badge = payoutBadge(p.unpaidLines, p.allocation !== null);
                return (
                  <Link
                    key={p.id}
                    href={`/pengar/utbetalningar/${p.id}`}
                    className="ut-card"
                    data-payout={p.id}
                  >
                    <div>
                      <div className="t">Pengar in {krExact(p.amountOre)}</div>
                      <div className="d">
                        {p.paidOn ? `${dayMonth(p.paidOn)} · ` : ""}gäller {p.periodText}
                        {p.basis === "inferred" ? " (uträknat)" : ""}
                      </div>
                    </div>
                    <Badge tone={badge.tone}>{badge.text}</Badge>
                    {p.summary ? <div className="s">{p.summary}</div> : null}
                  </Link>
                );
              })}
            </div>
          )}
        </Card>
      </div>
    </V2Page>
  );
}
