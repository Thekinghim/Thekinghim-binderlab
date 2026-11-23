"use client";

import Link from "next/link";
import { useEffect, useState, type CSSProperties, type ReactNode } from "react";

import { MachineThumb } from "@/components/v2/machine-thumb";
import { PackImage } from "@/components/v2/pack-image";
import { ProfitBar } from "@/components/v2/profit-bar";
import { StoreFace } from "@/components/v2/store-face";
import { cn } from "@/lib/cn";
import { formatInt, formatMarginBp, formatSek } from "@/lib/format";

import type { ProfitLine, ViewKey } from "../_lib/model";
import {
  barCostOre,
  barMaxOre,
  barRevenueOre,
  barTitle,
  costNoun,
  isOnlyUnpriced,
  profitListGroups,
  subLine,
} from "../_lib/profit-list";
import { profitLabels } from "./profit-table";

import "./profit-list.css";

// Raderna glider in en gång per sidladdning. Byter man Titel/Automat/Butik (ofta) står de
// still; modulens minne överlever klientnavigeringen men inte en omladdning (som Hem).
let entered = false;
/** Längsta trappningen (12 × 28 ms) plus radens 420 ms. */
const ENTRANCE_MS = 12 * 28 + 420;

/** Rader med vinst som telefonen visar innan "Visa alla N med pris". */
const PHONE_TOP = 5;

const kr = (ore: number) => formatSek(ore / 100);

/** Packen, automaten eller butiken till vänster. Två storlekar: dator och telefon. */
function Visual({ view, row }: { view: ViewKey; row: ProfitLine }) {
  if (row.kind !== "item") return <span className="lp-vis" aria-hidden="true" />;
  if (view === "title") {
    return (
      <span className="lp-vis">
        <PackImage title={row.name} size="s" className="lp-d" />
        <PackImage title={row.name} size="m" className="lp-m" />
      </span>
    );
  }
  if (view === "machine") {
    return (
      <span className="lp-vis">
        <MachineThumb machineId={row.key} look={row.look} size="sm" className="lp-d" />
        <MachineThumb machineId={row.key} look={row.look} size="md" className="lp-m" />
      </span>
    );
  }
  return (
    <span className="lp-vis">
      <StoreFace name={row.name} size="md" />
    </span>
  );
}

function SetPrice({ row, big = false }: { row: ProfitLine; big?: boolean }) {
  if (!row.priceHref) return null;
  return (
    <Link href={row.priceHref} className={cn("lp-setp", big && "big")}>
      <span aria-hidden="true" className="lp-plus">
        +
      </span>
      Sätt pris<span className="sr-only"> för {row.name}</span>
    </Link>
  );
}

function Row({
  view,
  row,
  max,
  noun,
  profitLabel,
  index,
  selected,
  folded,
}: {
  view: ViewKey;
  row: ProfitLine;
  max: number;
  noun: "inköp" | "kostnader";
  profitLabel: string;
  index: number;
  selected: boolean;
  folded: boolean;
}) {
  const unknown = isOnlyUnpriced(row);
  const special = row.kind !== "item";
  const loss = !unknown && row.profitOre < 0;
  const delay = Math.min(index, 12) * 28;
  const name = row.code && view === "machine" ? `${row.code} ${row.name}` : row.name;
  return (
    <li
      className={cn("lp-row", unknown && "miss", special && "special", selected && "sel")}
      aria-current={selected ? "true" : undefined}
      data-folded={folded ? "" : undefined}
      style={{ "--d": `${delay}ms` } as CSSProperties}
    >
      <Visual view={view} row={row} />
      <span className="lp-t" title={name}>
        {name}
      </span>
      <span className="lp-s">
        {row.kind === "unallocated" ? "Hyra utan prissatta order" : subLine(row)}
      </span>
      {special ? null : (
        <span className="lp-bar">
          <ProfitBar
            revenue={barRevenueOre(row)}
            cost={unknown ? null : barCostOre(row)}
            max={max}
            delay={delay + 60}
            title={barTitle(row, noun, profitLabel)}
            label={
              unknown ? (
                `${kr(row.unpricedRevenueOre)} intäkt, vinst okänd`
              ) : row.marginBp === null ? undefined : (
                <b>{formatMarginBp(row.marginBp)}</b>
              )
            }
          />
        </span>
      )}
      <span className="lp-end">
        <span className={cn("lp-val", unknown && "unknown", loss && "loss")}>
          {unknown ? "Vinst okänd" : kr(row.profitOre)}
        </span>
        <SetPrice row={row} big={unknown} />
      </span>
    </li>
  );
}

/**
 * Vinsten per titel, automat eller butik som en lista med en staplad stapel per rad: intäkten
 * delad i kostnad (grått) och vår vinst (grönt), marginalen efter stapeln och vinsten till
 * höger. Rader utan inköpspris får en randig stapel och "Sätt pris". Titlar har sin packbild,
 * automater sin bild och butiker sin symbol. På telefonen kort: bild, vinst stort, stapel och
 * antal; de fem första med vinst och "Visa alla N med pris", och titlarna utan pris för sig.
 */
export function ProfitList({
  view,
  rows,
  totals,
  selectedKey,
  showStoreShare,
  footer,
}: {
  view: ViewKey;
  rows: readonly ProfitLine[];
  totals: ProfitLine;
  selectedKey: string | null;
  showStoreShare: boolean;
  footer?: ReactNode;
}) {
  const groups = profitListGroups(rows);
  const max = barMaxOre(rows);
  const noun = costNoun(totals, showStoreShare);
  const { profit: profitLabel } = profitLabels(showStoreShare);
  const selectedIndex = groups.priced.findIndex((r) => r.key === selectedKey);
  const [open, setOpen] = useState(selectedIndex >= PHONE_TOP);
  const folds = groups.priced.length > PHONE_TOP;
  const common = { view, max, noun, profitLabel };
  const [calm, setCalm] = useState(() => entered);
  useEffect(() => {
    entered = true;
    if (calm) return;
    const t = window.setTimeout(() => setCalm(true), ENTRANCE_MS);
    return () => window.clearTimeout(t);
  }, [calm]);

  return (
    <div className={cn("lp", calm && "calm")}>
      <div className="lp-axis" aria-hidden="true">
        <span />
        <span className="lp-ax">
          {`Intäkt, uppdelad i ${noun} och `}
          <em>{profitLabel.toLowerCase()}</em>
        </span>
        <span className="lp-ax r">{profitLabel}</span>
      </div>
      <ol className="lp-list" aria-label={`${profitLabel} per rad, mest först`}>
        {groups.priced.map((r, i) => (
          <Row
            key={r.key}
            row={r}
            index={i}
            selected={r.key === selectedKey}
            folded={folds && !open && i >= PHONE_TOP}
            {...common}
          />
        ))}
      </ol>
      {folds ? (
        <button
          type="button"
          className="lp-more"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? "Visa färre" : `Visa alla ${formatInt(groups.priced.length)} med pris`}
        </button>
      ) : null}
      {groups.unpriced.length > 0 ? (
        <>
          <h3 className="lp-sh">Saknar inköpspris</h3>
          <ol className="lp-list lp-miss" aria-label="Saknar inköpspris">
            {groups.unpriced.map((r, i) => (
              <Row
                key={r.key}
                row={r}
                index={groups.priced.length + i}
                selected={r.key === selectedKey}
                folded={false}
                {...common}
              />
            ))}
          </ol>
        </>
      ) : null}
      {groups.special.length > 0 ? (
        <ol className="lp-list lp-special" aria-label="Övrigt">
          {groups.special.map((r, i) => (
            <Row
              key={r.key}
              row={r}
              index={groups.priced.length + groups.unpriced.length + i}
              selected={false}
              folded={false}
              {...common}
            />
          ))}
        </ol>
      ) : null}
      {footer ? <div className="lp-foot">{footer}</div> : null}
    </div>
  );
}
