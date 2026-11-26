/**
 * "Vem pengarna är till" (G4): periodens försäljning delad på Min andel, partnern, butikerna
 * (en rad per bolag), momsen att spara, kortavgiften och återbetalningarna. Serverkomponent;
 * talen kommer färdiga ur loadMoneySplit (split-model.ts), här formateras de bara. Bara
 * ägare och admin (laddaren ger null för andra). Visas på Hem (direkt under hjältekortet)
 * och på Pengar; stilen följer med komponenten (split-card.css).
 *
 * En butik vars andel inte gick att räkna (SHARE_UNKNOWN) står som "Kan inte räknas" i
 * stället för "0 kr" (den räknas som 0 i summan, så raderna summerar ändå till grunden).
 */

import Link from "next/link";
import type { CSSProperties, ReactNode } from "react";

import { day, monthName } from "@/analytics/todos/text";
import { Card } from "@/components/v2/card";
import type { SearchParamsInput } from "@/components/shell/period-state";
import { loadMoneySplit } from "@/server/data/v2/analytics/split";
import type { SplitRow } from "@/server/data/v2/analytics/split-model";

import { kr, pct, plural } from "./fmt";
import "./split-card.css";

const PAY = { href: "/pengar/utbetalningar", label: "Betala ut" };

export async function SplitCard({ sp, days }: { sp: SearchParamsInput; days: string }) {
  const s = await loadMoneySplit(sp);
  if (!s) return null;
  const title = `Vem pengarna är till · ${days}`;
  if (s.state !== "ok") {
    return (
      <Card title={title} link={PAY} className="g4-sp-card">
        <div className="g4-sp-empty">
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
      <Card title={title} link={PAY} className="g4-sp-card">
        <div className="g4-sp-empty" data-testid="split-empty">
          Ingen försäljning {days}, så det finns inget att dela.
        </div>
      </Card>
    );
  }
  // Stapeln: andel av försäljningen; utan försäljning (bara hyra) av den största raden.
  // Utan partneravtal får ägaren också tillbaka det korten kostade: säg det, så att andelen
  // inte läses som vinst.
  const noAgreement = v.rows.some((r) => r.kind === "partner" && !r.partner?.hasAgreement);
  // Nästa utbetalning till butikerna (avtalen: senast den 15:e månaden efter).
  const storesPaid = v.rows.some(
    (r) => (r.kind === "store_owner" || r.kind === "store") && r.amountOre > 0,
  );
  const max = Math.max(1, v.basisOre, ...v.rows.map((r) => Math.abs(r.amountOre)));
  return (
    <Card title={title} link={PAY} className="g4-sp-card">
      <div className="g4-sp" data-testid="pengar-fordelning">
        <p className="g4-sp-basis">
          Av allt kunderna betalat {days}: {kr(v.basisDisplayOre)} med moms, alla order. Butikernas
          andel enligt avtalen.{s.filtered ? " Gäller alla butiker, inte filtret." : ""}
        </p>
        {storesPaid ? (
          <p className="g4-sp-pay" data-testid="split-store-pay">
            Butikerna får betalt för {monthName(s.storePay.month)} senast{" "}
            {/* "15 dec." har redan en punkt: ingen dubbel punkt. */}
            <b>{day(s.storePay.due).replace(/\.$/, "")}</b>.
          </p>
        ) : null}
        {v.rows.map((row, i) => {
          // Hela raden är en andel som inte gick att räkna (0 kr): säg det i stället för "0 kr".
          const unknownRow = row.unknownStores > 0 && row.displayOre === 0;
          const line = (
            <>
              <span className="nm">
                <b>{row.label}</b>
                <small>{subText(row, noAgreement)}</small>
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
              {unknownRow ? (
                <span className="am unk">Kan inte räknas</span>
              ) : (
                <span className="am">
                  {row.displayOre < 0 ? "−" : ""}
                  {kr(Math.abs(row.displayOre))}
                </span>
              )}
              <span className="pc">
                {row.shareBp !== null && !unknownRow ? pct(row.shareBp, 0) : ""}
              </span>
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
                {/* "grid" i klassen: globals.css gör annars summary till flex på mobil. */}
                <summary className={`${cls} grid`}>{line}</summary>
                <div className="g4-sp-stores">
                  {row.stores.map((st) => (
                    <div
                      key={st.storeId}
                      className={st.shareUnknown ? "unk" : undefined}
                      data-share-unknown={st.shareUnknown ? "" : undefined}
                    >
                      <span>
                        {st.name}
                        {st.shareUnknown ? (
                          <small>{unknownReason(st.missingPrice, st.displayOre !== 0)}</small>
                        ) : null}
                      </span>
                      {st.shareUnknown && st.displayOre === 0 ? (
                        <span className="am">Kan inte räknas</span>
                      ) : (
                        <span className="tnum">{kr(st.displayOre)}</span>
                      )}
                    </div>
                  ))}
                </div>
              </details>
            );
          }
          return (
            <div
              key={row.key}
              className={cls}
              data-split-row={row.kind}
              data-share-unknown={row.unknownStores > 0 ? "" : undefined}
            >
              {line}
            </div>
          );
        })}
        <Notes>
          {v.unpricedOrders > 0 ? (
            <>
              {plural(v.unpricedOrders, "order", "order")} saknar inköpspris. Partnerns inköp och
              momsen blir för låga.{" "}
              <Link prefetch={false} href="/inkopspriser" className="underline underline-offset-4">
                Lägg in priset
              </Link>
            </>
          ) : null}
          {v.shareUnknownStoreIds.length > 0 ? (
            <>
              Andelen för {plural(v.shareUnknownStoreIds.length, "butik", "butiker")} kan inte
              räknas än. {v.shareUnknownStoreIds.length === 1 ? "Den står" : "De står"} som 0 kr i
              summan.{" "}
              <Link prefetch={false} href="/butiker" className="underline underline-offset-4">
                Butiker
              </Link>
            </>
          ) : null}
        </Notes>
      </div>
    </Card>
  );
}

/**
 * Varför en butiks andel saknas, kort: "Inköpspris saknas. Lägg in priset" (med länk) när
 * orsaken är saknade inköpspriser. `partly`: en del av perioden gick att räkna (beloppet
 * visas), annars står "Kan inte räknas" redan i beloppets ställe.
 */
function unknownReason(missingPrice: boolean, partly: boolean): ReactNode {
  if (!missingPrice) return partly ? "En del kan inte räknas än." : "Andelen kan inte räknas än.";
  return (
    <>
      {partly ? "En del kan inte räknas, inköpspris saknas." : "Inköpspris saknas."}{" "}
      <Link prefetch={false} href="/inkopspriser" className="underline underline-offset-4">
        Lägg in priset
      </Link>
    </>
  );
}

function Notes({ children }: { children: ReactNode[] }) {
  const items = children.filter(Boolean);
  if (items.length === 0) return null;
  return (
    <div className="g4-sp-notes" role="note">
      {items.map((c, i) => (
        <p key={i}>{c}</p>
      ))}
    </div>
  );
}

/** "50 % av vinsten", eller "50 % av vinsten, sedan 30 %" när avtalet ändrades i perioden. */
function profitText(bps: readonly number[]): string | null {
  if (bps.length === 0 || bps.every((bp) => bp === 0)) return null;
  const [first, ...rest] = bps.map((bp) => pct(bp, 0));
  return rest.length > 0
    ? `${first} av vinsten, sedan ${rest.join(", sedan ")}`
    : `${first} av vinsten`;
}

/** Raden under namnet: varifrån beloppet kommer, kort. */
function subText(row: SplitRow, noAgreement: boolean): ReactNode {
  switch (row.kind) {
    case "owner":
      return row.amountOre < 0
        ? `Förlust. Du behöver lägga till ${kr(-row.amountOre)}.`
        : noAgreement
          ? "Det som blir kvar till dig, med pengarna för korten du köpt in."
          : "Det som blir kvar till dig.";
    case "partner": {
      const p = row.partner;
      if (!p || !p.hasAgreement) {
        return (
          <>
            Inget avtal inlagt.{" "}
            <Link
              prefetch={false}
              href="/installningar#partneravtal"
              className="underline underline-offset-4"
            >
              Lägg in avtal
            </Link>
          </>
        );
      }
      const parts = [p.reimbOre > 0 ? `Inköpet ${kr(p.reimbOre)}` : null, profitText(p.bps)].filter(
        Boolean,
      );
      const base = parts.length > 0 ? parts.join(" + ") : "Enligt avtalet";
      // Vid förlust blir partnerns rad aldrig negativ: dess del av förlusten dras nästa gång.
      return p.lossOre < 0
        ? `${base}. Partnerns del av förlusten, ${kr(-p.lossOre)}, dras nästa gång.`
        : base;
    }
    case "store_owner": {
      const names = (row.stores ?? []).map((s) => s.name);
      const base = `${plural(names.length, "butik", "butiker")}: ${names.join(", ")}`;
      // Hela bolagets andel okänd: "Kan inte räknas" står redan i beloppets ställe.
      return row.unknownStores > 0 && row.displayOre !== 0
        ? `${base}. ${plural(row.unknownStores, "butik", "butiker")} kan inte räknas än.`
        : base;
    }
    case "store":
      return row.unknownStores > 0
        ? unknownReason(row.missingPrice, row.displayOre !== 0)
        : "Butikens andel enligt avtalet";
    case "vat":
      // Samma ord som VMB-raden i "Från intäkt till vinst".
      return row.vatMode === "vmb" ? "VMB-moms, moms på vinstmarginalen" : "Momsen i försäljningen";
    case "fees":
      return "Nayax drar den innan pengarna kommer";
    case "refunds":
      return row.refundsVia === "nayax"
        ? "Nayax drar dem innan pengarna kommer"
        : "Du betalar tillbaka till kunderna själv";
  }
}
