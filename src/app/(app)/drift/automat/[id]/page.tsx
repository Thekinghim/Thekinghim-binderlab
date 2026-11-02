import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import type { TimelineEntry } from "@/analytics/health";
import { weekdayDay } from "@/analytics/todos/text";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { StatusGlyph, StatusTag, type Status } from "@/components/ui/status-tag";
import type { IsoDate } from "@/domain";
import { formatInt } from "@/lib/format";
import { requireRoute } from "@/server/data/core";

import { AlertList } from "../../_components/alert-list";
import { toAlertItems } from "../../_lib/alert-items";
import { firstSentence, HEALTH_TAG, plural } from "../../_lib/display";
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
  const tag = data.health ? HEALTH_TAG[data.health.status] : null;
  const byDay = new Map<string, TimelineEntry[]>();
  for (const e of data.entries) {
    const list = byDay.get(e.date);
    if (list) list.push(e);
    else byDay.set(e.date, [e]);
  }
  const alertItems = toAlertItems(data.alerts, ctx.timeZone, now);

  return (
    <div className="flex flex-col gap-12">
      <SectionHeader
        as="h1"
        size="xl"
        eyebrow={`Tidslinje / ${data.machine.code}`}
        title={`${data.machine.name}: ${tag ? tag.label.toLowerCase() : "okänd status"}.`}
        aside={
          data.health
            ? firstSentence(data.health.detail)
            : `${plural(sold, "pack sålt", "pack sålda")} de senaste ${plural(days, "dagen", "dagarna")}.`
        }
        meta={[
          { label: "Period", value: `${formatInt(days)} d` },
          { label: "Sålda pack", value: formatInt(sold) },
          { label: "Påfyllda pack", value: formatInt(refilled) },
        ]}
      />

      <nav aria-label="Period" className="flex flex-wrap items-center gap-2">
        {RANGES.map((r) => (
          <Link
            key={r}
            href={`/drift/automat/${data.machine.id}?dagar=${r}`}
            aria-current={r === days ? "page" : undefined}
            className={
              r === days
                ? "inline-flex h-8 items-center rounded-sm border border-line-strong bg-hover px-3 text-sm text-fg"
                : "inline-flex h-8 items-center rounded-sm border border-line px-3 text-sm text-muted hover:text-fg"
            }
          >
            {r === 1 ? "1 dygn" : `${r} dagar`}
          </Link>
        ))}
        {tag ? <StatusTag status={tag.status}>{tag.label}</StatusTag> : null}
      </nav>

      {alertItems.length > 0 ? (
        <section aria-labelledby="automat-larm" className="flex flex-col gap-6">
          <SectionHeader
            id="automat-larm"
            index={1}
            eyebrow="Larm"
            title={`${plural(alertItems.length, "larm", "larm")} de senaste 7 dagarna.`}
            aside={`${formatInt(alertItems.filter((a) => a.open).length)} öppna.`}
            size="md"
          />
          <AlertList items={alertItems} canAck={ctx.canEdit} />
        </section>
      ) : null}

      <section aria-labelledby="handelser" className="flex flex-col gap-6">
        <SectionHeader
          id="handelser"
          index={alertItems.length > 0 ? 2 : 1}
          eyebrow="Händelser"
          title={
            data.entries.length === 0
              ? "Inga händelser i perioden."
              : `${plural(data.entries.length, "händelse", "händelser")}.`
          }
          aside={days > 7 ? "Försäljningen visas per dag." : "Försäljningen visas per timme."}
          size="md"
        />
        {data.entries.length === 0 ? (
          <StateMessage
            kind="empty"
            message={`Ingen försäljning, påfyllning eller ärende i ${data.machine.code} de senaste ${plural(days, "dagen", "dagarna")}.`}
            action={
              days < 30
                ? { label: "Visa 30 dagar", href: `/drift/automat/${data.machine.id}?dagar=30` }
                : undefined
            }
          />
        ) : (
          <ol className="flex flex-col gap-8">
            {[...byDay].map(([date, entries]) => (
              <li key={date} className="flex flex-col gap-2">
                <h3 className="label text-muted">{weekdayDay(date as IsoDate)}</h3>
                <ol className="flex flex-col divide-y divide-line border-y border-line">
                  {entries.map((e) => (
                    <li
                      key={e.key}
                      className="grid grid-cols-[3.5rem_1fr] gap-x-3 py-3 sm:grid-cols-[3.5rem_8rem_1fr]"
                    >
                      <span className="meta tnum pt-0.5 text-subtle">{e.time}</span>
                      <span className="label hidden items-center gap-1.5 pt-1 text-subtle sm:flex">
                        <StatusGlyph status={glyphOf(e)} size={8} />
                        {KIND_LABEL[e.kind]}
                      </span>
                      <div className="flex min-w-0 flex-col gap-0.5">
                        <span className="text-sm text-fg">
                          {e.severity === "critical" ? (
                            <span className="sr-only">Kräver åtgärd: </span>
                          ) : null}
                          {e.title}
                        </span>
                        {e.detail ? <span className="text-sm text-muted">{e.detail}</span> : null}
                      </div>
                    </li>
                  ))}
                </ol>
              </li>
            ))}
          </ol>
        )}
      </section>
    </div>
  );
}
