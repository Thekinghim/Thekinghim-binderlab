import type { Metadata } from "next";
import Link from "next/link";

import { businessDateAt } from "@/analytics/todos/time";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { REFUND_NONE_KEY } from "@/domain/refunds";
import { formatInt, formatPeriod } from "@/lib/format";
import { isoDateToShellDate, loadPeriod, requireRoute } from "@/server/data/core";

import { formatWhen, plural } from "../../drift/_lib/display";
import { InboxKpis } from "../_components/inbox-kpis";
import { IncidentTable, type IncidentListRow } from "../_components/incident-table";
import { loadInbox, type IncidentRow } from "../_lib/load";
import { KIND_LABEL, kronorOfOre, STATUS_LABEL } from "../_lib/model";

export const metadata: Metadata = { title: "Inkorg" };

interface StatRow {
  readonly key: string;
  readonly label: string;
  readonly count: number;
  readonly open: number;
  readonly refundedOre: number;
  readonly refundCount: number;
}

function StatTable({ caption, rows, first }: { caption: string; rows: StatRow[]; first: string }) {
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[22rem] text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr className="label border-b border-line-strong text-subtle">
            <th scope="col" className="h-9 text-left font-normal">
              {first}
            </th>
            <th scope="col" className="h-9 text-right font-normal">
              Ärenden
            </th>
            <th scope="col" className="h-9 text-right font-normal">
              Öppna
            </th>
            <th scope="col" className="h-9 text-right font-normal">
              Återbetalt
            </th>
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {rows.map((r) => (
            <tr key={r.key}>
              <td className="py-2.5 pr-3 text-fg">{r.label}</td>
              <td className="tnum py-2.5 text-right text-fg">{formatInt(r.count)}</td>
              <td className="tnum py-2.5 text-right text-muted">{formatInt(r.open)}</td>
              <td className="tnum py-2.5 text-right text-fg">
                {r.refundedOre > 0 ? kronorOfOre(r.refundedOre) : "–"}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function inPeriod(iso: string | null, start: string, end: string, timeZone: string): boolean {
  if (!iso) return false;
  const day = businessDateAt(iso, timeZone);
  return day >= start && day <= end;
}

/**
 * Inkorg: kundärenden (kund som inte fick vara, fel belopp, återbetalning) kopplade till
 * automat, order och tidpunkt. Statistik per automat och titel för perioden. Återbetalningarna
 * räknas med @/domain/refunds som en separat justering (docs/berakningar.md, avsnitt 14); sidan
 * Lönsamhet visar den som en egen rad under vinsten.
 */
export default async function InboxPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireRoute("inkorg");
  if (!ctx.canSeeEconomy) {
    return (
      <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-8 px-4 pt-8 pb-16 md:px-8 md:pt-12">
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow="Inkorg"
          title="Kundärenden hanteras av ägare och admin."
        />
        <StateMessage
          kind="denied"
          message="Ärenden innehåller återbetalningar och visas inte för påfyllare."
          detail="Ser du ett fel på en automat? Registrera påfyllning eller säg till ägaren."
          action={{ label: "Öppna Drift", href: "/drift" }}
        />
      </div>
    );
  }
  const p = await loadPeriod(await searchParams);
  const data = await loadInbox(ctx, p.period);
  const periodLabel = formatPeriod({
    start: isoDateToShellDate(p.period.start),
    end: isoDateToShellDate(p.period.end),
  });
  const now = new Date(ctx.now);
  const machine = new Map(data.machines.map((m) => [m.id, m]));
  const title = new Map(data.titles.map((t) => [t.id, t.name]));
  const member = new Map(data.members.map((m) => [m.userId, m.name]));

  const open = data.incidents.filter((i) => i.status !== "resolved");
  const createdIn = data.incidents.filter((i) =>
    inPeriod(i.startedAt, p.period.start, p.period.end, ctx.timeZone),
  );
  const resolvedIn = data.incidents.filter(
    (i) =>
      i.status === "resolved" && inPeriod(i.endedAt, p.period.start, p.period.end, ctx.timeZone),
  );
  const relevant = data.incidents.filter(
    (i) =>
      i.status !== "resolved" ||
      createdIn.includes(i) ||
      resolvedIn.includes(i) ||
      (i.refundedOn !== null && i.refundedOn >= p.period.start && i.refundedOn <= p.period.end),
  );

  const statsBy = (
    keyOf: (i: IncidentRow) => string | null,
    labelOf: (k: string) => string,
    summary: typeof data.refunds.byMachine,
  ): StatRow[] => {
    const rows = new Map<string, StatRow>();
    for (const i of createdIn) {
      const k = keyOf(i) ?? REFUND_NONE_KEY;
      const prev = rows.get(k) ?? {
        key: k,
        label: labelOf(k),
        count: 0,
        open: 0,
        refundedOre: 0,
        refundCount: 0,
      };
      rows.set(k, {
        ...prev,
        count: prev.count + 1,
        open: prev.open + (i.status !== "resolved" ? 1 : 0),
      });
    }
    for (const r of summary.rows) {
      const prev = rows.get(r.key) ?? {
        key: r.key,
        label: labelOf(r.key),
        count: 0,
        open: 0,
        refundedOre: 0,
        refundCount: 0,
      };
      rows.set(r.key, { ...prev, refundedOre: r.amountOre, refundCount: r.count });
    }
    return [...rows.values()].sort(
      (a, b) =>
        b.count - a.count || b.refundedOre - a.refundedOre || a.label.localeCompare(b.label, "sv"),
    );
  };
  const byMachine = statsBy(
    (i) => i.machineId,
    (k) =>
      k === REFUND_NONE_KEY
        ? "Utan automat"
        : `${machine.get(k)?.code ?? ""} ${machine.get(k)?.name ?? "Okänd automat"}`.trim(),
    data.refunds.byMachine,
  );
  const byTitle = statsBy(
    (i) => i.titleId,
    (k) => (k === REFUND_NONE_KEY ? "Utan titel" : (title.get(k) ?? "Okänd titel")),
    data.refunds.byTitle,
  );

  const rows: IncidentListRow[] = relevant.map((i) => ({
    id: i.id,
    when: formatWhen(i.startedAt, ctx.timeZone, now),
    whenSort: i.startedAt,
    machine: machine.get(i.machineId)?.code ?? "",
    kind: KIND_LABEL[i.kind] ?? i.kind,
    title: i.titleId ? (title.get(i.titleId) ?? "") : "",
    status: i.status,
    statusLabel: STATUS_LABEL[i.status],
    assignee: i.assigneeId ? (member.get(i.assigneeId) ?? "Borttagen användare") : "",
    refundedOre: i.refundedOre,
    summary: i.description ?? "",
  }));

  const total = data.refunds.total;
  const top = byMachine[0];
  const oldestOpen = [...open].sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))[0];

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 px-4 pt-8 pb-16 md:gap-12 md:px-8 md:pt-12">
      <SectionHeader
        className="rise"
        as="h1"
        size="xl"
        eyebrow="Inkorg"
        title={
          open.length === 0
            ? "Inga öppna ärenden."
            : `${plural(open.length, "öppet ärende", "öppna ärenden")}.`
        }
        aside={
          oldestOpen
            ? `Äldsta sedan ${formatWhen(oldestOpen.startedAt, ctx.timeZone, now)}.`
            : undefined
        }
        actions={
          ctx.canEdit ? (
            <Link
              href="/inkorg/nytt"
              className="inline-flex h-9 items-center rounded-sm border border-inverse bg-inverse px-3.5 text-base font-medium text-on-inverse hover:bg-inverse-hover max-md:min-h-11"
            >
              Registrera ärende
            </Link>
          ) : undefined
        }
      />

      <div className="rise" style={{ "--i": 1 } as React.CSSProperties}>
        <InboxKpis
          open={open.length}
          created={createdIn.length}
          resolved={resolvedIn.length}
          refundedOre={total.amountOre}
          refundCount={total.count}
          period={periodLabel}
        />
      </div>

      <section
        aria-labelledby="arenden"
        className="rise flex flex-col gap-6"
        style={{ "--i": 2 } as React.CSSProperties}
      >
        <SectionHeader
          id="arenden"
          size="md"
          title={
            rows.length === 0
              ? "Inga ärenden i perioden."
              : `${plural(rows.length, "ärende", "ärenden")}.`
          }
        />
        {rows.length === 0 ? (
          <StateMessage compact kind="empty" message={`Inga ärenden ${periodLabel}.`} />
        ) : (
          <IncidentTable rows={rows} />
        )}
      </section>

      {byMachine.length > 0 ? (
        <details
          className="rise rounded-md border border-line bg-surface p-4 md:p-5"
          style={{ "--i": 3 } as React.CSSProperties}
        >
          <summary className="flex cursor-pointer list-none flex-wrap items-baseline justify-between gap-3">
            <h2 id="statistik" className="text-md font-medium text-fg">
              {top ? `Flest ärenden i ${top.label}.` : "Per automat och titel."}
            </h2>
            {top ? (
              <span className="meta text-subtle">
                {`${plural(top.count, "ärende", "ärenden")}${top.refundedOre > 0 ? `, ${kronorOfOre(top.refundedOre)}` : ""}`}
              </span>
            ) : null}
          </summary>
          <div className="mt-6 grid grid-cols-1 gap-10 lg:grid-cols-12 lg:gap-8">
            <div className="lg:col-span-6">
              <StatTable caption="Ärenden per automat" rows={byMachine} first="Automat" />
            </div>
            <div className="lg:col-span-6">
              <StatTable caption="Ärenden per titel" rows={byTitle} first="Titel" />
            </div>
          </div>
          {data.truncated ? (
            <p className="mt-4 text-sm text-muted">
              Fler än {formatInt(data.limit)} ärenden. Välj en kortare period.
            </p>
          ) : null}
        </details>
      ) : null}
    </div>
  );
}
