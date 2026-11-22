import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { connectivityView, type TimelineEntry } from "@/analytics/health";
import { weekdayDay } from "@/analytics/todos/text";
import { channelText, fillLevels, fillPercent } from "@/analytics/visits";
import { StatusGlyph, StatusTag, type Status } from "@/components/ui/status-tag";
import { ButtonLink } from "@/components/v2/button";
import { Card, CardBody } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { fillTone } from "@/components/v2/fill-bar";
import { KpiBand, KpiTile } from "@/components/v2/kpi-tile";
import type { IsoDate } from "@/domain";
import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";
import { requireRoute } from "@/server/data/core";

import { AlertList } from "../../_components/alert-list";
import { DriftFrame } from "../../_components/drift-frame";
import { toAlertItems } from "../../_lib/alert-items";
import { connectionLabel, firstSentence, healthTagFor, plural } from "../../_lib/display";
import { loadMachineTimeline } from "../../_lib/load";

export const metadata: Metadata = { title: "Tidslinje" };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const RANGES = [1, 7, 30] as const;

const KIND_LABEL: Record<TimelineEntry["kind"], string> = {
  sales: "Försäljning",
  refill: "Påfyllning",
  count: "Inventering",
  waste: "Svinn",
  adjustment: "Justering",
  transfer: "Flytt",
  signal: "Automaten",
  incident_opened: "Ärende",
  incident_closed: "Ärende löst",
};

function glyphOf(e: TimelineEntry): Status {
  if (e.severity === "critical") return "critical";
  if (e.severity === "warning") return "warning";
  return e.kind === "sales" ? "ok" : "neutral";
}

/**
 * Tidslinjen för en automat: försäljning per timme (per dag över 7 dagar), påfyllningar,
 * inventeringar, svinn, ärenden och larm, senaste först.
 */
export default async function MachineTimelinePage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireRoute("drift");
  const { id } = await params;
  if (!UUID.test(id)) notFound();
  const sp = await searchParams;
  const requested = Number(Array.isArray(sp.dagar) ? sp.dagar[0] : sp.dagar);
  const days = (RANGES as readonly number[]).includes(requested) ? requested : 7;
  const data = await loadMachineTimeline(ctx, id.toLowerCase(), days);
  if (!data) notFound();
  const now = new Date(ctx.now);

  const sold = data.entries.filter((e) => e.kind === "sales").reduce((n, e) => n - e.packs, 0);
  const refilled = data.entries.filter((e) => e.kind === "refill").reduce((n, e) => n + e.packs, 0);
  const connection = connectionLabel(
    connectivityView(data.connectivity ?? undefined, now),
    ctx.timeZone,
    now,
  );
  // Awish säger offline: etiketten säger det rakt ut. Strömmen av enligt butikens tider:
  // "Strömmen av" (väntat, inget fel).
  const tag = data.health ? healthTagFor(data.health.status, connection) : null;
  const byDay = new Map<string, TimelineEntry[]>();
  for (const e of data.entries) {
    const list = byDay.get(e.date);
    if (list) list.push(e);
    else byDay.set(e.date, [e]);
  }
  const alertItems = toAlertItems(data.alerts, ctx.timeZone, now);
  const fill =
    fillLevels(
      data.slots.map((s) => ({
        machineId: data.machine.id,
        titleId: s.titleId,
        capacity: s.capacity,
        channels: s.channels,
      })),
      data.slots.map((s) => ({ machineId: data.machine.id, titleId: s.titleId, onHand: s.onHand })),
    ).get(data.machine.id) ?? null;

  const openAlerts = alertItems.filter((a) => a.open).length;

  return (
    <DriftFrame
      ctx={ctx}
      title={data.machine.code}
      sub={
        <>
          <b>{`${data.machine.name}: ${tag ? tag.label.toLowerCase() : "okänd status"}.`}</b>
          <span>
            {data.health
              ? firstSentence(data.health.detail)
              : `${plural(sold, "pack sålt", "pack sålda")} de senaste ${plural(days, "dagen", "dagarna")}.`}
          </span>
        </>
      }
    >
      <div className="ops-bar">
        {/* Perioden styr talen nedan (Sålda, Påfyllda) och händelserna. */}
        <nav aria-label="Period" className="ops-seg">
          {RANGES.map((r) => (
            <Link
              key={r}
              href={`/drift/automat/${data.machine.id}?dagar=${r}`}
              aria-current={r === days ? "page" : undefined}
            >
              {r === 1 ? "1 dygn" : `${r} dagar`}
            </Link>
          ))}
        </nav>
        {tag ? (
          <StatusTag status={tag.status} className="max-[900px]:hidden">
            {tag.label}
          </StatusTag>
        ) : null}
      </div>

      <KpiBand>
        <KpiTile label="Sålda pack" value={formatInt(sold)} compare={`${formatInt(days)} d`} />
        <KpiTile
          label="Påfyllda pack"
          value={formatInt(refilled)}
          compare={`${formatInt(days)} d`}
        />
        {fill ? (
          <KpiTile
            label="Fyllt"
            value={`${fillPercent(fill.bp)}${NBSP}%`}
            compare={`${formatInt(fill.units)}/${formatInt(fill.capacity)} pack`}
          />
        ) : null}
        {connection ? <KpiTile label="Awish" value={connection.text} /> : null}
      </KpiBand>

      {fill ? (
        <Card
          title="Fack"
          count={fill.emptyTitles > 0 ? fill.emptyTitles : null}
          actions={
            <span className="text-v2-xs text-v2-mute">
              {fill.emptyTitles > 0
                ? `${plural(fill.emptyTitles, "titel slut", "titlar slut")}`
                : `${formatInt(fill.units)}/${formatInt(fill.capacity)} pack`}
            </span>
          }
        >
          <CardBody>
            <ul
              aria-label="Fack"
              className="ops-tiles"
              title="Från Awish, uppdateras var femte minut"
            >
              {data.slots.map((s) => {
                const empty = s.onHand === 0;
                const bp = Math.round((Math.min(s.onHand, s.capacity) * 10_000) / s.capacity);
                return (
                  <li key={s.titleId} className={cn("ops-tile", empty && "empty")}>
                    <span className="flex items-baseline justify-between gap-2">
                      <span className="truncate text-v2-xs font-[550] text-v2-ink">
                        {channelText(s.channels) || "–"}
                      </span>
                      <span className="tnum text-v2-xs text-v2-mute">
                        {`${formatInt(s.onHand)}/${formatInt(s.capacity)}`}
                      </span>
                    </span>
                    <span className="v2-track block w-full" aria-hidden="true">
                      <i
                        className={fillTone(bp)}
                        style={{ transform: `scaleX(${Math.min(1, bp / 10_000)})` }}
                      />
                    </span>
                    <span className="truncate text-v2-xs text-v2-mute">{s.titleName}</span>
                  </li>
                );
              })}
            </ul>
          </CardBody>
        </Card>
      ) : null}

      {alertItems.length > 0 ? (
        <Card
          title={`${plural(alertItems.length, "larm", "larm")} de senaste 7 dagarna`}
          actions={
            <span className="text-v2-xs text-v2-mute">{`${formatInt(openAlerts)} öppna`}</span>
          }
        >
          <AlertList items={alertItems} canAck={ctx.canEdit} />
        </Card>
      ) : null}

      <Card
        title={
          data.entries.length === 0
            ? "Inga händelser i perioden"
            : `${plural(data.entries.length, "händelse", "händelser")}`
        }
        actions={
          <span className="text-v2-xs text-v2-mute">
            {days > 7 ? "Försäljningen per dag" : "Försäljningen per timme"}
          </span>
        }
      >
        {data.entries.length === 0 ? (
          <Empty
            title="Inget hände."
            action={
              days < 30 ? (
                <ButtonLink href={`/drift/automat/${data.machine.id}?dagar=30`} touch>
                  Visa 30 dagar
                </ButtonLink>
              ) : undefined
            }
          >
            {`Ingen försäljning, påfyllning eller ärende i ${data.machine.code} de senaste ${plural(days, "dagen", "dagarna")}.`}
          </Empty>
        ) : (
          <ol>
            {[...byDay].map(([date, entries]) => (
              <li key={date}>
                <h3 className="ops-group">{weekdayDay(date as IsoDate)}</h3>
                <ol className="ops-list">
                  {entries.map((e) => (
                    <li
                      key={e.key}
                      className="grid grid-cols-[3rem_minmax(0,1fr)] gap-x-3 sm:grid-cols-[3rem_8rem_minmax(0,1fr)]"
                    >
                      <span className="tnum pt-px text-v2-xs text-v2-mute">{e.time}</span>
                      <span className="hidden items-center gap-1.5 text-v2-xs font-[550] text-v2-mute sm:flex">
                        <StatusGlyph status={glyphOf(e)} size={8} />
                        {KIND_LABEL[e.kind]}
                      </span>
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-v2-sm text-v2-ink">
                          {e.severity === "critical" ? (
                            <span className="sr-only">Kräver åtgärd: </span>
                          ) : null}
                          {e.title}
                        </span>
                        {e.detail ? (
                          <span className="text-v2-xs text-v2-mute">{e.detail}</span>
                        ) : null}
                      </div>
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </DriftFrame>
  );
}
