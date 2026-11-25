/**
 * "Vem pengarna är till" (G4): periodens försäljning delad på Min andel, partnern, butikerna
 * (en rad per bolag), momsen att spara, kortavgiften och återbetalningarna. Serverkomponent;
 * talen kommer färdiga ur loadMoneySplit (split-model.ts), här formateras de bara. Bara
 * ägare och admin (laddaren ger null för andra).
 */

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import { Card } from "@/components/v2/card";
import type { SearchParamsInput } from "@/components/shell/period-state";
import { loadMoneySplit } from "@/server/data/v2/analytics/split";
import type { SplitRow } from "@/server/data/v2/analytics/split-model";

import { kr, pct, plural } from "./fmt";

const PAY = { href: "/pengar/utbetalningar", label: "Betala ut" };

export async function SplitCard({ sp, days }: { sp: SearchParamsInput; days: string }) {
  const s = await loadMoneySplit(sp);
  if (!s) return null;
  const title = `Vem pengarna är till · ${days}`;
  if (s.state !== "ok") {
    return (
      <Card title={title} link={PAY} className="g4-split">
        <div className="g4-bempty">
          {s.state === "too_long"
            ? "Välj en kortare period (högst ett år) för att se fördelningen."
            : "Fördelningen gick inte att räkna just nu."}
        </div>
      </Card>
    );
  }
  const v = s.view;
  if (v.empty) {
    return (
      <Card title={title} link={PAY} className="g4-split">
        <div className="g4-bempty" data-testid="split-empty">
          Ingen försäljning {days}, så det finns inget att dela.
        </div>
      </Card>
    );
  }
  const max = Math.max(1, v.basisOre);
  return (
    <Card title={title} link={PAY} className="g4-split">
      <div className="g4-sp" data-testid="pengar-fordelning">
        <p className="g4-sp-basis">
          Av försäljningen {days}, {kr(v.basisDisplayOre)} inkl. moms. Butikernas andel enligt
          avtalen.{s.filtered ? " Gäller alla butiker, inte filtret." : ""}
        </p>
        {v.rows.map((row, i) => {
          const line = (
            <>
              <span className="nm">
                <b>{row.label}</b>
                <small>{subText(row)}</small>
              </span>
              <span className="bar" aria-hidden="true">
                <i
                  style={
                    {
                      "--i": i,
                      width: `${(Math.abs(row.amountOre) / max) * 100}%`,
                    } as CSSProperties
                  }
                />
              </span>
              <span className="am">
                {row.displayOre < 0 ? "−" : ""}
                {kr(Math.abs(row.displayOre))}
              </span>
              <span className="pc">{row.shareBp !== null ? pct(row.shareBp, 0) : ""}</span>
            </>
          );
          const cls = [
            "g4-sp-row",
            row.kind === "owner" ? "me" : "",
            row.amountOre < 0 ? "neg" : "",
            row.kind === "fees" || row.kind === "refunds" || row.kind === "vat" ? "ded" : "",
          ]
            .filter(Boolean)
            .join(" ");
          if (row.stores && row.stores.length > 0) {
            return (
              <details key={row.key} className="g4-sp-co" data-split-row={row.kind}>
                <summary className={cls}>{line}</summary>
                <div className="g4-sp-stores">
                  {row.stores.map((st) => (
                    <div key={st.storeId}>
                      <span>{st.name}</span>
                      <span className="tnum">{kr(st.amountOre)}</span>
                    </div>
                  ))}
                </div>
              </details>
            );
          }
          return (
            <div key={row.key} className={cls} data-split-row={row.kind}>
              {line}
            </div>
          );
        })}
        <Notes>
          {v.unpricedOrders > 0 ? (
            <>
              {plural(v.unpricedOrders, "order", "order")} saknar inköpspris. Partnerns inköp och
              momsen blir för låga.{" "}
              <Link href="/inkopspriser" className="underline underline-offset-4">
                Lägg in priset
              </Link>
            </>
          ) : null}
          {v.shareUnknownStoreIds.length > 0 ? (
            <>
              Andelen för {plural(v.shareUnknownStoreIds.length, "butik", "butiker")} gick inte att
              räkna och räknas som 0 här.{" "}
              <Link href="/butiker" className="underline underline-offset-4">
                Butiker
              </Link>
            </>
          ) : null}
        </Notes>
      </div>
    </Card>
  );
}

function Notes({ children }: { children: ReactNode[] }) {
  const items = children.filter(Boolean);
  if (items.length === 0) return null;
  return (
    <div className="g4-foot g4-sp-notes" role="note">
      {items.map((c, i) => (
        <p key={i}>{c}</p>
      ))}
    </div>
  );
}

/** Raden under namnet: varifrån beloppet kommer, kort. */
function subText(row: SplitRow): ReactNode {
  switch (row.kind) {
    case "owner":
      return row.amountOre < 0
        ? `Förlust. Du behöver lägga till ${kr(-row.amountOre)}.`
        : "Det som blir kvar till dig.";
    case "partner": {
      const p = row.partner;
      if (!p || !p.hasAgreement) {
        return (
          <>
            Inget avtal inlagt.{" "}
            <Link href="/installningar#partneravtal" className="underline underline-offset-4">
              Lägg in avtal
            </Link>
          </>
        );
      }
      const parts = [
        p.reimbOre > 0 ? `Inköpet ${kr(p.reimbOre)}` : null,
        p.bp !== null && p.bp > 0 ? `${pct(p.bp, 0)} av vinsten` : null,
      ].filter(Boolean);
      const base = parts.length > 0 ? parts.join(" + ") : "Enligt avtalet";
      // Vid förlust blir partnerns rad aldrig negativ: dess del av förlusten dras nästa gång.
      return p.lossOre < 0
        ? `${base}. Partnerns del av förlusten, ${kr(-p.lossOre)}, dras nästa gång.`
        : base;
    }
    case "store_owner": {
      const names = (row.stores ?? []).map((s) => s.name);
      return `${plural(names.length, "butik", "butiker")}: ${names.join(", ")}`;
    }
    case "store":
      return "Butikens andel enligt avtalet";
    case "vat":
      return row.vatMode === "vmb" ? "Moms på vinsten (VMB)" : "Momsen i försäljningen";
    case "fees":
      return "Nayax drar den innan pengarna kommer";
    case "refunds":
      return row.refundsVia === "nayax"
        ? "Nayax drar dem innan pengarna kommer"
        : "Du betalar tillbaka till kunderna själv";
  }
}
