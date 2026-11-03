import type { Metadata } from "next";
import Link from "next/link";

import { milliToTenths, probabilityText } from "@/analytics/health";
import { fillLevels } from "@/analytics/visits";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { formatInt, MINUS, NBSP } from "@/lib/format";
import { requireRoute } from "@/server/data/core";

import { AlertList } from "../_components/alert-list";
import { HealthTable, type HealthRow } from "../_components/health-table";
import { toAlertItems } from "../_lib/alert-items";
import {
  alertHeadline,
  driftHeadline,
  firstSentence,
  formatWhen,
  healthRank,
  plural,
  sortAlerts,
} from "../_lib/display";
import { loadDriftOverview } from "../_lib/load";

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
  const overview = await loadDriftOverview(ctx);
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
    return {
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
    };
  });

  const items = toAlertItems(openAlerts, ctx.timeZone, now);
  const resolved = toAlertItems(overview.recentAlerts, ctx.timeZone, now);
  const critical = overview.openAlerts.filter((a) => a.severity === "critical").length;

  return (
    <div className="flex flex-col gap-10 md:gap-12">
      <div className="rise" style={{ "--i": 0 } as React.CSSProperties}>
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow="Drift"
          title={headline.title}
          aside={headline.aside}
          actions={
            <Link
              href="/drift/besok"
              className="inline-flex h-9 items-center rounded-sm border border-line-strong bg-surface px-3.5 text-base text-fg transition-colors hover:bg-hover"
            >
              {`Besök i veckan: ${formatInt(plan.days.reduce((n, d) => n + d.stops.length, 0))} →`}
            </Link>
          }
        />
      </div>

      <section
        aria-labelledby="halsa"
        className="rise flex flex-col gap-6"
        style={{ "--i": 1 } as React.CSSProperties}
      >
        <SectionHeader id="halsa" size="md" title="Status per automat." />
        {rows.length === 0 ? (
          <StateMessage
            kind="empty"
            message="Inga automater i organisationen."
            action={{ label: "Lägg till en automat", href: "/automater" }}
          />
        ) : (
          <HealthTable rows={rows} />
        )}
      </section>

      <section
        aria-labelledby="larm"
        className="rise flex scroll-mt-28 flex-col gap-6"
        id="larm-sektion"
        style={{ "--i": 2 } as React.CSSProperties}
      >
        <SectionHeader
          id="larm"
          size="md"
          title={
            items.length === 0
              ? "Inga öppna larm."
              : `${plural(items.length, "öppet larm", "öppna larm")}${critical > 0 ? `, ${formatInt(critical)} kritiska` : ""}.`
          }
          aside={
            overview.lastRun
              ? `Koll ${formatWhen(overview.lastRun.ranAt, ctx.timeZone, now)}.`
              : undefined
          }
          actions={
            <Link href="/drift/larm" className="rounded-xs text-sm text-muted hover:text-fg">
              Inställningar →
            </Link>
          }
        />
        {ctx.canSeeEconomy && !overview.lastRun ? (
          <StateMessage
            kind="not-configured"
            compact
            message="Larm är inte igång än."
            diagnostics={[
              { label: "Jobb", value: "GET /api/cron/larm" },
              { label: "Kräver", value: "CRON_SECRET och schemaläggning (Vercel Cron)" },
            ]}
          />
        ) : null}
        {overview.lastRun?.status === "failed" ? (
          <StateMessage
            kind="error"
            compact
            message="Larmkollen misslyckades senast."
            diagnostics={[{ label: "Fel", value: overview.lastRun.error ?? "okänt" }]}
          />
        ) : null}
        {items.length > 0 ? <AlertList items={items} canAck={ctx.canEdit} /> : null}
        {resolved.length > 0 ? (
          <details>
            <summary className="w-fit cursor-pointer rounded-xs text-sm text-muted hover:text-fg">
              {`Lösta de senaste 7 dagarna (${formatInt(resolved.length)})`}
            </summary>
            <div className="mt-4">
              <AlertList items={resolved} canAck={false} />
            </div>
          </details>
        ) : null}
      </section>
    </div>
  );
}
