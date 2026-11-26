import type { Metadata } from "next";
import { Suspense } from "react";

import { connectivityView, milliToTenths, probabilityText } from "@/analytics/health";
import { fillLevels } from "@/analytics/visits";
import { ButtonLink } from "@/components/v2/button";
import { Card, CardBody } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { Notice } from "@/components/v2/notice";
import { formatInt, MINUS, NBSP } from "@/lib/format";
import { requireRoute, requireViewer } from "@/server/data/core";
import { loadAwishExpirySafe } from "@/server/awish/expiry-notice";

import { AwishExpiry } from "../../_awish/awish-expiry";
import { AwishFreshnessLine } from "../../_vakt/data-age-line";
import { WatchLines } from "../../_vakt/watch-lines";

import { AlertList } from "../_components/alert-list";
import { DriftFrame } from "../_components/drift-frame";
import { HealthTable, type HealthRow } from "../_components/health-table";
import { toAlertItems } from "../_lib/alert-items";
import { alertCountLink } from "../_lib/nav";
import {
  alertHeadline,
  connectionLabel,
  driftHeadline,
  firstSentence,
  formatWhen,
  healthRank,
  plural,
  sortAlerts,
} from "../_lib/display";
import { loadDriftOverview } from "../_lib/load";
import { glyphStatusOf } from "@/components/v2/machine-glyph-model";
import { loadMachineScreens } from "../../automater/_lib/v2-data";

export const metadata: Metadata = { title: "Drift" };

function tenthsText(tenths: number): string {
  const sign = tenths < 0 ? MINUS : "";
  const abs = Math.abs(tenths);
  return `${sign}${formatInt(Math.trunc(abs / 10))},${abs % 10}`;
}

/**
 * Drift: status per automat (i drift, misstänkt fel, ur drift …) härledd ur försäljningen när
 * leverantörens maskindata saknas, öppna larm med underlag och veckans besök.
 */
export default async function DriftPage() {
  const ctx = await requireRoute("drift");
  const now = new Date(ctx.now);
  const [overview, viewer, screens] = await Promise.all([
    loadDriftOverview(ctx),
    requireViewer(),
    loadMachineScreens(ctx.organization.id),
  ]);
  const awishExpiry = await loadAwishExpirySafe(viewer, now);
  const { health, data, plan } = overview;
  const machinesHeadline = driftHeadline(health);
  const openAlerts = sortAlerts(overview.openAlerts);
  // Alla automater i drift men larm öppna: rubriken bär det som ska göras.
  const allRunning =
    health.some((h) => h.status === "ok") &&
    health.every((h) => h.status === "ok" || h.status === "inactive");
  const alertTitle = allRunning ? alertHeadline(openAlerts) : null;
  const headline = alertTitle
    ? { title: alertTitle, aside: machinesHeadline.title }
    : machinesHeadline;

  const machineById = new Map(data.machines.map((m) => [m.id, m]));
  const connectivity = new Map(data.connectivity.map((c) => [c.machineId, c]));
  const fill = fillLevels(overview.capacities, data.stock);
  const lastSale = new Map<string, string>();
  for (const o of data.orders) {
    if (!o.machineId || !o.orderedAt) continue;
    const prev = lastSale.get(o.machineId);
    if (!prev || prev < o.orderedAt) lastSale.set(o.machineId, o.orderedAt);
  }
  // Det som gäller alla rader (t.ex. hur långt importen har kommit) står en gång
  // ovanför tabellen; cellen visar bara det som gäller automaten.
  const rest = (detail: string) => detail.slice(firstSentence(detail).length).trim();
  const rests = health.map((h) => rest(h.detail));
  const commonDetail =
    health.length > 1 && rests[0] && rests.every((r) => r === rests[0]) ? rests[0] : null;
  const rows: HealthRow[] = health.map((h) => {
    const m = machineById.get(h.machineId);
    const screen = screens.get(h.machineId);
    return {
      look: screen?.appearance,
      glyph: screen ? glyphStatusOf(screen.status) : undefined,
      machineId: h.machineId,
      code: m?.code ?? "",
      name: m?.name ?? "",
      status: h.status,
      since: formatWhen(h.since, ctx.timeZone, now),
      lastSale: formatWhen(lastSale.get(h.machineId) ?? null, ctx.timeZone, now),
      detail: commonDetail ? firstSentence(h.detail) : h.detail,
      rule: h.evidence.rule,
      expected: h.silence
        ? `${tenthsText(milliToTenths(h.silence.expectedMilli))}${NBSP}pack under tystnaden (${plural(h.silence.historyOrders, "order", "order")} i historiken)`
        : "",
      probability: h.silence
        ? `${probabilityText(h.silence.zeroProbabilityBp)} för noll försäljning`
        : "",
      rank: healthRank(h.status),
      fillBp: fill.get(h.machineId)?.bp ?? null,
      connection: connectionLabel(
        connectivityView(connectivity.get(h.machineId), now),
        ctx.timeZone,
        now,
      ),
    };
  });

  const items = toAlertItems(openAlerts, ctx.timeZone, now);
  const resolved = toAlertItems(overview.recentAlerts, ctx.timeZone, now);
  const critical = openAlerts.filter((a) => a.severity === "critical").length;
  const alertLink = alertCountLink(items.length, critical);

  const visits = plan.days.reduce((n, d) => n + d.stops.length, 0);

  return (
    <DriftFrame
      ctx={ctx}
      sub={
        <>
          <b>{headline.title}</b>
          {headline.aside ? <span>{headline.aside}</span> : null}
          {alertLink ? (
            // Antalet larm leder till listan (Notiser är bara inställningarna).
            <a href={alertLink.href} className="ops-link max-[900px]:min-h-0">
              {`${alertLink.label} →`}
            </a>
          ) : null}
        </>
      }
    >
      {/* Vakten: ingen får larm, kontrollen eller hämtningen har stannat, lagret eller
          automaternas status har inte lästs (Open API och webbpanelen), påfyllningar som
          inte når Awish. Under: hur färsk datan är och vägar som går via reservvägen. */}
      <Suspense fallback={null}>
        <WatchLines />
      </Suspense>
      <Suspense fallback={null}>
        <AwishFreshnessLine className="mb-3" />
      </Suspense>

      {awishExpiry ? <AwishExpiry notice={awishExpiry} className="mb-0 max-md:mb-0" /> : null}

      <div className="v2-cols">
        <div className="v2-stack">
          <Card
            title="Status per automat"
            count={rows.length > 0 ? rows.length : null}
            link={{ href: "/automater", label: "Automater" }}
          >
            {rows.length === 0 ? (
              <Empty
                title="Inga automater i organisationen."
                action={
                  <ButtonLink href="/automater" variant="act" touch>
                    Lägg till en automat
                  </ButtonLink>
                }
              />
            ) : (
              <HealthTable rows={rows} />
            )}
          </Card>
        </div>

        <div className="v2-stack">
          <Card
            id="larm-sektion"
            className="scroll-mt-28"
            title={
              items.length === 0
                ? "Inga öppna larm"
                : `${plural(items.length, "öppet larm", "öppna larm")}${critical > 0 ? `, ${formatInt(critical)} kritiska` : ""}`
            }
            link={{ href: "/drift/larm", label: "Notiser" }}
          >
            {overview.lastRun ? (
              <p className="ops-p border-b border-v2-line2 px-[18px] py-2.5 text-v2-xs">
                {`Koll ${formatWhen(overview.lastRun.ranAt, ctx.timeZone, now)}.`}
              </p>
            ) : null}
            {ctx.canSeeEconomy && !overview.lastRun ? (
              <div className="p-3">
                <Notice tone="info" title="Larm är inte igång än.">
                  {/* Miljövariabelns namn bara under utveckling: ägaren kan inte göra något med den. */}
                  {process.env.NODE_ENV === "production"
                    ? "Larmkollen har inte körts än."
                    : "Jobbet GET /api/cron/larm kräver CRON_SECRET och schemaläggning (Vercel Cron)."}
                </Notice>
              </div>
            ) : null}
            {overview.lastRun?.status === "failed" ? (
              <div className="p-3">
                <Notice tone="critical" title="Larmkollen misslyckades senast.">
                  {`Fel: ${overview.lastRun.error ?? "okänt"}`}
                </Notice>
              </div>
            ) : null}
            {items.length > 0 ? (
              <AlertList items={items} canAck={ctx.canEdit} />
            ) : overview.lastRun?.status !== "failed" ? (
              <Empty title="Allt lugnt.">Inget larm är öppet just nu.</Empty>
            ) : null}
            {resolved.length > 0 ? (
              <details className="ops-more border-t border-v2-line2 px-[18px] py-2">
                <summary>{`Lösta de senaste 7 dagarna (${formatInt(resolved.length)})`}</summary>
                <div className="-mx-[18px] mt-2 border-t border-v2-line2">
                  <AlertList items={resolved} canAck={false} />
                </div>
              </details>
            ) : null}
          </Card>

          <Card title="Besök i veckan" link={{ href: "/drift/besok", label: "Besöksplan" }}>
            <CardBody>
              <p className="tnum text-v2-2xl font-[650]">{formatInt(visits)}</p>
              <p className="ops-p">
                {visits === 0
                  ? "Inga besök behövs de närmaste 7 dagarna."
                  : `${plural(visits, "besök", "besök")} de närmaste 7 dagarna.`}
              </p>
            </CardBody>
          </Card>
        </div>
      </div>
    </DriftFrame>
  );
}
