import Link from "next/link";

import { cn } from "@/lib/cn";
import type { ReactNode } from "react";

import { Card } from "@/components/v2/card";
import { ButtonLink } from "@/components/v2/button";
import { KpiBand, KpiTile } from "@/components/v2/kpi-tile";
import { PackImage } from "@/components/v2/pack-image";
import { RollingNumber } from "@/components/v2/rolling-number";
import { formatInt, NBSP } from "@/lib/format";
import type { KpiBandTile } from "@/server/data/v2/analytics/kpi-band";
import type { LiveOrder } from "@/server/data/v2/analytics/live";

import { ActionsList, CalmLine } from "./actions-card";
import type { HemToday } from "./today-data";

const krRound = (ore: number) => `${formatInt(Math.round(ore / 100))}${NBSP}kr`;

/* ------------------------------------------------------------------ */
/* Dagens rad                                                          */
/* ------------------------------------------------------------------ */

/** "8 behöver påfyllning · 2 offline · 1 startklar · 1 pris går med förlust". */
export function TodayLine({ today }: { today: HemToday }) {
  const c = today.actions.counts;
  const parts: ReactNode[] = [];
  if (c.refill > 0)
    parts.push(
      <Link key="r" href="/automater?f=behover" className="o">
        <b>{formatInt(c.refill)}</b> behöver påfyllning
      </Link>,
    );
  if (c.offline > 0)
    parts.push(
      <Link key="o" href="/automater?f=offline" className="o c">
        <b>{formatInt(c.offline)}</b> offline
      </Link>,
    );
  if (c.startklar > 0)
    parts.push(
      <Link key="s" href="/automater?f=ny" className="o i">
        <b>{formatInt(c.startklar)}</b> startklar
      </Link>,
    );
  if (c.badPricing > 0)
    parts.push(
      <Link key="p" href="/lonsamhet#prisrad" className="o c">
        <b>{formatInt(c.badPricing)}</b> {c.badPricing === 1 ? "pris går" : "priser går"} med
        förlust
      </Link>,
    );
  if (parts.length === 0) {
    return (
      <span className="today">
        Allt rullar: <b>{formatInt(today.actions.calm.running)}</b> automater i drift.
      </span>
    );
  }
  return (
    <span className="today">
      {parts.map((p, i) => (
        <span key={i}>
          {i > 0 ? <span className="text-v2-faint"> · </span> : null}
          {p}
        </span>
      ))}
    </span>
  );
}

/* ------------------------------------------------------------------ */
/* KPI-bandet                                                          */
/* ------------------------------------------------------------------ */

function tileValue(t: KpiBandTile): ReactNode {
  if (t.value === null) return "–";
  if (t.unit === "ore") {
    // Rullande siffror bara för vinsten och lagret (byggplanen 4.1).
    return t.id === "profit" || t.id === "stock-value" ? (
      <RollingNumber value={t.value} unit="kr" />
    ) : (
      krRound(t.value)
    );
  }
  if (t.unit === "bp")
    return `${(Math.round(t.value / 10) / 10).toLocaleString("sv-SE", { minimumFractionDigits: 1 })}${NBSP}%`;
  return formatInt(t.value);
}

export function HemKpiBand({ tiles }: { tiles: readonly KpiBandTile[] }) {
  return (
    <KpiBand cols={8} ariaLabel="Nyckeltal för perioden">
      {tiles.map((t) => (
        <KpiTile
          key={t.id}
          label={t.label}
          value={tileValue(t)}
          deltaBp={t.deltaBp}
          deltaUnit={t.deltaUnit}
          compare={t.compare ?? undefined}
          trend={t.trend}
          href={t.href}
        />
      ))}
    </KpiBand>
  );
}

/* ------------------------------------------------------------------ */
/* Kräver åtgärd                                                       */
/* ------------------------------------------------------------------ */

export function ActionsCard({
  today,
  nowIso,
  canRoute,
  inRoute,
  soon,
}: {
  today: HemToday;
  nowIso: string;
  canRoute: boolean;
  inRoute: readonly string[];
  soon: readonly { id: string; name: string; code: string; days: number }[];
}) {
  const a = today.actions;
  return (
    <Card
      className="act o-act"
      title="Kräver åtgärd"
      count={a.total}
      actions={
        <span className="lk">{today.economy ? "Störst förlust först" : "Mest bråttom först"}</span>
      }
    >
      <ActionsList rows={a.rows} nowIso={nowIso} canRoute={canRoute} inRoute={inRoute} />
      <CalmLine
        running={a.calm.running}
        powerOff={a.calm.powerOff}
        powerWindow={a.calm.powerWindow}
        total={a.calm.running + a.calm.powerOff + a.total - a.counts.badPricing}
      />
      {soon.length > 0 ? (
        <div className="soon2">
          <span className="lab">Kommande</span>
          <span>
            Tom inom 3 dagar:{" "}
            {soon.map((m, i) => (
              <span key={m.id}>
                {i > 0 ? ", " : ""}
                <Link href={`/automater?valj=${encodeURIComponent(m.code)}`}>{m.name}</Link>{" "}
                <small>
                  ({formatInt(m.days)}
                  {NBSP}d)
                </small>
              </span>
            ))}
            .
          </span>
        </div>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Dagens rutt                                                         */
/* ------------------------------------------------------------------ */

export function RouteCard({ today, canRoute }: { today: HemToday; canRoute: boolean }) {
  const r = today.route;
  if (r.stops === 0) {
    return (
      <Card className="rutt o-rutt" title="Dagens rutt" link={{ href: "/rutt", label: "Rutt" }}>
        <div className="rbody">
          <b>Ingen påfyllning behövs i dag.</b>
        </div>
      </Card>
    );
  }
  const shortIds = new Set(r.short.map((s) => s.titleId));
  const head = [
    `${formatInt(r.stops)} stopp`,
    r.savesOre !== undefined && r.savesOre >= 500
      ? `räddar ca ${formatInt(Math.round(r.savesOre / 10_000) * 100)} kr vinst/dag`
      : null,
  ]
    .filter(Boolean)
    .join(" · ");
  const where = [r.cities.join(" → "), r.totalKm !== null ? `${formatInt(r.totalKm)} km` : null]
    .filter(Boolean)
    .join(" · ");
  const allDone = r.done === r.stops;
  return (
    <Card className="rutt o-rutt" title="Dagens rutt" link={{ href: "/rutt", label: "Packlista" }}>
      <div className="rbody">
        <div className="rh">
          <b>{head}</b>
          {where ? <span>{where}</span> : null}
        </div>
        <div className="rtx">
          {formatInt(r.fill)} att fylla
          {r.check > 0 ? ` · ${formatInt(r.check)} att kolla (offline)` : ""} ·{" "}
          <b>
            {formatInt(r.totalPacks)}
            {NBSP}pack
          </b>
        </div>
        {r.load.length > 0 ? (
          <div className="rchips">
            {r.load.slice(0, 5).map((x) => (
              <span key={x.titleId} className={cn("rc2", shortIds.has(x.titleId) && "o")}>
                {formatInt(x.quantity)} {x.titleName}
              </span>
            ))}
            {r.load.length > 5 ? (
              <span className="rc2 more">+{formatInt(r.load.length - 5)} titlar</span>
            ) : null}
          </div>
        ) : null}
        {r.short.length > 0 ? (
          <div className="rwarn">
            {r.short.map((s) => (
              <span key={s.titleId}>
                {s.titleName}: {formatInt(s.shortBy)} för lite hemma
              </span>
            ))}
          </div>
        ) : null}
        {r.done > 0 ? (
          <div className="rprog">
            <span className="track">
              <i
                style={{ transform: `scaleX(${r.done / r.stops})`, background: "var(--v2-profit)" }}
              />
            </span>
            <span>
              {formatInt(r.done)} av {formatInt(r.stops)} klara
            </span>
          </div>
        ) : null}
        <div className="racts">
          <ButtonLink size="lg" href="/rutt">
            Packa
          </ButtonLink>
          {canRoute ? (
            <ButtonLink
              size="lg"
              variant="act"
              href={allDone || !r.nextMachineId ? "/rutt" : `/fyll-pa/${r.nextMachineId}?rutt=1`}
            >
              {allDone ? "Rutten klar" : r.done > 0 ? "Fortsätt rutten" : "Starta rutt"}
            </ButtonLink>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Att göra                                                            */
/* ------------------------------------------------------------------ */

export function TodoCard({ today, limit = 6 }: { today: HemToday; limit?: number }) {
  const t = today.todos;
  return (
    <Card
      className="todo o-todo"
      title="Att göra"
      count={t.total}
      link={{ href: "/att-gora", label: "Alla" }}
    >
      {t.rows.length === 0 ? (
        <div className="it">
          <div className="body">
            <div className="t">Inget mer att göra.</div>
          </div>
        </div>
      ) : (
        t.rows.slice(0, limit).map((x) => (
          <div
            className={cn("it", x.level === "now" && x.key.startsWith("short:") && "hot")}
            key={x.key}
          >
            <div className="body">
              <div className="t">{x.title}</div>
              {x.detail ? <div className="d">{x.detail}</div> : null}
            </div>
            <ButtonLink size="sm" href={x.href}>
              {x.verb}
            </ButtonLink>
          </div>
        ))
      )}
      {t.rows.length > limit ? (
        <Link className="lk amore" href="/att-gora">
          Visa alla {formatInt(t.rows.length)}
        </Link>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------ */
/* Senaste köp                                                         */
/* ------------------------------------------------------------------ */

function agoText(iso: string, nowMs: number): string {
  const min = Math.round((nowMs - Date.parse(iso)) / 60_000);
  if (min < 2) return "nyss";
  if (min < 60) return `${min}${NBSP}min sedan`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h}${NBSP}h sedan` : `${Math.floor(h / 24)}${NBSP}d sedan`;
}

export function LiveCard({ orders, nowIso }: { orders: readonly LiveOrder[]; nowIso: string }) {
  const nowMs = Date.parse(nowIso);
  return (
    <Card
      className="live o-live"
      title="Senaste köp"
      actions={
        <span className="lk flex items-center gap-[7px]">
          <span className="livedot" aria-hidden="true" />
          Från Awish
        </span>
      }
    >
      {orders.length === 0 ? (
        <div className="aempty">
          <b>Inga köp de senaste två dygnen.</b>
          <span>Köpen kommer från Awish ungefär var 5:e minut.</span>
        </div>
      ) : (
        <div>
          {orders.slice(0, 4).map((o) => (
            <div className="sale" key={o.id}>
              <span className="dot g" aria-hidden="true" />
              <PackImage title={o.titleName} size="l" />
              <span className="tx">
                <b>{o.titleName}</b>
                <small>{[o.storeName, o.machineCode].filter(Boolean).join(" · ")}</small>
              </span>
              <span className="pr">
                <b>{krRound(o.amountOre)}</b>
                <small>{o.testPurchase ? "testköp" : agoText(o.orderedAt, nowMs)}</small>
              </span>
            </div>
          ))}
        </div>
      )}
      <div className="ft">Awish skickar köp ungefär var 5:e minut.</div>
    </Card>
  );
}
