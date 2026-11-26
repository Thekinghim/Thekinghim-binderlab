"use client";

import "./lager-v2.css";

import Link from "next/link";
import type { CSSProperties } from "react";
import { useMemo, useState } from "react";

import { businessDateAt } from "@/analytics/todos/time";
import { ButtonLink } from "@/components/v2/button";
import { daysBetween } from "@/domain";
import { Card } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { PackImage } from "@/components/v2/pack-image";
import { RollingNumber } from "@/components/v2/rolling-number";
import { cn } from "@/lib/cn";
import { formatInt, formatKronor, NBSP } from "@/lib/format";

import type { VartLagerRow } from "../../_lib/model";
import {
  homeShare,
  shelfCounts,
  shelfFilter,
  wayBadge,
  wayHeadline,
  type ShelfChip,
  type ShelfView,
} from "../../_lib/shelf";
import {
  gapText,
  isLow,
  isOut,
  sortRows,
  type BuyLine,
  type RecentEvent,
  type StockSort,
} from "../../_lib/v2-model";
import { Shelf } from "./shelf";
import { ViewToggle } from "./view-toggle";
import { VIEW_COOKIE } from "../../_lib/shelf";

export interface LagerViewProps {
  rows: readonly VartLagerRow[];
  home: number;
  inMachines: number;
  /** Pack per eget lager (flera lager: "Hemma 1 200 · Kontoret 447"). */
  places: readonly { id: string; name: string; packs: number; lastCounted: string | null }[];
  onTheWay: readonly {
    titleId: string;
    name: string;
    qty: number;
    expectedOn: string;
    late: boolean;
  }[];
  /** Ekonomi (ägare, admin, läsare): Köpa och Lagervärde. */
  buy: readonly BuyLine[] | null;
  value: { homeOre: number; machinesOre: number; unpriced: number } | null;
  events: readonly RecentEvent[];
  /** Dagens rutt mot lagret. */
  route: {
    stops: number;
    packs: number;
    short: readonly { titleName: string; need: number; home: number }[];
  } | null;
  canEdit: boolean;
  /** Packa-länk per titel (Mystery packs). */
  packHref: Readonly<Record<string, string>>;
  timeZone: string;
  now: string;
  /** Dagens affärsdatum (märkena på det som är på väg). */
  today: string;
  /** Leveranstid per titel (strecket på hyllans Räcker). */
  leadDays: Readonly<Record<string, number>>;
  /** Hylla eller Tabell (kakan, se view-toggle.tsx). */
  initialView: ShelfView;
}

const kr = (ore: number) => formatKronor(Math.round(ore / 100), { decimals: 0 });

function dayText(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", timeZone })
    .format(new Date(iso))
    .replace(".", "");
}

/** Kalenderdagar i organisationens tidszon, som inventeringssidan ("20 nov. · 6 dagar sedan"). */
function agoText(iso: string, now: string, timeZone: string): string {
  const days = daysBetween(businessDateAt(iso, timeZone), businessDateAt(now, timeZone));
  if (days <= 0) return "Räknat i dag";
  if (days === 1) return "Räknat i går";
  return `Räknat för ${formatInt(days)} dagar sedan`;
}

const CHIPS: { key: ShelfChip; label: string }[] = [
  { key: "alla", label: "Alla" },
  { key: "kop", label: "Köp in" },
  { key: "vag", label: "På väg" },
  { key: "utgar", label: "Utgår" },
];

export function LagerView(p: LagerViewProps) {
  const [view, setView] = useState<ShelfView>(p.initialView);
  const [chip, setChip] = useState<ShelfChip>("alla");
  const [sort, setSort] = useState<StockSort>("rakcer");
  const wayIds = useMemo(() => new Set(p.onTheWay.map((w) => w.titleId)), [p.onTheWay]);
  const wayBy = useMemo(() => {
    const m = new Map<string, { qty: number; expectedOn: string; late: boolean }>();
    for (const w of p.onTheWay) {
      const g = m.get(w.titleId);
      m.set(
        w.titleId,
        g
          ? {
              qty: g.qty + w.qty,
              expectedOn: g.expectedOn < w.expectedOn ? g.expectedOn : w.expectedOn,
              late: g.late || w.late,
            }
          : { qty: w.qty, expectedOn: w.expectedOn, late: w.late },
      );
    }
    return m;
  }, [p.onTheWay]);
  const counts = shelfCounts(p.rows, wayIds);
  const chipRows = useMemo(() => shelfFilter(p.rows, chip, wayIds), [p.rows, chip, wayIds]);
  // Tabellen: Alla = alla titlar (utgångna längst ner, som förut).
  const tableRows = useMemo(
    () => sortRows(chip === "alla" ? p.rows : chipRows, sort),
    [p.rows, chip, chipRows, sort],
  );
  const retired = chip === "alla" ? p.rows.filter((r) => r.retired) : [];
  const share = homeShare(p.home, p.inMachines) ?? 0;
  const maxTotal = Math.max(1, ...p.rows.map((r) => Math.max(0, r.home) + r.inMachines));
  const way = p.onTheWay.reduce((s, w) => s + w.qty, 0);
  const firstWay = [...p.onTheWay].sort((a, b) => (a.expectedOn < b.expectedOn ? -1 : 1))[0];
  const shelf = view === "hylla";

  return (
    <div className="v2-lager">
      <div className="work">
        <div className="col">
          {p.route && p.route.stops > 0 && p.route.packs > 0 ? (
            <div className={cn("rtl", p.route.short.length > 0 && "o")}>
              <div className="min-w-0 flex-1">
                <b>
                  Dagens rutt: {formatInt(p.route.packs)}
                  {NBSP}pack, {formatInt(p.route.stops)}
                  {NBSP}stopp
                </b>
                {p.route.short.length > 0 ? (
                  <>
                    <small>Saknas hemma</small>
                    {/* En rad per titel, högst tre; talen bryts aldrig från sin etikett. */}
                    <ul className="rsh">
                      {p.route.short.slice(0, 3).map((s) => (
                        <li key={s.titleName}>
                          <span className="nm">{s.titleName}</span>
                          <span className="n">
                            saknas {formatInt(Math.max(0, s.need - Math.max(0, s.home)))}
                          </span>
                        </li>
                      ))}
                      {p.route.short.length > 3 ? (
                        <li className="more">+{formatInt(p.route.short.length - 3)} till</li>
                      ) : null}
                    </ul>
                  </>
                ) : (
                  <small>Allt finns hemma</small>
                )}
              </div>
              <ButtonLink href="/rutt" variant="act" size="sm">
                Packa →
              </ButtonLink>
            </div>
          ) : null}

          <section className="v2-card head2">
            <div className="l">
              {/* Flera lagerplatser: siffran är alla tillsammans, inte bara Hemma. */}
              <span className="v2-lab">{p.places.length > 1 ? "Vårt lager" : "Hemma"}</span>
              <div className="big">
                <RollingNumber value={p.home} unit="int" ariaLabel={`${formatInt(p.home)} pack`} />
                <span className="unit">{NBSP}pack</span>
              </div>
              <span className="sub">
                plus <b>{formatInt(p.inMachines)}</b> i automaterna
              </span>
              <div className="split" aria-hidden="true">
                <i className="h" style={{ flexGrow: share }} />
                <i className="a" style={{ flexGrow: 1 - share }} />
              </div>
              <div className="leg">
                <span>
                  <i className="dh" />
                  {p.places.length > 1
                    ? p.places.map((x) => `${x.name} ${formatInt(x.packs)}`).join(" · ")
                    : `Hemma ${formatInt(p.home)}`}
                </span>
                <span className="m">
                  <i className="da" />I automaterna {formatInt(p.inMachines)}
                </span>
              </div>
            </div>
            <div className="r way">
              <div className="whd">
                <span className="v2-lab">
                  På väg{way > 0 ? ` · ${formatInt(way)}${NBSP}pack` : ""}
                </span>
                {way > 0 && firstWay ? (
                  <span className={cn("wlate", !firstWay.late && "ok")}>
                    {wayHeadline(firstWay.expectedOn, p.today, firstWay.late)}
                  </span>
                ) : null}
              </div>
              {way > 0 && firstWay ? (
                <>
                  <ul className="wps" aria-label="Packen som är på väg">
                    {p.onTheWay.slice(0, 6).map((w, i) => (
                      <li
                        key={`${w.titleId}:${w.expectedOn}`}
                        className="wp"
                        style={{ "--i": i } as CSSProperties}
                      >
                        <span className="im">
                          <PackImage title={w.name} size="md" />
                          <span className="q" aria-hidden="true">
                            +{formatInt(w.qty)}
                          </span>
                        </span>
                        <span
                          className={cn("d", !(w.late || w.expectedOn < p.today) && "ok")}
                          aria-hidden="true"
                        >
                          {wayBadge(w.expectedOn, p.today, w.late)}
                        </span>
                        <span className="sr-only">
                          {w.name}: {formatInt(w.qty)} pack,{" "}
                          {wayBadge(w.expectedOn, p.today, w.late)}
                        </span>
                      </li>
                    ))}
                  </ul>
                  {p.canEdit ? (
                    <div className="go">
                      <small>Tryck när de kommit, så räknas de upp hemma.</small>
                      <ButtonLink href="/prognos" variant="act" className="kf-d">
                        Kom fram
                      </ButtonLink>
                      <ButtonLink href="/prognos" variant="act" size="lg" className="kf-m">
                        Kom fram – lägg in {formatInt(way)} hemma
                      </ButtonLink>
                    </div>
                  ) : null}
                </>
              ) : (
                <p className="none">
                  <b>Inget på väg</b>
                  Beställningar syns här tills de kommit fram.
                </p>
              )}
            </div>
          </section>

          <section className="v2-card o-titles">
            <div className="v2-card-hd vl-hd">
              <h2>
                Per titel{" "}
                <span className="cnt-s">
                  · {formatInt(counts.alla)}
                  {shelf ? " i hyllan" : ""}
                </span>
              </h2>
              <div className="vl-tools">
                {shelf ? <span className="srt">Sorterat på räcker</span> : null}
                <ViewToggle value={view} onChange={setView} cookie={VIEW_COOKIE.lager} />
              </div>
            </div>
            <div className="chips" role="group" aria-label="Visa titlar">
              {CHIPS.filter((c) => c.key === "alla" || counts[c.key] > 0).map((c) => (
                <button
                  key={c.key}
                  type="button"
                  aria-pressed={chip === c.key}
                  className={cn("chip", c.key === "kop" && "o")}
                  onClick={() => setChip(c.key)}
                >
                  {c.label} {formatInt(counts[c.key])}
                </button>
              ))}
            </div>
            {(shelf ? chipRows : tableRows).length === 0 ? (
              <Empty title={chip === "kop" ? "Inget behöver köpas in" : "Inga titlar här"}>
                {chip === "kop" ? "Alla titlar räcker till nästa beställning." : null}
              </Empty>
            ) : shelf ? (
              <Shelf
                rows={chipRows}
                retired={retired}
                way={wayBy}
                leadDays={p.leadDays}
                showBuy={p.buy !== null}
                packHref={p.packHref}
                today={p.today}
              />
            ) : (
              <>
                <div className="lgd">
                  <span>
                    <i className="dh" />
                    Hemma
                  </span>
                  <span>
                    <i className="da" />I automaterna
                  </span>
                </div>
                <StockTable
                  rows={tableRows}
                  sort={sort}
                  setSort={setSort}
                  maxTotal={maxTotal}
                  home={p.home}
                  inMachines={p.inMachines}
                  showBuy={p.buy !== null}
                  packHref={p.packHref}
                />
              </>
            )}
            {shelf ? (
              <p className="foot sf">
                <span>
                  <span className="tick" aria-hidden="true" />
                  Strecket = leveranstiden
                </span>
                <span>Räcker = hemma ÷ vad automaterna säljer per dag</span>
              </p>
            ) : (
              <p className="foot">
                Hemma räcker = det som finns hemma delat med vad alla automater drar per dag. Totalt
                = hemma och i automaterna tillsammans.
              </p>
            )}
          </section>
        </div>

        <div className="col">
          {/* Köpa: hyllan visar Köp in på rutorna; listan finns kvar i tabellvyn. */}
          {p.buy !== null && !shelf ? (
            <BuyCard buy={p.buy} canEdit={p.canEdit} packHref={p.packHref} />
          ) : null}

          {p.value !== null ? <ValueCard value={p.value} /> : null}

          <Card title="Senaste händelser">
            {p.events.length === 0 ? (
              <p className="empty">Inga händelser de senaste 60 dagarna.</p>
            ) : (
              <ul className="ev">
                {p.events.map((e) => (
                  <li key={e.key}>
                    <span className="evp" aria-hidden="true">
                      {e.packTitle ? <PackImage title={e.packTitle} size="xs" /> : null}
                    </span>
                    <div>
                      <b>{e.title}</b>
                      <small>{e.detail}</small>
                    </div>
                    <time dateTime={e.occurredAt}>{dayText(e.occurredAt, p.timeZone)}</time>
                  </li>
                ))}
              </ul>
            )}
          </Card>

          <Card title="Räkna lagret">
            {p.places.map((x) => (
              <div className="cnt" key={x.id}>
                <div>
                  <b>{x.name}</b>
                  <small>
                    {x.lastCounted ? agoText(x.lastCounted, p.now, p.timeZone) : "Inte räknat än"}
                  </small>
                </div>
                {p.canEdit ? (
                  <ButtonLink size="sm" href="/vart-lager/inventering">
                    Räkna {x.name}
                  </ButtonLink>
                ) : null}
              </div>
            ))}
          </Card>
        </div>
      </div>
    </div>
  );
}

const SORTS: { key: StockSort; label: string }[] = [
  { key: "hemma", label: "Hemma" },
  { key: "ute", label: "Ute" },
  { key: "rakcer", label: "Hemma räcker" },
  { key: "totalt", label: "Totalt" },
];

function StockTable({
  rows,
  sort,
  setSort,
  maxTotal,
  home: sumHome,
  inMachines: sumOut,
  showBuy,
  packHref,
}: {
  rows: readonly VartLagerRow[];
  sort: StockSort;
  setSort: (s: StockSort) => void;
  maxTotal: number;
  home: number;
  inMachines: number;
  showBuy: boolean;
  packHref: Readonly<Record<string, string>>;
}) {
  return (
    <div className="tbl" role="table" aria-label="Lagret per titel">
      <div className="tr th" role="row">
        <span role="columnheader">Titel</span>
        <span role="columnheader" className="dist">
          Fördelning
        </span>
        {SORTS.map((s) => (
          <button
            key={s.key}
            type="button"
            role="columnheader"
            aria-sort={sort === s.key ? "ascending" : "none"}
            className={cn("num", sort === s.key && "on")}
            onClick={() => setSort(s.key)}
          >
            {s.label}
            {sort === s.key ? <span aria-hidden="true"> ⌃</span> : null}
          </button>
        ))}
        <span role="columnheader" className="act" />
      </div>
      {rows.map((r) => {
        const home = Math.max(0, r.home);
        const tone = isOut(r) ? "crit" : isLow(r) ? "warn" : "";
        return (
          <div className={cn("tr", r.retired && "idle")} role="row" key={r.titleId}>
            <span className="ti" role="cell">
              <span className="pkb">
                <PackImage title={r.name} size="s" />
              </span>
              <span className="nm">
                <b>{r.name}</b>
                <small className="mob">
                  {formatInt(home)} hemma · {formatInt(r.inMachines)} ute · totalt{" "}
                  {r.lastsDays === null ? "–" : `${formatInt(r.lastsDays)} d`}
                </small>
                {r.retired ? <small>Utgår: ligger still hemma</small> : null}
              </span>
            </span>
            <span className="dist" role="cell" aria-hidden="true">
              {home + r.inMachines > 0 ? (
                <span className="bar">
                  <i className="h" style={{ width: `${(home / maxTotal) * 100}%` }} />
                  <i className="a" style={{ width: `${(r.inMachines / maxTotal) * 100}%` }} />
                </span>
              ) : (
                <span className="dash" />
              )}
            </span>
            <span className="num" role="cell">
              {formatInt(home)}
            </span>
            <span className="num" role="cell">
              {formatInt(r.inMachines)}
            </span>
            <span className={cn("num days", tone)} role="cell">
              {r.daysLeft === null ? "–" : `${formatInt(r.daysLeft)}${NBSP}d`}
            </span>
            <span className="num" role="cell">
              {r.lastsDays === null ? "–" : `${formatInt(r.lastsDays)}${NBSP}d`}
            </span>
            <span className="act" role="cell">
              {r.action && showBuy ? (
                <ButtonLink
                  size="sm"
                  href={
                    r.action.kind === "pack"
                      ? (packHref[r.titleId] ?? "/vart-lager/mystery")
                      : "/prognos"
                  }
                >
                  {r.action.kind === "pack"
                    ? "Packa"
                    : `Beställ${r.action.qty !== null ? ` ${formatInt(r.action.qty)}` : ""}`}
                </ButtonLink>
              ) : null}
            </span>
          </div>
        );
      })}
      <div className="tr sum" role="row">
        <span className="ti" role="cell">
          <span className="pkb" />
          <b>Summa</b>
        </span>
        <span className="dist" role="cell" />
        <span className="num" role="cell">
          {formatInt(sumHome)}
        </span>
        <span className="num" role="cell">
          {formatInt(sumOut)}
        </span>
        <span className="num" role="cell">
          –
        </span>
        <span className="num" role="cell">
          –
        </span>
        <span className="act" role="cell" />
      </div>
    </div>
  );
}

function BuyCard({
  buy,
  canEdit,
  packHref,
}: {
  buy: readonly BuyLine[];
  canEdit: boolean;
  packHref: Readonly<Record<string, string>>;
}) {
  return (
    <Card
      className="o-buy"
      title="Köpa"
      count={buy.length}
      actions={<span className="hd-note">Till nästa beställning + leveranstid</span>}
    >
      {buy.length === 0 ? (
        <p className="empty">Inget behöver köpas eller packas nu.</p>
      ) : (
        buy.map((b) => (
          <div className="buy" key={b.titleId}>
            <PackImage title={b.name} size="m" />
            <div className="bt">
              <b>{b.text}</b>
              <span className="bm">
                Räcker <b>{b.daysLeft === null ? "–" : `${formatInt(b.daysLeft)} d`}</b>
                {b.leadTimeDays !== null ? (
                  <>
                    {" "}
                    Leverans <b>{formatInt(b.leadTimeDays)} d</b>
                  </>
                ) : null}
                {b.gapDays !== null && b.gapDays < 0 ? (
                  <span className="neg"> {gapText(b.gapDays)}</span>
                ) : null}
              </span>
              <small>
                {b.kind === "pack" ? "Packas hemma" : (b.supplierName ?? "Ingen leverantör vald")}
              </small>
            </div>
            {canEdit ? (
              <ButtonLink
                size="sm"
                href={
                  b.kind === "pack" ? (packHref[b.titleId] ?? "/vart-lager/mystery") : "/prognos"
                }
              >
                {b.kind === "pack" ? "Packa" : "Beställ"}
              </ButtonLink>
            ) : null}
          </div>
        ))
      )}
    </Card>
  );
}

function ValueCard({
  value,
}: {
  value: { homeOre: number; machinesOre: number; unpriced: number };
}) {
  const total = value.homeOre + value.machinesOre;
  const home = total > 0 ? value.homeOre / total : 0;
  return (
    <Card title="Lagervärde" actions={<span className="hd-note">i inköpspris</span>}>
      <div className="val">
        <div className="vbig">{kr(total)}</div>
        <div className="split" aria-hidden="true">
          <i className="h" style={{ flexGrow: home }} />
          <i className="a" style={{ flexGrow: 1 - home }} />
        </div>
        <div className="vr">
          <span>Hemma</span>
          <b>{kr(value.homeOre)}</b>
        </div>
        <div className="vr">
          <span>I automaterna</span>
          <b>{kr(value.machinesOre)}</b>
        </div>
        {value.unpriced > 0 ? (
          <Link className="vr unp" href="/inkopspriser?saknar=pris">
            <span>
              {value.unpriced === 1
                ? "1 titel saknar pris"
                : `${formatInt(value.unpriced)} titlar saknar pris`}
            </span>
            <span>
              Inköpspriser <span aria-hidden="true">→</span>
            </span>
          </Link>
        ) : null}
      </div>
    </Card>
  );
}
