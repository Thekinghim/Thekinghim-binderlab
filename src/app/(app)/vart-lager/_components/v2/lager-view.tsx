"use client";

import "./lager-v2.css";

import { useMemo, useState } from "react";

import { ButtonLink } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { PackImage } from "@/components/v2/pack-image";
import { RollingNumber } from "@/components/v2/rolling-number";
import { Segmented } from "@/components/v2/segmented";
import { cn } from "@/lib/cn";
import { formatInt, formatKronor, NBSP } from "@/lib/format";

import type { VartLagerRow } from "../../_lib/model";
import {
  filterRows,
  gapText,
  isLow,
  isOut,
  sortRows,
  type BuyLine,
  type RecentEvent,
  type StockFilter,
  type StockSort,
} from "../../_lib/v2-model";

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
}

const kr = (ore: number) => formatKronor(Math.round(ore / 100), { decimals: 0 });

function dayText(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", timeZone })
    .format(new Date(iso))
    .replace(".", "");
}

function agoText(iso: string, now: string): string {
  const days = Math.floor((Date.parse(now) - Date.parse(iso)) / 86_400_000);
  if (days <= 0) return "Räknat i dag";
  if (days === 1) return "Räknat i går";
  return `Räknat för ${formatInt(days)} dagar sedan`;
}

function weekdayOf(date: string): string {
  return new Intl.DateTimeFormat("sv-SE", { weekday: "long", timeZone: "UTC" }).format(
    new Date(`${date}T12:00:00Z`),
  );
}

const SORTS: { key: StockSort; label: string }[] = [
  { key: "hemma", label: "Hemma" },
  { key: "ute", label: "Ute" },
  { key: "rakcer", label: "Hemma räcker" },
  { key: "totalt", label: "Totalt" },
];

export function LagerView(p: LagerViewProps) {
  const [filter, setFilter] = useState<StockFilter>("alla");
  const [sort, setSort] = useState<StockSort>("rakcer");
  const low = p.rows.filter(isLow).length;
  const out = p.rows.filter(isOut).length;
  const shown = useMemo(() => sortRows(filterRows(p.rows, filter), sort), [p.rows, filter, sort]);
  const total = p.home + p.inMachines;
  const homeShare = total > 0 ? p.home / total : 0;
  const maxTotal = Math.max(1, ...p.rows.map((r) => Math.max(0, r.home) + r.inMachines));
  const way = p.onTheWay.reduce((s, w) => s + w.qty, 0);
  const firstWay = [...p.onTheWay].sort((a, b) => (a.expectedOn < b.expectedOn ? -1 : 1))[0];

  return (
    <div className="v2-lager">
      <div className="work">
        <div className="col">
          {p.route && p.route.stops > 0 && p.route.packs > 0 ? (
            <div className={cn("rtl", p.route.short.length > 0 && "o")}>
              <div>
                <b>Dagens rutt behöver {formatInt(p.route.packs)} pack</b>
                <small>
                  {formatInt(p.route.stops)} stopp
                  {p.route.short.length > 0
                    ? ` · ${p.route.short
                        .map(
                          (s) =>
                            `${s.titleName}: behövs ${formatInt(s.need)}, hemma ${formatInt(s.home)}`,
                        )
                        .join(" · ")}`
                    : " · allt finns hemma"}
                </small>
              </div>
              <ButtonLink href="/rutt" variant="act" size="sm">
                Packa →
              </ButtonLink>
            </div>
          ) : null}

          <section className="v2-card head2">
            <div className="l">
              <span className="v2-lab">Hemma · pack</span>
              <div className="big">
                <RollingNumber value={p.home} unit="pack" />
              </div>
              <span className="sub">
                Plus <b>{formatInt(p.inMachines)}</b> i automaterna
              </span>
              <div className="split" aria-hidden="true">
                <i className="h" style={{ transform: `scaleX(${homeShare})` }} />
                <i className="a" style={{ transform: `scaleX(${1 - homeShare})` }} />
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
              <b className="hd">På väg</b>
              {way > 0 && firstWay ? (
                <>
                  <div className="n">
                    {formatInt(way)}
                    {NBSP}pack{" "}
                    <span>
                      · {firstWay.late ? "skulle ha kommit" : "väntas"}{" "}
                      {weekdayOf(firstWay.expectedOn)}
                    </span>
                  </div>
                  <ul>
                    {p.onTheWay.slice(0, 4).map((w) => (
                      <li key={w.titleId}>
                        <span>{w.name}</span>
                        <span>
                          {formatInt(w.qty)}
                          {NBSP}pack
                        </span>
                      </li>
                    ))}
                  </ul>
                  {p.canEdit ? (
                    <div className="go">
                      <small>Tryck när packen kommit, så läggs de in hemma.</small>
                      <ButtonLink href="/prognos">Kom fram</ButtonLink>
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

          <Card
            className="o-titles"
            title="Per titel"
            count={p.rows.length}
            actions={
              <Segmented<StockFilter>
                ariaLabel="Visa titlar"
                value={filter}
                onChange={setFilter}
                options={[
                  { value: "alla", label: `Alla ${p.rows.length}` },
                  { value: "lagt", label: `Lågt ${low}` },
                  { value: "slut", label: `Slut ${out}` },
                ]}
              />
            }
          >
            <div className="lgd">
              <span>
                <i className="dh" />
                Hemma
              </span>
              <span>
                <i className="da" />I automaterna
              </span>
            </div>
            {shown.length === 0 ? (
              <Empty title={filter === "slut" ? "Inget är slut" : "Inget är lågt"}>
                Alla titlar räcker längre än en vecka.
              </Empty>
            ) : (
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
                {shown.map((r) => {
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
                            <i
                              className="a"
                              style={{ width: `${(r.inMachines / maxTotal) * 100}%` }}
                            />
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
                        {r.action && p.buy !== null ? (
                          <ButtonLink
                            size="sm"
                            href={
                              r.action.kind === "pack"
                                ? (p.packHref[r.titleId] ?? "/vart-lager/mystery")
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
                    {formatInt(p.home)}
                  </span>
                  <span className="num" role="cell">
                    {formatInt(p.inMachines)}
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
            )}
            <p className="foot">
              Hemma räcker = det som finns hemma delat med vad alla automater drar per dag. Totalt =
              hemma och i automaterna tillsammans.
            </p>
          </Card>
        </div>

        <div className="col">
          {p.buy !== null ? (
            <Card
              className="o-buy"
              title="Köpa"
              count={p.buy.length}
              actions={<span className="hd-note">Till nästa beställning + leveranstid</span>}
            >
              {p.buy.length === 0 ? (
                <p className="empty">Inget behöver köpas eller packas nu.</p>
              ) : (
                p.buy.map((b) => (
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
                        {b.kind === "pack"
                          ? "Packas hemma"
                          : (b.supplierName ?? "Ingen leverantör vald")}
                      </small>
                    </div>
                    {p.canEdit ? (
                      <ButtonLink
                        size="sm"
                        href={
                          b.kind === "pack"
                            ? (p.packHref[b.titleId] ?? "/vart-lager/mystery")
                            : "/prognos"
                        }
                      >
                        {b.kind === "pack" ? "Packa" : "Beställ"}
                      </ButtonLink>
                    ) : null}
                  </div>
                ))
              )}
            </Card>
          ) : null}

          <Card title="Räkna lagret">
            {p.places.map((x) => (
              <div className="cnt" key={x.id}>
                <div>
                  <b>{x.name}</b>
                  <small>{x.lastCounted ? agoText(x.lastCounted, p.now) : "Inte räknat än"}</small>
                </div>
                {p.canEdit ? (
                  <ButtonLink size="sm" href="/vart-lager/inventering">
                    Räkna {x.name}
                  </ButtonLink>
                ) : null}
              </div>
            ))}
          </Card>

          {p.value !== null ? (
            <Card title="Lagervärde" actions={<span className="hd-note">I inköpspris</span>}>
              <div className="val">
                <p>
                  Lagret är värt <b>{kr(p.value.homeOre + p.value.machinesOre)}</b> i inköp.
                </p>
                <div className="split" aria-hidden="true">
                  <i
                    className="h"
                    style={{
                      transform: `scaleX(${
                        p.value.homeOre + p.value.machinesOre > 0
                          ? p.value.homeOre / (p.value.homeOre + p.value.machinesOre)
                          : 0
                      })`,
                    }}
                  />
                </div>
                <div className="vr">
                  <span>
                    <i className="dh" />
                    Hemma
                  </span>
                  <b>{kr(p.value.homeOre)}</b>
                </div>
                <div className="vr">
                  <span>
                    <i className="da" />I automaterna
                  </span>
                  <b>{kr(p.value.machinesOre)}</b>
                </div>
                {p.value.unpriced > 0 ? (
                  <small className="unp">
                    {p.value.unpriced === 1
                      ? "1 titel saknar inköpspris och räknas inte."
                      : `${formatInt(p.value.unpriced)} titlar saknar inköpspris och räknas inte.`}
                  </small>
                ) : null}
              </div>
            </Card>
          ) : null}

          <Card title="Senaste händelser">
            {p.events.length === 0 ? (
              <p className="empty">Inga händelser de senaste 60 dagarna.</p>
            ) : (
              <ul className="ev">
                {p.events.map((e) => (
                  <li key={e.key}>
                    <span className="dot" aria-hidden="true" />
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
        </div>
      </div>
    </div>
  );
}
