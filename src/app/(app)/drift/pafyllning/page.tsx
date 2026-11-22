import type { Metadata } from "next";

import { Icon } from "@/components/ui/icon";
import { ButtonLink } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { formatDate, formatInt, NBSP } from "@/lib/format";
import { requireRoute } from "@/server/data/core";
import { requireUser } from "@/server/session";

import { DriftFrame } from "../_components/drift-frame";
import { plural } from "../_lib/display";
import { loadRefillLogFor } from "../_lib/refill-log";
import { refillLogView, type RefillLogDay } from "../_lib/refill-log-view";
import { QueueStatus } from "./queue-status";

export const metadata: Metadata = { title: "Påfyllning" };

/**
 * Drift → Påfyllning: dagens påfyllningar (loggen) och en stor knapp till Fyll på (/fyll-pa),
 * det enda sättet att registrera en påfyllning. Ägare, admin och läsare ser allas;
 * påfyllaren sina egna. Påfyllningar som väntar på nät i telefonen syns och skickas här.
 */
export default async function RefillPage() {
  const [ctx, user] = await Promise.all([requireRoute("drift"), requireUser()]);
  const canRefill = ctx.role !== "viewer";
  const rows = await loadRefillLogFor(user, {
    organizationId: ctx.organization.id,
    today: ctx.today,
  });
  const log = refillLogView(rows, ctx.today, ctx.timeZone);
  const now = new Date(ctx.now);
  const latest = log.today.entries[0];

  return (
    <DriftFrame
      ctx={ctx}
      sub={
        <>
          <b>{log.headline}</b>
          {latest ? (
            <span>{`Senast ${latest.time} · ${plural(log.today.entries.length, "påfyllning", "påfyllningar")}.`}</span>
          ) : canRefill ? (
            <span>Registrera med Fyll på vid automaten.</span>
          ) : null}
        </>
      }
    >
      {canRefill ? (
        <ButtonLink href="/fyll-pa" variant="act" size="lg" className="w-full sm:w-fit sm:px-8">
          <Icon name="plus" />
          Fyll på
          <span aria-hidden="true">→</span>
        </ButtonLink>
      ) : null}
      {canRefill ? <QueueStatus scope={`${ctx.organization.id}:${ctx.user.id}`} /> : null}

      <Card
        title="I dag"
        actions={
          <span className="tnum text-v2-xs text-v2-mute">{`${formatInt(log.today.packs)}${NBSP}pack`}</span>
        }
      >
        {log.today.entries.length === 0 ? (
          <Empty
            title={
              ctx.role === "refiller"
                ? "Du har inte fyllt på något i dag."
                : "Ingen har fyllt på i dag."
            }
          />
        ) : (
          <LogList day={log.today} />
        )}
      </Card>

      {log.earlier.length > 0 ? (
        <Card
          title="Veckan före"
          actions={
            <span className="tnum text-v2-xs text-v2-mute">
              {`${formatInt(log.earlier.reduce((n, d) => n + d.packs, 0))}${NBSP}pack`}
            </span>
          }
        >
          <details className="ops-more group">
            <summary className="w-full px-[18px] py-2 max-[900px]:px-4">
              <span className="group-open:hidden">Visa påfyllningarna</span>
              <span className="hidden group-open:inline">Dölj</span>
            </summary>
            <div className="border-t border-v2-line2">
              {log.earlier.map((d) => (
                <section key={d.date}>
                  <h3 className="ops-group">
                    {`${formatDate(new Date(`${d.date}T12:00:00`), { now })} · ${formatInt(d.packs)}${NBSP}pack`}
                  </h3>
                  <LogList day={d} />
                </section>
              ))}
            </div>
          </details>
        </Card>
      ) : null}
    </DriftFrame>
  );
}

function LogList({ day }: { day: RefillLogDay }) {
  return (
    <ul className="ops-list">
      {day.entries.map((e) => (
        <li key={e.clientId} className="flex items-baseline gap-3">
          <span className="tnum w-11 shrink-0 text-v2-xs text-v2-mute">{e.time}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-v2-sm text-v2-ink">{e.titleName}</span>
            <span className="block truncate text-v2-xs text-v2-mute">
              {e.machineCode.replace(/-/g, "‑")}
              {/* Telefon: bara koden, så att namnet på den som fyllde på får plats. */}
              <span className="max-[900px]:hidden">{` ${e.machineName}`}</span>
              {e.by ? ` · ${e.by}` : ""}
            </span>
          </span>
          <span className="tnum shrink-0 text-v2-md font-[550] text-v2-ink">
            {`+${formatInt(e.quantity)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}
