import type { Metadata } from "next";
import Link from "next/link";
import type { CSSProperties } from "react";

import { Icon } from "@/components/ui/icon";
import { SectionHeader } from "@/components/ui/section-header";
import { formatDate, formatInt, NBSP } from "@/lib/format";
import { requireRoute } from "@/server/data/core";
import { requireUser } from "@/server/session";

import { plural } from "../_lib/display";
import { loadRefillLogFor } from "../_lib/refill-log";
import { refillLogView, type RefillLogDay } from "../_lib/refill-log-view";
import { QueueStatus } from "./queue-status";

export const metadata: Metadata = { title: "Påfyllning" };

const rise = (i: number) => ({ "--i": i }) as CSSProperties;

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
    <div className="flex flex-col gap-10 max-md:gap-7">
      <div className="rise flex flex-col gap-6" style={rise(0)}>
        <SectionHeader
          as="h1"
          size="xl"
          eyebrow="Påfyllning"
          title={log.headline}
          aside={
            latest
              ? `Senast ${latest.time} · ${plural(log.today.entries.length, "påfyllning", "påfyllningar")}.`
              : canRefill
                ? "Registrera med Fyll på vid automaten."
                : undefined
          }
        />
        {canRefill ? (
          <Link
            href="/fyll-pa"
            className="group inline-flex h-14 w-full items-center justify-center gap-2 rounded-md border border-inverse bg-inverse px-8 text-lg font-medium text-on-inverse transition-[background-color,transform] duration-fast hover:bg-inverse-hover active:scale-[0.98] sm:w-fit"
          >
            <Icon name="plus" />
            Fyll på
            <span
              aria-hidden
              className="transition-transform duration-200 group-hover:translate-x-0.5 motion-reduce:transition-none"
            >
              →
            </span>
          </Link>
        ) : null}
        {canRefill ? <QueueStatus scope={`${ctx.organization.id}:${ctx.user.id}`} /> : null}
      </div>

      <section aria-labelledby="i-dag" className="rise flex flex-col gap-4" style={rise(1)}>
        <h2 id="i-dag" className="label text-muted">
          {`I dag · ${formatInt(log.today.packs)}${NBSP}pack`}
        </h2>
        {log.today.entries.length === 0 ? (
          <p className="text-base text-muted">
            {ctx.role === "refiller"
              ? "Du har inte fyllt på något i dag."
              : "Ingen har fyllt på i dag."}
          </p>
        ) : (
          <LogList day={log.today} />
        )}
      </section>

      {log.earlier.length > 0 ? (
        <details className="group rise" style={rise(2)}>
          <summary className="label w-fit cursor-pointer list-none text-muted transition-colors duration-fast hover:text-fg">
            <span
              aria-hidden
              className="mr-1 inline-block transition-transform duration-fast group-open:rotate-90"
            >
              ›
            </span>
            {`Veckan före · ${formatInt(log.earlier.reduce((n, d) => n + d.packs, 0))}${NBSP}pack`}
          </summary>
          <div className="mt-6 flex flex-col gap-8">
            {log.earlier.map((d) => (
              <section key={d.date} className="flex flex-col gap-3">
                <h3 className="label text-subtle">
                  {`${formatDate(new Date(`${d.date}T12:00:00`), { now })} · ${formatInt(d.packs)}${NBSP}pack`}
                </h3>
                <LogList day={d} />
              </section>
            ))}
          </div>
        </details>
      ) : null}
    </div>
  );
}

function LogList({ day }: { day: RefillLogDay }) {
  return (
    <ul className="flex flex-col divide-y divide-line border-y border-line">
      {day.entries.map((e) => (
        <li key={e.clientId} className="flex items-baseline gap-3 py-3">
          <span className="meta tnum w-11 shrink-0 text-subtle">{e.time}</span>
          <span className="min-w-0 flex-1">
            <span className="block truncate text-sm text-fg">{e.titleName}</span>
            <span className="meta block truncate text-subtle">
              {e.machineCode.replace(/-/g, "‑")}
              {/* Mobil: bara koden, så att namnet på den som fyllde på får plats. */}
              <span className="max-md:hidden">{` ${e.machineName}`}</span>
              {e.by ? ` · ${e.by}` : ""}
            </span>
          </span>
          <span className="tnum shrink-0 text-base font-medium text-fg">
            {`+${formatInt(e.quantity)}`}
          </span>
        </li>
      ))}
    </ul>
  );
}
