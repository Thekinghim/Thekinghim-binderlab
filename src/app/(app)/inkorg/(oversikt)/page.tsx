import type { Metadata } from "next";

import { businessDateAt } from "@/analytics/todos/time";
import { ButtonLink } from "@/components/v2/button";
import { Card, CardBody } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { V2Page } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
import { REFUND_NONE_KEY } from "@/domain/refunds";
import { formatInt, formatPeriod } from "@/lib/format";
import { isoDateToShellDate, loadPeriod, requireRoute } from "@/server/data/core";

import { FoldCard } from "@/app/(app)/installningar/_components/fold-card";
import "@/app/(app)/installningar/_components/settings.css";

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
    <div className="v2-table-wrap">
      <table className="v2-table min-w-[22rem]">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th scope="col">{first}</th>
            <th scope="col" className="num">
              Ärenden
            </th>
            <th scope="col" className="num">
              Öppna
            </th>
            <th scope="col" className="num">
              Återbetalt
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.key}>
              <td>{r.label}</td>
              <td className="num">{formatInt(r.count)}</td>
              <td className="num text-v2-mute">{formatInt(r.open)}</td>
              <td className="num">{r.refundedOre > 0 ? kronorOfOre(r.refundedOre) : "–"}</td>
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
      <V2Page title="Inkorg" sub={<b>Kundärenden hanteras av ägare och admin.</b>}>
        <Card>
          <Empty
            title="Ärenden innehåller återbetalningar och visas inte för påfyllare."
            action={
              <ButtonLink href="/drift" touch>
                Öppna Drift
              </ButtonLink>
            }
          >
            Ser du ett fel på en automat? Registrera påfyllning eller säg till ägaren.
          </Empty>
        </Card>
      </V2Page>
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
    <V2Page
      title="Inkorg"
      period
      tools={
        ctx.canEdit ? (
          <ButtonLink href="/inkorg/nytt" variant="act" className="max-md:hidden">
            Registrera ärende
          </ButtonLink>
        ) : undefined
      }
      sub={
        <>
          <b>
            {open.length === 0
              ? "Inga öppna ärenden."
              : `${plural(open.length, "öppet ärende", "öppna ärenden")}.`}
          </b>{" "}
          {oldestOpen
            ? `Äldsta sedan ${formatWhen(oldestOpen.startedAt, ctx.timeZone, now)}.`
            : null}
        </>
      }
    >
      <SubNav />
      <div className="v2-stack">
        {ctx.canEdit ? (
          <ButtonLink href="/inkorg/nytt" variant="act" size="lg" className="w-full md:hidden">
            Registrera ärende
          </ButtonLink>
        ) : null}

        <InboxKpis
          open={open.length}
          created={createdIn.length}
          resolved={resolvedIn.length}
          refundedOre={total.amountOre}
          refundCount={total.count}
          period={periodLabel}
        />

        <Card
          title={<span id="arenden">Ärenden</span>}
          actions={
            <span className="lk">
              {rows.length === 0 ? "Inga i perioden" : plural(rows.length, "ärende", "ärenden")}
            </span>
          }
        >
          {rows.length === 0 ? (
            <Empty title={`Inga ärenden ${periodLabel}.`} />
          ) : (
            <CardBody>
              <IncidentTable rows={rows} />
            </CardBody>
          )}
        </Card>

        {byMachine.length > 0 ? (
          <FoldCard
            id="statistik"
            title={top ? `Flest ärenden i ${top.label}` : "Per automat och titel"}
            aside={
              top
                ? `${plural(top.count, "ärende", "ärenden")}${top.refundedOre > 0 ? `, ${kronorOfOre(top.refundedOre)}` : ""}`
                : undefined
            }
          >
            <div className="grid grid-cols-1 gap-y-2 py-2 lg:grid-cols-2">
              <StatTable caption="Ärenden per automat" rows={byMachine} first="Automat" />
              <StatTable caption="Ärenden per titel" rows={byTitle} first="Titel" />
            </div>
            {data.truncated ? (
              <p className="st-p px-[18px] pb-4">
                Fler än {formatInt(data.limit)} ärenden. Välj en kortare period.
              </p>
            ) : null}
          </FoldCard>
        ) : null}
      </div>
    </V2Page>
  );
}
