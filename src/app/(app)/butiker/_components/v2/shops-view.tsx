"use client";

import Link from "next/link";
import { useMemo, useState, type CSSProperties } from "react";

import { Button } from "@/components/v2/button";
import { CallLink, MapsLink } from "@/components/v2/call-link";
import { Card } from "@/components/v2/card";
import { Chips } from "@/components/v2/chips";
import { PackImage } from "@/components/v2/pack-image";
import { SearchField } from "@/components/v2/search-field";
import { Sheet } from "@/components/v2/sheet";
import { StatusDot } from "@/components/v2/status-dot";
import { usePhone } from "@/components/v2/use-media";
import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";
import type { FleetStatus, FleetStatusTone } from "@/analytics/fleet-status";

import {
  dayMonth,
  dayMonthShort,
  kr,
  krExact,
  monthName,
  monthShortCap,
  plural,
} from "../../../pengar/_components/fmt";
import {
  defaultShopId,
  filterCounts,
  groupByCity,
  inFilter,
  latestStatement,
  matchesShop,
  paymentHistory,
  shareHistory,
  type PaymentLike,
  type SettlementLike,
  type ShopFilter,
} from "../../_lib/v2-model";
import { PaySheet, type PaySheetItem } from "./pay-sheet";
import { PowerSwitch } from "./power-switch";
import { RegisterPaymentSheet } from "./register-payment-sheet";

export interface ShopView {
  readonly id: string;
  readonly name: string;
  readonly city: string | null;
  readonly address: string | null;
  readonly contactName: string | null;
  readonly phone: string | null;
  readonly email: string | null;
  readonly location: { readonly lat: number; readonly lng: number } | null;
  readonly machines: readonly {
    readonly id: string;
    readonly code: string;
    readonly name: string;
    readonly status: FleetStatus;
    readonly statusLabel: string;
    readonly tone: FleetStatusTone;
    readonly fillBp: number | null;
    readonly packs: readonly { readonly name: string; readonly empty: boolean }[];
    readonly href: string;
  }[];
  readonly profitOre: number;
  readonly perMachineOre: number | null;
  readonly shareOre: number;
  readonly earnedMonthOre: number;
  readonly monthlyShare: readonly { readonly month: string; readonly ore: number }[];
  readonly terms: string | null;
  readonly payOre: number;
  readonly payDue: string | null;
  readonly payLate: boolean;
  readonly power: { readonly on: string; readonly off: string } | null;
  readonly agreement: {
    readonly terms: string;
    readonly model: string;
    readonly validFrom: string;
    readonly validTo: string | null;
  } | null;
  readonly href: string;
}

const REFILL: ReadonlySet<FleetStatus> = new Set(["tom", "fyll-pa", "tom-snart"]);

function fillPct(bp: number | null): string {
  return bp === null ? "–" : `${formatInt(Math.round(bp / 100))}${NBSP}%`;
}

function powerText(p: ShopView["power"]): string {
  return p ? `Nattstängt ${p.off}–${p.on}` : "Alltid på";
}

/**
 * Butiker i V2 (prototypens .pg-but): sök, filter (Att betala, Nattstängt, Alltid på), butikerna
 * per stad med vår vinst, vinst per automat, andel och att betala, och den valda butiken till
 * höger (på telefon i ett ark): att betala, automaterna, andelen per månad, avtalet, uträkningen,
 * strömmen och betalningarna. Vald butik står i adressen (?valj=) utan att sidan laddas om.
 */
export function ShopsView({
  rows,
  payItems,
  settlements,
  payments,
  storeOptions,
  today,
  month,
  days,
  canEdit,
  initialId,
}: {
  rows: readonly ShopView[];
  payItems: readonly (PaySheetItem & { storeId: string })[];
  settlements: readonly SettlementLike[];
  payments: readonly PaymentLike[];
  storeOptions: readonly { id: string; name: string }[];
  today: string;
  month: { month: string; days: number };
  days: string;
  canEdit: boolean;
  initialId: string | null;
}) {
  const phone = usePhone();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ShopFilter>("alla");
  const [closed, setClosed] = useState<ReadonlySet<string>>(new Set());
  const [sel, setSel] = useState<string | null>(
    initialId && rows.some((r) => r.id === initialId) ? initialId : defaultShopId(rows),
  );
  const [sheetOpen, setSheetOpen] = useState(false);

  const counts = useMemo(() => filterCounts(rows), [rows]);
  const shown = useMemo(
    () => rows.filter((r) => inFilter(r, filter) && matchesShop(r, query)),
    [rows, filter, query],
  );
  const groups = useMemo(() => groupByCity(shown), [shown]);
  const payTotal = rows.reduce((n, r) => n + r.payOre, 0);
  const payStores = rows.filter((r) => r.payOre > 0).length;
  const shareTotal = rows.reduce((n, r) => n + r.shareOre, 0);
  const selected = rows.find((r) => r.id === sel) ?? null;
  const everPaid = useMemo(
    () => new Set(settlements.filter((s) => s.paidOn !== null).map((s) => s.storeId)),
    [settlements],
  );

  const choose = (id: string) => {
    setSel(id);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("valj", id);
      window.history.replaceState(window.history.state, "", url);
    } catch {
      // Adressen är bara ett bokmärke; valet fungerar ändå.
    }
    if (phone) setSheetOpen(true);
  };

  const list = (
    <Card
      title="Butiker"
      count={null}
      link={{ href: "/automater", label: "Automater" }}
      className="g4-list"
    >
      <div className="g4-btools">
        <SearchField
          value={query}
          onChange={setQuery}
          placeholder="Sök butik eller stad"
          ariaLabel="Sök butik eller stad"
        />
        <Chips<ShopFilter>
          ariaLabel="Visa butiker"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "alla", label: "Alla", count: counts.alla },
            { value: "betala", label: "Att betala", count: counts.betala },
            { value: "natt", label: "Nattstängt", count: counts.natt },
            { value: "alltid", label: "Alltid på", count: counts.alltid },
          ]}
        />
      </div>
      {payStores > 0 && filter !== "betala" ? (
        <button type="button" className="g4-bpay" onClick={() => setFilter("betala")}>
          <span>
            Att betala · <b>{plural(payStores, "butik", "butiker")}</b> · <b>{kr(payTotal)}</b>
          </span>
          <span className="lk">
            Visa dem <span aria-hidden="true">→</span>
          </span>
        </button>
      ) : null}
      <div className="g4-bhead" aria-hidden="true">
        <span>Butik</span>
        <span>Vår vinst {days}</span>
        <span>Per automat</span>
        <span>Andel {days}</span>
        <span>Att betala</span>
      </div>
      {groups.length === 0 ? (
        <div className="g4-bempty">Ingen butik matchar.</div>
      ) : (
        groups.map((g) => {
          const open = !closed.has(g.city) || query.trim() !== "";
          const refill = g.rows.reduce(
            (n, r) => n + r.machines.filter((m) => REFILL.has(m.status)).length,
            0,
          );
          return (
            <div key={g.city} role="group" aria-label={g.city}>
              <button
                type="button"
                className="g4-bg"
                aria-expanded={open}
                onClick={() =>
                  setClosed((c) => {
                    const n = new Set(c);
                    if (n.has(g.city)) n.delete(g.city);
                    else n.add(g.city);
                    return n;
                  })
                }
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                  <path
                    d="m6 9 6 6 6-6"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
                <b>{g.city}</b>
                <span>{plural(g.rows.length, "butik", "butiker")}</span>
                {g.payStores > 0 ? <span className="warn">{g.payStores} att betala</span> : null}
                {refill > 0 ? <span className="warn">{refill} att fylla på</span> : null}
                <span className="gk tnum">{kr(g.profitOre)}</span>
              </button>
              {open
                ? g.rows.map((r) => {
                    const toFill = r.machines.filter((m) => REFILL.has(m.status)).length;
                    const offline = r.machines.filter((m) => m.status === "offline").length;
                    return (
                      <button
                        key={r.id}
                        type="button"
                        className="g4-brow"
                        aria-current={r.id === sel ? "true" : undefined}
                        onClick={() => choose(r.id)}
                        data-shop={r.id}
                      >
                        <span className="nmc">
                          <span className="nm block">{r.name}</span>
                          <span className="ch">
                            <span>{plural(r.machines.length, "automat", "automater")}</span>
                            {toFill > 0 ? (
                              <span className="warn">· {toFill} att fylla på</span>
                            ) : null}
                            {offline > 0 ? <span className="dn">· {offline} offline</span> : null}
                            {r.terms ? <span>· {r.terms}</span> : null}
                            {r.power ? <span className="g4-nchip">Nattstängt</span> : null}
                          </span>
                        </span>
                        <span className={cn("r vin", r.profitOre > 0 && "up")}>
                          {kr(r.profitOre)}
                        </span>
                        <span className="r vpm">
                          {r.perMachineOre !== null ? kr(r.perMachineOre) : "–"}
                        </span>
                        <span className="r vsh">{kr(r.shareOre)}</span>
                        <span className={r.payOre > 0 ? "r due o" : "r due"}>
                          {r.payOre > 0 ? kr(r.payOre) : everPaid.has(r.id) ? "Betald" : null}
                        </span>
                        <span className="shr">Andel {kr(r.shareOre)}</span>
                      </button>
                    );
                  })
                : null}
            </div>
          );
        })
      )}
      <div className="g4-foot flex flex-wrap justify-between gap-2">
        <span>
          Butikernas andel {days}: <b className="text-v2-ink">{kr(shareTotal)}</b>
        </span>
        <span>Andelen räknas enligt varje butiks avtal, som avräkningen.</span>
      </div>
    </Card>
  );

  const detail = selected ? (
    <ShopDetail
      shop={selected}
      pay={payItems.find((p) => p.storeId === selected.id) ?? null}
      settlements={settlements}
      month={month}
      today={today}
      canEdit={canEdit}
      inSheet={phone}
    />
  ) : null;

  const paymentsCard = selected ? (
    <ShopPayments
      shop={selected}
      payments={payments}
      settlements={settlements}
      storeOptions={storeOptions}
      today={today}
      canEdit={canEdit}
    />
  ) : null;

  return (
    <div className="g4 g4-work">
      <div className="g4-col">
        <div data-o="" style={{ "--o": 1 } as CSSProperties}>
          {list}
        </div>
        {!phone ? (
          <>
            {paymentsCard}
            <ReportCard />
          </>
        ) : null}
      </div>
      {!phone ? <div className="g4-col g4-sticky">{detail}</div> : null}
      {phone && selected ? (
        <Sheet
          open={sheetOpen}
          onOpenChange={setSheetOpen}
          title={selected.name}
          description={[
            selected.city,
            plural(selected.machines.length, "automat", "automater"),
            powerText(selected.power),
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <div className="g4 flex flex-col gap-3" style={{ margin: "-14px -20px" }}>
            {detail}
            {paymentsCard}
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ShopDetail({
  shop,
  pay,
  settlements,
  month,
  today,
  canEdit,
  inSheet = false,
}: {
  shop: ShopView;
  inSheet?: boolean;
  pay: (PaySheetItem & { storeId: string }) | null;
  settlements: readonly SettlementLike[];
  month: { month: string; days: number };
  today: string;
  canEdit: boolean;
}) {
  const bars = shareHistory(
    settlements,
    shop.id,
    { month: month.month, earnedOre: shop.earnedMonthOre, days: month.days },
    6,
    shop.monthlyShare,
  );
  const max = Math.max(1, ...bars.map((b) => Math.max(0, b.amountOre, b.paceOre ?? 0)));
  const statement = latestStatement(settlements, shop.id);
  return (
    <section className="v2-card g4-det" aria-label={`Butik ${shop.name}`} data-shop-detail>
      <div className="top">
        {inSheet ? null : (
          <>
            <div className="row1">
              <span>Butik</span>
              <span>{powerText(shop.power)}</span>
            </div>
            <h3>{shop.name}</h3>
            <div className="lab">
              {[shop.city, plural(shop.machines.length, "automat", "automater")]
                .filter(Boolean)
                .join(" · ")}
            </div>
          </>
        )}
        <div className="say">
          {pay ? (
            <>
              <span className="lab">Att betala · {monthName(pay.month)}</span>
              <span className="amt">{krExact(pay.leftOre)}</span>
              <span className={pay.due < today ? "due dn" : "due"}>
                {pay.due < today
                  ? `Försenad sedan ${dayMonth(pay.due)}`
                  : `Senast ${dayMonth(pay.due)}`}
              </span>
              {canEdit ? (
                <div className="mt-2">
                  <PaySheet
                    item={pay}
                    today={today}
                    trigger={
                      <Button variant="act" size="lg">
                        Betala
                      </Button>
                    }
                  />
                </div>
              ) : null}
            </>
          ) : (
            <>
              <span className="lab">Andel hittills i {monthName(month.month)}</span>
              <span className="amt">{kr(shop.earnedMonthOre)}</span>
              <span className="lab">Inget att betala nu</span>
            </>
          )}
        </div>
      </div>
      {shop.machines.length > 0 ? (
        <div className="g4-bminis">
          {shop.machines.map((m) => (
            <Link key={m.id} href={m.href} className="g4-bmini">
              <span className="bt">
                <b>{m.name}</b>
                <span className={m.fillBp !== null && m.fillBp < 2500 ? "pc warn" : "pc"}>
                  {fillPct(m.fillBp)}
                </span>
              </span>
              {m.packs.length > 0 ? (
                <span className="pstrip" aria-hidden="true">
                  {m.packs.slice(0, 8).map((p, i) => (
                    <span key={`${p.name}-${i}`} className={p.empty ? "ps e" : "ps"} title={p.name}>
                      <PackImage title={p.name} size="xs" />
                    </span>
                  ))}
                  {m.packs.length > 8 ? <span className="more">+{m.packs.length - 8}</span> : null}
                </span>
              ) : (
                <span className="id">{m.code}</span>
              )}
              <StatusDot tone={m.tone} label={m.statusLabel} className="st" />
            </Link>
          ))}
        </div>
      ) : null}
      {bars.length > 1 && bars.some((b) => b.amountOre > 0) ? (
        <div className="g4-mchart">
          <div className="g4-chart-hd">
            <b>Butikens andel per månad</b>
            <span>Streckat: takt</span>
          </div>
          <div className="g4-mbars">
            {bars.map((b, i) => {
              const h = (Math.max(0, b.amountOre) / max) * 100;
              const pace = b.paceOre !== null ? (Math.max(0, b.paceOre) / max) * 100 : null;
              const label = `${monthShortCap(b.month)}${b.running ? ` (${b.days} d)` : ""}`;
              return (
                <div
                  key={b.month}
                  className={cn("mb", b.running && "now", b.amountOre <= 0 && "zero")}
                  tabIndex={0}
                  aria-label={
                    b.running && b.paceOre !== null
                      ? `${label}: ${kr(b.amountOre)} hittills, takt ${kr(b.paceOre)} för hela månaden`
                      : `${label}: ${kr(b.amountOre)}`
                  }
                  title={
                    b.running && b.paceOre !== null
                      ? `Hittills ${kr(b.amountOre)}. Takt för hela månaden ${kr(b.paceOre)}`
                      : kr(b.amountOre)
                  }
                >
                  <span className="t" style={{ "--i": i } as CSSProperties}>
                    {pace !== null ? (
                      <span className="pace" style={{ height: `${pace}%` }} aria-hidden="true" />
                    ) : null}
                    <i style={{ height: `${Math.max(b.amountOre > 0 ? 2 : 1, h)}%` }} />
                    <span
                      className="v"
                      style={{ bottom: `calc(${Math.max(h, pace ?? 0)}% + 4px)` }}
                      aria-hidden="true"
                    >
                      {b.amountOre > 0 ? formatInt(Math.round(b.amountOre / 100)) : "–"}
                    </span>
                  </span>
                </div>
              );
            })}
          </div>
          <div className="g4-mls" aria-hidden="true">
            {bars.map((b) => (
              <span key={b.month}>
                {monthShortCap(b.month)}
                {b.running ? <small>{b.days} d</small> : null}
              </span>
            ))}
          </div>
        </div>
      ) : null}
      <div className="g4-sec">
        <h4>Avtal</h4>
        <dl className="g4-dl">
          <dt>Andel</dt>
          <dd>
            <b>{shop.agreement?.terms ?? "Inget avtal (0 %)"}</b>
          </dd>
          {shop.agreement ? (
            <>
              <dt>Form</dt>
              <dd>{shop.agreement.model}</dd>
              <dt>Giltig från</dt>
              <dd>
                {dayMonth(shop.agreement.validFrom)} {shop.agreement.validFrom.slice(0, 4)}
                {shop.agreement.validTo ? ` – ${dayMonthShort(shop.agreement.validTo)}` : ""}
              </dd>
            </>
          ) : null}
          <dt>Adress</dt>
          <dd>
            {shop.address || shop.city ? (
              <>
                {[shop.address, shop.city].filter(Boolean).join(", ")}
                <MapsLink
                  address={shop.address}
                  city={shop.city}
                  lat={shop.location?.lat}
                  lng={shop.location?.lng}
                  size="sm"
                />
              </>
            ) : (
              "–"
            )}
            {!shop.location && canEdit ? (
              <small className="lab block">
                Läge saknas: lägg in koordinater så räknas körsträckan.
              </small>
            ) : null}
          </dd>
          <dt>Kontakt</dt>
          <dd>
            {shop.contactName || shop.phone || shop.email ? (
              <>
                {shop.contactName ? <b>{shop.contactName}</b> : null}
                {shop.phone ? <span className="block">{shop.phone}</span> : null}
                {shop.email ? <a href={`mailto:${shop.email}`}>{shop.email}</a> : null}
                <CallLink phone={shop.phone} name={shop.contactName} size="sm" />
              </>
            ) : (
              "–"
            )}
          </dd>
        </dl>
        {statement?.statement ? (
          <div className="g4-calc">
            <b>Så räknas andelen · {monthName(statement.month)}</b>
            {statement.statement.steps.map((s) => (
              <div key={s.label} className="cr">
                <span>
                  {s.label}
                  {s.calculation ? <span className="lab"> · {s.calculation}</span> : null}
                </span>
                <b>{krExact(s.amountOre)}</b>
              </div>
            ))}
            <div className="cr tot">
              <span>Butikens andel</span>
              <b>{krExact(statement.statement.totalOre)}</b>
            </div>
          </div>
        ) : null}
      </div>
      <div className="g4-sec">
        <h4>Strömmen till automaten</h4>
        <PowerSwitch
          key={shop.id}
          storeId={shop.id}
          storeName={shop.name}
          initial={shop.power}
          canEdit={canEdit}
        />
      </div>
      <Link className="g4-more" href={shop.href}>
        Allt om butiken <span aria-hidden="true">→</span>
      </Link>
    </section>
  );
}

/* ------------------------------------------------------------------ */

function ShopPayments({
  shop,
  payments,
  settlements,
  storeOptions,
  today,
  canEdit,
}: {
  shop: ShopView;
  payments: readonly PaymentLike[];
  settlements: readonly SettlementLike[];
  storeOptions: readonly { id: string; name: string }[];
  today: string;
  canEdit: boolean;
}) {
  const rows = paymentHistory(payments, settlements, shop.id);
  return (
    <Card
      title={`Betalningar · ${shop.name}`}
      actions={
        canEdit ? (
          <RegisterPaymentSheet
            key={shop.id}
            stores={storeOptions}
            today={today}
            defaultStoreId={shop.id}
          />
        ) : undefined
      }
    >
      {rows.length === 0 ? (
        <div className="g4-bempty">Inga betalningar till butiken än.</div>
      ) : (
        <table className="g4-paylist">
          <thead>
            <tr>
              <th scope="col">Betald</th>
              <th scope="col" className="r">
                Belopp
              </th>
              <th scope="col" className="hm">
                Period
              </th>
              <th scope="col" className="hm">
                Så delades den
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.slice(0, 8).map((p) => (
              <tr key={p.key}>
                <td>{dayMonthShort(p.paidOn)}</td>
                <td className="r tnum">{krExact(p.amountOre)}</td>
                <td className="hm">
                  {dayMonthShort(p.start)} – {dayMonthShort(p.end)}
                </td>
                <td className="hm">
                  {p.parts
                    .map((x) =>
                      p.parts.length > 1
                        ? `${monthShortCap(x.month)} ${kr(x.amountOre)}`
                        : monthShortCap(x.month),
                    )
                    .join(" · ")}
                  {p.kind === "settlement" ? " (avräkning)" : ""}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function ReportCard() {
  return (
    <Card title="Rapport">
      <div className="v2-card-body flex flex-wrap items-center justify-between gap-3">
        <div>
          <b className="block font-[650]">Månadsrapport till butiken</b>
          <span className="lab">Försäljning, butikens andel och vad som är betalt.</span>
        </div>
        <Link className="v2-btn" href="/rapporter">
          Rapporter <span aria-hidden="true">→</span>
        </Link>
      </div>
    </Card>
  );
}
