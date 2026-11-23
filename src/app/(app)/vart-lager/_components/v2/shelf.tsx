"use client";

import type { CSSProperties } from "react";
import { useState } from "react";

import { ButtonLink } from "@/components/v2/button";
import { PackImage } from "@/components/v2/pack-image";
import { PackStack } from "@/components/v2/pack-visuals";
import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";

import type { VartLagerRow } from "../../_lib/model";
import {
  daysShare,
  homeShare,
  SHELF_SCALE_DAYS,
  shelfFlag,
  shelfOrder,
  shelfTone,
  wayBadge,
} from "../../_lib/shelf";

/*
 * Hyllan på Vårt lager: en ruta per titel med packhögen (tjockare ju fler hemma), hemma/ute,
 * en stapel hemma mot automaterna och "Räcker N d" (Hemma räcker) med ett streck vid
 * leveranstiden. Det som behöver köpas in står först med "Köp in N". Utgångna titlar viks
 * ihop längst ner. Bara presentation av vymodellens tal.
 */

export interface ShelfWay {
  readonly qty: number;
  readonly expectedOn: string;
  readonly late: boolean;
}

export interface ShelfProps {
  rows: readonly VartLagerRow[];
  /** Utgångna titlar (viks ihop), eller tom när chipet Utgår redan visar dem. */
  retired: readonly VartLagerRow[];
  way: ReadonlyMap<string, ShelfWay>;
  /** Leveranstid i dagar per titel (strecket på Räcker), ur inköpsplanen. */
  leadDays: Readonly<Record<string, number>>;
  /** Visa Köp in (ekonomiroller, samma som tabellens Beställ). */
  showBuy: boolean;
  packHref: Readonly<Record<string, string>>;
  today: string;
}

function buyText(r: VartLagerRow): string {
  const a = r.action!;
  const qty = a.qty === null ? "" : ` ${formatInt(a.qty)}${a.unit === "st" ? "" : ` ${a.unit}`}`;
  return a.kind === "pack" ? `Packa${qty}` : `Köp in${qty}`;
}

function Tile({
  r,
  i,
  way,
  lead,
  showBuy,
  href,
  today,
}: {
  r: VartLagerRow;
  i: number;
  way: ShelfWay | undefined;
  lead: number | undefined;
  showBuy: boolean;
  href: string | undefined;
  today: string;
}) {
  const home = Math.max(0, r.home);
  const tone = shelfTone(r);
  const flag = shelfFlag(r);
  const ghost = home <= 0 && way !== undefined;
  const share = homeShare(home, r.inMachines);
  const days = r.daysLeft;
  return (
    <li
      className={cn("tile", tone)}
      style={{ "--i": Math.min(i, 14) } as CSSProperties}
      data-title={r.name}
    >
      {flag ? <span className="flag">{flag}</span> : null}
      <div className="stage">
        <PackStack title={r.name} count={home} ghost={ghost}>
          {ghost ? (
            <span className="wtag">
              +{formatInt(way.qty)}
              {NBSP}på väg
            </span>
          ) : null}
        </PackStack>
      </div>
      <b className="nm">{r.name}</b>
      <span className="ct">
        <b>{formatInt(home)}</b> hemma
        <span className="ute"> · {formatInt(r.inMachines)} ute</span>
      </span>
      <span className="sb" aria-hidden="true">
        {share !== null ? (
          <>
            <i style={{ flexGrow: share }} />
            <i style={{ flexGrow: 1 - share }} />
          </>
        ) : null}
      </span>
      {ghost ? (
        <span className="rk">
          <span className="rt">
            <span className="lbl">Kommer</span>
            <b className={way.late || way.expectedOn < today ? "late" : undefined}>
              {wayBadge(way.expectedOn, today, way.late)}
            </b>
          </span>
          <span className="rb" aria-hidden="true" />
        </span>
      ) : days === null ? null : (
        // Utan försäljningstakt finns inget "räcker": ingen tom stapel med streck.
        <span className="rk">
          <span className="rt">
            <span className="lbl">Räcker</span>
            <b>
              <span className="mob">räcker </span>
              {`${formatInt(days)}${NBSP}d`}
            </b>
          </span>
          <span className="rb" aria-hidden="true">
            <i style={{ transform: `scaleX(${daysShare(days)})` }} />
            {lead !== undefined && lead > 0 && lead < SHELF_SCALE_DAYS ? (
              <em style={{ left: `${(lead / SHELF_SCALE_DAYS) * 100}%` }} />
            ) : null}
          </span>
        </span>
      )}
      {showBuy && r.action ? (
        <ButtonLink
          variant="act"
          size="sm"
          className="buyb"
          href={r.action.kind === "pack" ? (href ?? "/vart-lager/mystery") : "/prognos"}
          aria-label={`${buyText(r)}, ${r.name}`}
        >
          {buyText(r)}
        </ButtonLink>
      ) : null}
    </li>
  );
}

export function Shelf(p: ShelfProps) {
  const [open, setOpen] = useState(false);
  const rows = shelfOrder(p.rows);
  const tile = (r: VartLagerRow, i: number) => (
    <Tile
      key={r.titleId}
      r={r}
      i={i}
      way={p.way.get(r.titleId)}
      lead={p.leadDays[r.titleId]}
      showBuy={p.showBuy}
      href={p.packHref[r.titleId]}
      today={p.today}
    />
  );
  const retiredHome = p.retired.reduce((s, r) => s + Math.max(0, r.home), 0);
  const retiredOut = p.retired.reduce((s, r) => s + r.inMachines, 0);
  return (
    <>
      <ul className="shelf" aria-label="Lagret per titel">
        {rows.map(tile)}
      </ul>
      {p.retired.length > 0 ? (
        <>
          <button
            type="button"
            className="fold"
            aria-expanded={open}
            onClick={() => setOpen((v) => !v)}
          >
            <span className="fimg" aria-hidden="true">
              {p.retired.slice(0, 3).map((r) => (
                <PackImage key={r.titleId} title={r.name} size="xs" />
              ))}
            </span>
            <span className="ftx">
              <b>Utgår · {formatInt(p.retired.length)}</b> ·{" "}
              {p.retired.map((r) => r.name).join(", ")}. {formatInt(retiredHome)} hemma,{" "}
              {formatInt(retiredOut)} ute.
            </span>
            <span className="fgo">{open ? "Dölj" : "Visa"}</span>
          </button>
          {open ? (
            <ul className="shelf idle" aria-label="Titlar som utgår">
              {p.retired.map(tile)}
            </ul>
          ) : null}
        </>
      ) : null}
    </>
  );
}
