import type { Metadata } from "next";
import Link from "next/link";

import { milliToTenths, probabilityText } from "@/analytics/health";
import { weekdayDay } from "@/analytics/todos/text";
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
  sentenceEnd,
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
    };
  });

  const items = toAlertItems(openAlerts, ctx.timeZone, now);
  const resolved = toAlertItems(overview.recentAlerts, ctx.timeZone, now);
  const critical = overview.openAlerts.filter((a) => a.severity === "critical").length;
  const firstDay = plan.days[0];

  return (
    <div className="flex flex-col gap-12 md:gap-16">
      <SectionHeader
        as="h1"
        size="xl"
        eyebrow="Drift"
        title={headline.title}
        aside={headline.aside}
        meta={[
          {
            label: "Automater",
            value: formatInt(health.filter((h) => h.status !== "inactive").length),
          },
          { label: "Öppna larm", value: formatInt(overview.openAlerts.length) },
          {
            label: "Besök i veckan",
            value: formatInt(plan.days.reduce((n, d) => n + d.stops.length, 0)),
          },
        ]}
      />

      <section aria-labelledby="halsa" className="flex flex-col gap-6">
        <SectionHeader
          id="halsa"
          index={1}
          eyebrow="Maskinhälsa"
          title="Status per automat."
          aside={
            commonDetail ??
            (data.vendorConfigured
              ? "Från automaternas egna statusmeddelanden."
              : "Härledd ur försäljningen.")
          }
        />
        {!data.vendorConfigured ? (
          <StateMessage
            kind="not-configured"
            compact
            message="Leverantörens maskindata (ur drift, felkoder) hämtas inte ännu."
            detail="Status härleds ur försäljningen tills maskindata från Awish är kopplad."
            diagnostics={[{ label: "Källa", value: "awish_grpc · väntar på specifikation" }]}
          />
        ) : null}
        {rows.length === 0 ? (
          <StateMessage
            kind="empty"
            message="Inga automater i organisationen."
            action={{ label: "Lägg till en automat", href: "/automater" }}
          />
        ) : (
          <div className="flex flex-col gap-3">
            <p className="max-w-3xl text-sm text-muted">
              {data.vendorConfigured
                ? "Status från automaternas egna statusmeddelanden."
                : "Status härleds ur försäljningen: tystnad jämförs med samma veckodag och timme de senaste 8 veckorna."}
            </p>
            <HealthTable rows={rows} />
          </div>
        )}
      </section>

      <section
        aria-labelledby="larm"
        className="flex scroll-mt-28 flex-col gap-6"
        id="larm-sektion"
      >
        <SectionHeader
          id="larm"
          index={2}
          eyebrow="Larm"
          title={
            items.length === 0
              ? "Inga öppna larm."
              : `${plural(items.length, "öppet larm", "öppna larm")}${critical > 0 ? `, ${formatInt(critical)} kritiska` : ""}.`
          }
          aside={
            overview.lastRun
              ? `Senast utvärderat ${formatWhen(overview.lastRun.ranAt, ctx.timeZone, now)}${overview.lastRun.status === "failed" ? ", körningen misslyckades" : ""}.`
              : ctx.canSeeEconomy
                ? "Larmjobbet har inte körts ännu."
                : "Samma problem larmar en gång, inte vid varje kontroll."
          }
          actions={
            <Link href="/drift/larm" className="rounded-xs text-sm text-muted hover:text-fg">
              Larminställningar →
            </Link>
          }
        />
        {ctx.canSeeEconomy && !overview.lastRun ? (
          <StateMessage
            kind="not-configured"
            compact
            message="Larmjobbet har inte körts i den här miljön."
            detail="Larm skapas och skickas när jobbet körs, normalt var 10:e minut."
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
            message="Senaste körningen av larmjobbet misslyckades."
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

      <section aria-labelledby="besok" className="flex flex-col gap-6">
        <SectionHeader
          id="besok"
          index={3}
          eyebrow="Besök"
          title={plan.days.length === 0 ? "Inga besök behövs i veckan." : sentenceEnd(plan.summary)}
          aside={
            firstDay && plan.days.length === 1
              ? `${capitalizeFirst(weekdayDay(firstDay.date))}: ${firstDay.stops.map((x) => x.machineName).join(", ")}.`
              : firstDay
                ? `Först ut: ${sentenceEnd(firstDay.title)}`
                : "Lagret räcker i alla automater de närmaste 7 dagarna."
          }
          actions={
            <Link href="/drift/besok" className="rounded-xs text-sm text-muted hover:text-fg">
              Besöksplan →
            </Link>
          }
        />
      </section>
    </div>
  );
}

function capitalizeFirst(text: string): string {
  return text.charAt(0).toLocaleUpperCase("sv-SE") + text.slice(1);
}
