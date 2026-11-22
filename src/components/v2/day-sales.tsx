import type { CSSProperties } from "react";

import type { DaySales, DaySalesRow } from "@/analytics/day-sales";
import { formatInt, formatKronor, NBSP } from "@/lib/format";

import { Card } from "./card";
import { Empty } from "./empty";
import { PackImage } from "./pack-image";

/** Rader som visas innan resten fälls ihop ("Visa alla 14"). */
const VISIBLE = 8;

function kr(ore: number): string {
  return formatKronor(ore / 100, { decimals: 0 });
}

function pack(n: number): string {
  return `${formatInt(n)}${NBSP}pack`;
}

/**
 * "Sålt i går": det som såldes under perioden, per titel (packbild, antal, intäkt, vinst) och
 * per automat, med total och, för en enskild dag, köpen per timme. Påfyllaren ser bara antal
 * (servern skickar inga belopp, DaySales.economy = false).
 *
 * Serverkomponent. `title` är kortets rubrik ("Sålt i går", "Sålt · 14–20 nov.").
 */
export function DaySalesCard({
  sales,
  title,
  inline,
  link,
  className,
}: {
  sales: DaySales;
  title: string;
  /** Perioden i löptext ("i går") för tomt läge och skärmläsare. */
  inline: string;
  link?: { href: string; label: string };
  className?: string;
}) {
  const economy = sales.economy;
  return (
    <Card title={title} link={link} className={className ?? "v2-ds"}>
      {sales.units === 0 ? (
        <Empty title={`Inget sålt ${inline}`}>
          Köpen visas här när automaterna har sålt något under perioden.
        </Empty>
      ) : (
        <div className="v2-ds-body" data-testid="day-sales">
          <dl className="v2-ds-tot">
            <div>
              <dt>Sålda pack</dt>
              <dd data-testid="day-sales-units">{formatInt(sales.units)}</dd>
            </div>
            {economy && sales.revenueOre !== null ? (
              <div>
                <dt title="Alla sålda pack, exkl. moms (KPI-bandets intäkt räknar bara pack med inköpspris)">
                  Intäkt, alla pack
                </dt>
                <dd>{kr(sales.revenueOre)}</dd>
              </div>
            ) : null}
            {economy ? (
              <div>
                <dt>Vinst</dt>
                <dd className={sales.profitOre !== null && sales.profitOre < 0 ? "neg" : undefined}>
                  {sales.profitOre !== null ? kr(sales.profitOre) : "–"}
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Titlar</dt>
              <dd>{formatInt(sales.titles.length)}</dd>
            </div>
          </dl>

          {sales.hours.length === 24 ? <Hours sales={sales} inline={inline} /> : null}

          <div className="v2-ds-cols">
            <Rows heading="Per titel" rows={sales.titles} economy={economy} kind="title" />
            <Rows heading="Per automat" rows={sales.machines} economy={economy} kind="machine" />
          </div>
          {economy ? (
            <p className="v2-ds-note">
              Intäkt exkl. moms. Vinst för pack med inköpspris; ej fördelad hyra syns på Pengar.
            </p>
          ) : null}
        </div>
      )}
    </Card>
  );
}

function Hours({ sales, inline }: { sales: DaySales; inline: string }) {
  const max = Math.max(1, ...sales.hours.map((h) => h.units));
  const peak = sales.hours.reduce((b, h) => (h.units > b.units ? h : b), sales.hours[0]!);
  return (
    <div className="v2-ds-hours">
      <div className="hd">
        <b>Per timme</b>
        {peak.units > 0 ? (
          <span>
            Flest {String(peak.hour).padStart(2, "0")}–
            {String((peak.hour + 1) % 24).padStart(2, "0")}
            {": "}
            {pack(peak.units)}
          </span>
        ) : null}
      </div>
      <div className="bars" role="list" aria-label={`Sålda pack per timme ${inline}`}>
        {sales.hours.map((h) => {
          const text = `Kl. ${String(h.hour).padStart(2, "0")}: ${pack(h.units)}${
            sales.economy && h.units > 0 ? `, intäkt ${kr(h.revenueOre)}` : ""
          }`;
          return (
            <span
              key={h.hour}
              role="listitem"
              className={h.units === 0 ? "z" : undefined}
              title={text}
              aria-label={text}
              style={{ "--h": h.units / max } as CSSProperties}
            />
          );
        })}
      </div>
      <div className="ax" aria-hidden="true">
        <span>00</span>
        <span>06</span>
        <span>12</span>
        <span>18</span>
        <span>23</span>
      </div>
    </div>
  );
}

function Rows({
  heading,
  rows,
  economy,
  kind,
}: {
  heading: string;
  rows: readonly DaySalesRow[];
  economy: boolean;
  kind: "title" | "machine";
}) {
  const top = rows.slice(0, VISIBLE);
  const rest = rows.slice(VISIBLE);
  return (
    <section className="v2-ds-list" aria-label={heading}>
      <div className="lh">
        <h3>{heading}</h3>
        <span aria-hidden="true">{economy ? "Antal · intäkt · vinst" : "Antal"}</span>
      </div>
      <ul>
        {top.map((r) => (
          <Row key={r.id || "none"} r={r} economy={economy} kind={kind} />
        ))}
      </ul>
      {rest.length > 0 ? (
        <details>
          <summary>Visa alla {formatInt(rows.length)}</summary>
          <ul>
            {rest.map((r) => (
              <Row key={r.id || "none"} r={r} economy={economy} kind={kind} />
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  );
}

function Row({
  r,
  economy,
  kind,
}: {
  r: DaySalesRow;
  economy: boolean;
  kind: "title" | "machine";
}) {
  return (
    <li className="v2-ds-row" data-testid={`day-sales-${kind}`}>
      {kind === "title" ? <PackImage title={r.name} size="xs" /> : null}
      <span className="nm">
        <b>{r.name}</b>
        {r.code && r.code !== r.name ? <small>{r.code}</small> : null}
      </span>
      <span className="n">{pack(r.units)}</span>
      {economy ? (
        <>
          <span className="kr">{r.revenueOre !== null ? kr(r.revenueOre) : "–"}</span>
          <span className={r.profitOre !== null && r.profitOre < 0 ? "kr pf neg" : "kr pf"}>
            {r.profitOre !== null ? kr(r.profitOre) : "–"}
          </span>
        </>
      ) : null}
    </li>
  );
}
