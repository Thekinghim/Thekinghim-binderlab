"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { Badge } from "@/components/v2/badge";
import { Button } from "@/components/v2/button";
import { CallLink, MapsLink } from "@/components/v2/call-link";
import { Card } from "@/components/v2/card";
import { Chips } from "@/components/v2/chips";
import { MachineThumb } from "@/components/v2/machine-thumb";
import { PackFan } from "@/components/v2/pack-visuals";
import { PackImage } from "@/components/v2/pack-image";
import { SearchField } from "@/components/v2/search-field";
import { Sheet } from "@/components/v2/sheet";
import { StatusDot } from "@/components/v2/status-dot";
import { StoreFace } from "@/components/v2/store-face";
import { usePhone } from "@/components/v2/use-media";
import { storeFace } from "@/components/v2/visual-math";
import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";
import type { MachineLook } from "@/lib/machine-look";
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
import type { LeadPin, ShopVisuals } from "../../_lib/visual-data";
import { sparkPoints, type StoreSales } from "../../_lib/visual-model";
import {
  defaultShopId,
  filterCounts,
  inFilter,
  latestStatement,
  matchesShop,
  paymentHistory,
  shareHistory,
  sortByProfit,
  type PaymentLike,
  type SettlementLike,
  type ShopFilter,
} from "../../_lib/v2-model";
import { PaySheet, type PaySheetItem } from "./pay-sheet";
import { PowerSwitch } from "./power-switch";
import { RegisterPaymentSheet } from "./register-payment-sheet";
import { ShopsMap, type MapStore } from "./shops-map";

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
    readonly appearance: MachineLook;
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
  readonly contract: "signed" | "unsigned" | "missing" | null;
  readonly href: string;
}

const REFILL: ReadonlySet<FleetStatus> = new Set(["tom", "fyll-pa", "tom-snart"]);
/** Packbilder per automat i butikens remsa (storlek xs); resten blir "+N". */
const MINI_PACKS = 6;
/** Automater i butikskortets banner; fler blir "+N". */
const BANNER_MACHINES = 2;
/** Platser i expansionen i kartans sidoruta. */
const SIDE_LEADS = 3;

const WEEKDAY = ["söndag", "måndag", "tisdag", "onsdag", "torsdag", "fredag", "lördag"];

function fillPct(bp: number | null): string {
  return bp === null ? "–" : `${formatInt(Math.round(bp / 100))}${NBSP}%`;
}

function powerText(p: ShopView["power"]): string {
  return p ? `Nattstängt ${p.off}–${p.on}` : "Alltid på";
}

function offlineCount(r: ShopView): number {
  return r.machines.filter((m) => m.status === "offline").length;
}

/** "fredag 20 nov" (svensk tid), "i dag" och "i går" för de närmaste dagarna. */
function refillText(iso: string, today: string): string {
  const date = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
  if (date === today) return "i dag";
  const y = new Date(`${today}T12:00:00Z`);
  y.setUTCDate(y.getUTCDate() - 1);
  if (date === y.toISOString().slice(0, 10)) return "i går";
  const wd = WEEKDAY[new Date(`${date}T12:00:00Z`).getUTCDay()];
  return `${wd} ${dayMonthShort(date)}`;
}

function Spark({ values }: { values: readonly number[] | undefined }) {
  if (!values || values.every((v) => v === 0)) return null;
  const pts = sparkPoints(values, 56, 18);
  if (!pts) return null;
  return (
    <svg className="bt6-spark" width="56" height="18" viewBox="0 0 56 18" aria-hidden="true">
      <polyline points={pts} />
    </svg>
  );
}

/**
 * Butiker i V2 (visuellt/06): kartan överst (en prick per butik, storleken efter vinsten för
 * ägaren, offline röd, expansionen streckad), sedan listan med butikens symbol och en liten
 * kurva (sålda pack över perioden), och den valda butiken till höger (på telefon i ett ark) med
 * banner: butikens mest sålda pack och automater. Sök och filter (Att betala, Offline,
 * Nattstängt); en prick på kartan filtrerar listan. Vald butik står i adressen (?valj=) utan
 * att sidan laddas om. På telefon är arket ett steg i historiken: svepet bakåt stänger arket
 * (inte sidan), och ?valj försvinner när arket stängs.
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
  visuals,
  sizeByProfit,
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
  visuals: ShopVisuals;
  /** Prickarnas storlek efter vinsten (bara ägaren). */
  sizeByProfit: boolean;
}) {
  const phone = usePhone();
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ShopFilter>("alla");
  const [mapFilter, setMapFilter] = useState<string | null>(null);
  const sorted = useMemo(() => sortByProfit(rows), [rows]);
  const [sel, setSel] = useState<string | null>(
    initialId && rows.some((r) => r.id === initialId) ? initialId : defaultShopId(sorted),
  );
  const [sheetOpen, setSheetOpen] = useState(false);

  const listRows = useMemo(() => sorted.map((r) => ({ ...r, offline: offlineCount(r) })), [sorted]);
  const counts = useMemo(() => filterCounts(listRows), [listRows]);
  const shown = useMemo(
    () =>
      listRows.filter(
        (r) =>
          (mapFilter === null || r.id === mapFilter) &&
          inFilter(r, filter) &&
          matchesShop(r, query),
      ),
    [listRows, filter, query, mapFilter],
  );
  const payTotal = rows.reduce((n, r) => n + r.payOre, 0);
  const payStores = rows.filter((r) => r.payOre > 0).length;
  const shareTotal = rows.reduce((n, r) => n + r.shareOre, 0);
  const profitTotal = rows.reduce((n, r) => n + r.profitOre, 0);
  const machineTotal = rows.reduce((n, r) => n + r.machines.length, 0);
  const selected = rows.find((r) => r.id === sel) ?? null;
  const everPaid = useMemo(
    () => new Set(settlements.filter((s) => s.paidOn !== null).map((s) => s.storeId)),
    [settlements],
  );
  const face = (id: string) => visuals.faces[id] ?? { storeType: null, city: null };

  // Arket öppnades med ett eget steg i historiken (pushState), som stängningen backar ur.
  const sheetEntry = useRef(false);

  const choose = (id: string, openSheet = true) => {
    setSel(id);
    const sheet = phone && openSheet;
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("valj", id);
      if (sheet && !sheetOpen) {
        window.history.pushState(null, "", url);
        sheetEntry.current = true;
      } else {
        window.history.replaceState(window.history.state, "", url);
      }
    } catch {
      // Adressen är bara ett bokmärke; valet fungerar ändå.
    }
    if (sheet) setSheetOpen(true);
  };

  /** Stäng arket: backa ur arkets steg, annars ta bort ?valj ur adressen. */
  const closeSheet = () => {
    setSheetOpen(false);
    if (sheetEntry.current) {
      sheetEntry.current = false;
      window.history.back();
      return;
    }
    try {
      const url = new URL(window.location.href);
      url.searchParams.delete("valj");
      window.history.replaceState(window.history.state, "", url);
    } catch {
      // Se ovan.
    }
  };

  // Svepet bakåt (eller webbläsarens bakåt) medan arket är öppet stänger arket.
  useEffect(() => {
    if (!sheetOpen) return;
    const onPop = () => {
      sheetEntry.current = false;
      setSheetOpen(false);
    };
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, [sheetOpen]);

  const mapStores: MapStore[] = useMemo(
    () =>
      rows.map((r) => {
        const f = visuals.faces[r.id];
        return {
          id: r.id,
          name: r.name,
          city: r.city ?? f?.city ?? null,
          storeType: f?.storeType ?? null,
          lat: r.location?.lat ?? f?.lat ?? null,
          lng: r.location?.lng ?? f?.lng ?? null,
          profitOre: r.profitOre,
          machines: r.machines.length,
          offline: offlineCount(r) > 0,
          tip: `${r.name} · ${kr(r.profitOre)}`,
        };
      }),
    [rows, visuals.faces],
  );

  const map = (
    <section
      className="v2-card bt6-mapcard"
      aria-label="Butikerna på kartan"
      data-o=""
      style={{ "--o": -1 } as CSSProperties}
    >
      <ShopsMap
        stores={mapStores}
        leads={visuals.leads}
        selectedId={sel}
        filterId={mapFilter}
        onPick={(id) => {
          setMapFilter((cur) => (cur === id ? null : id));
          choose(id, false);
        }}
        onClear={() => setMapFilter(null)}
        sizeByProfit={sizeByProfit}
        phone={phone}
        legendProfit={`Vinst ${days}`}
      />
      {!phone ? (
        <div className="bt6-mside">
          <div>
            <div className="k">
              {plural(rows.length, "butik", "butiker")} ·{" "}
              {plural(machineTotal, "automat", "automater")}
            </div>
            <div className="big tnum">
              {kr(profitTotal)}
              <small>vinst {days}</small>
            </div>
          </div>
          <LeadList leads={visuals.leads} />
        </div>
      ) : null}
    </section>
  );

  const list = (
    <Card
      title={
        phone ? (
          <>
            {plural(rows.length, "butik", "butiker")}{" "}
            <span className="font-normal text-v2-mute">
              · {plural(machineTotal, "automat", "automater")}
            </span>
          </>
        ) : (
          <>
            Butiker <span className="font-normal text-v2-mute">{formatInt(rows.length)}</span>
          </>
        )
      }
      count={null}
      link={{ href: "/automater", label: "Automater" }}
      className="g4-list bt6-list"
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
          scroll
          value={filter}
          onChange={setFilter}
          options={[
            { value: "alla", label: "Alla", count: counts.alla },
            { value: "betala", label: "Att betala", count: counts.betala },
            { value: "offline", label: "Offline", count: counts.offline },
            { value: "natt", label: "Nattstängt", count: counts.natt },
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
      <div className="g4-bhead bt6-row" aria-hidden="true">
        <span className="hb">Butik</span>
        <span>Vår vinst {days}</span>
        <span>Per automat</span>
        <span>Andel {days}</span>
        <span>Att betala</span>
      </div>
      {shown.length === 0 ? (
        <div className="g4-bempty">Ingen butik matchar.</div>
      ) : (
        <ul className="bt6-rows">
          {shown.map((r, i) => {
            const f = face(r.id);
            const toFill = r.machines.filter((m) => REFILL.has(m.status)).length;
            const city = r.city ?? f.city;
            return (
              <li key={r.id} style={{ "--i": Math.min(i, 12) } as CSSProperties}>
                <button
                  type="button"
                  className="g4-brow bt6-row"
                  aria-current={r.id === sel ? "true" : undefined}
                  onClick={() => choose(r.id)}
                  data-shop={r.id}
                >
                  <StoreFace name={r.name} storeType={f.storeType} city={city} size="md" />
                  <span className="nmc">
                    <span className="nm block">{r.name}</span>
                    <span className="ch">
                      {[city, plural(r.machines.length, "automat", "automater")]
                        .filter(Boolean)
                        .join(" · ")}
                      {toFill > 0 ? <span className="warn"> · {toFill} att fylla på</span> : null}
                      {r.offline > 0 ? <span className="dn"> · {r.offline} offline</span> : null}
                      {r.machines.length === 0 && r.profitOre === 0 ? (
                        <span className="dt"> · ingen automat än</span>
                      ) : r.terms ? (
                        <span className="dt"> · {r.terms}</span>
                      ) : null}
                      {r.power ? <span className="g4-nchip dt">Nattstängt</span> : null}
                    </span>
                  </span>
                  <span className={cn("r vin", r.profitOre > 0 ? "up" : "zero")}>
                    <Spark values={visuals.sales[r.id]?.spark} />
                    {kr(r.profitOre)}
                  </span>
                  <span className="r vpm">
                    {r.perMachineOre !== null ? kr(r.perMachineOre) : "–"}
                  </span>
                  <span className="r vsh">{kr(r.shareOre)}</span>
                  <span className={r.payOre > 0 ? "r due o" : "r due"}>
                    {r.payOre > 0 ? kr(r.payOre) : everPaid.has(r.id) ? "Betald" : kr(0)}
                  </span>
                  <span className="bt6-ph">
                    <b className={r.profitOre > 0 ? "up" : "zero"}>{kr(r.profitOre)}</b>
                    {r.payOre > 0 ? (
                      <span className="o">Att betala {kr(r.payOre)}</span>
                    ) : (
                      <span>vinst {days}</span>
                    )}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
      <div className="g4-foot flex flex-wrap justify-between gap-2">
        <span>
          Butikernas andel {days}: <b className="text-v2-ink">{kr(shareTotal)}</b>
        </span>
        <span>Provision och fast hyra enligt varje butiks avtal, som avräkningen.</span>
      </div>
    </Card>
  );

  const detail = selected ? (
    <ShopDetail
      key={selected.id}
      shop={selected}
      face={face(selected.id)}
      sales={visuals.sales[selected.id] ?? null}
      lastRefill={visuals.lastRefill[selected.id] ?? null}
      pay={payItems.find((p) => p.storeId === selected.id) ?? null}
      settlements={settlements}
      month={month}
      days={days}
      today={today}
      canEdit={canEdit}
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
    <div className="g4 g4-work bt6">
      <div className="g4-col">
        {map}
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
          onOpenChange={(open) => (open ? setSheetOpen(true) : closeSheet())}
          hideHead
          title={selected.name}
          description={[
            selected.city,
            plural(selected.machines.length, "automat", "automater"),
            powerText(selected.power),
          ]
            .filter(Boolean)
            .join(" · ")}
        >
          <div className="g4 bt6 flex flex-col gap-3" style={{ margin: "-14px -20px" }}>
            {detail}
            {paymentsCard}
          </div>
        </Sheet>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */

/** Kartans sidoruta: platserna i expansionen ("luckor på kartan"). */
function LeadList({ leads }: { leads: readonly LeadPin[] }) {
  return (
    <div className="bt6-leads">
      <div className="k">
        Luckor på kartan ·{" "}
        <Link href="/expansion" className="underline-offset-4 hover:underline">
          Expansion
        </Link>
      </div>
      {leads.length === 0 ? (
        <p className="none">Inga platser på gång. Lägg till en i Expansion.</p>
      ) : (
        <ul>
          {leads.slice(0, SIDE_LEADS).map((l) => (
            <li key={l.id}>
              <span className="ring" aria-hidden="true" />
              <span className="min-w-0">
                <b>{l.city ?? l.name}</b>
                {l.city ? <span>{l.name}</span> : null}
              </span>
              <span className={cn("st", l.warm && "y")}>{l.stage}</span>
            </li>
          ))}
          {leads.length > SIDE_LEADS ? (
            <li className="more">
              <Link href="/expansion">
                {plural(leads.length - SIDE_LEADS, "plats", "platser")} till{" "}
                <span aria-hidden="true">→</span>
              </Link>
            </li>
          ) : null}
        </ul>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function ShopDetail({
  shop,
  face,
  sales,
  lastRefill,
  pay,
  settlements,
  month,
  days,
  today,
  canEdit,
}: {
  shop: ShopView;
  face: { storeType: string | null; city: string | null };
  sales: StoreSales | null;
  lastRefill: string | null;
  pay: (PaySheetItem & { storeId: string }) | null;
  settlements: readonly SettlementLike[];
  month: { month: string; days: number };
  days: string;
  today: string;
  canEdit: boolean;
}) {
  const city = shop.city ?? face.city;
  const tone = storeFace({ name: shop.name, storeType: face.storeType, city });
  const top = sales?.top ?? [];
  // Inget sålt i perioden: automaternas titlar i bannern i stället.
  const fanTitles =
    top.length > 0
      ? top.slice(0, 3).map((t) => t.title)
      : [...new Set(shop.machines.flatMap((m) => m.packs.map((p) => p.name)))].slice(0, 3);
  const maxTop = Math.max(1, ...top.map((t) => t.count));
  const topSum = top.reduce((n, t) => n + t.count, 0);
  const bars = shareHistory(
    settlements,
    shop.id,
    { month: month.month, earnedOre: shop.earnedMonthOre, days: month.days },
    6,
    shop.monthlyShare,
  );
  const max = Math.max(1, ...bars.map((b) => Math.max(0, b.amountOre, b.paceOre ?? 0)));
  const statement = latestStatement(settlements, shop.id);
  const shownMachines = shop.machines.slice(0, BANNER_MACHINES);
  const contract =
    shop.contract === "signed" ? (
      <Badge tone="success">Signerat</Badge>
    ) : shop.contract === "unsigned" ? (
      <Badge tone={shop.machines.length > 0 ? "critical" : "neutral"}>Ej signerat</Badge>
    ) : shop.contract === "missing" ? (
      <Badge tone={shop.machines.length > 0 ? "critical" : "neutral"}>Saknas</Badge>
    ) : null;

  return (
    <section
      className="v2-card g4-det bt6-card"
      aria-label={`Butik ${shop.name}`}
      data-shop-detail
      style={{ "--sf-bg": tone.bg, "--sf-fg": tone.fg } as CSSProperties}
    >
      <div className="bt6-banner" aria-hidden="true">
        <PackFan titles={fanTitles} size="m" className="fan" />
        {shownMachines.length > 0 ? (
          <span className="mach">
            {shownMachines.map((m) => (
              <span key={m.id} className="m">
                <MachineThumb machineId={m.id} look={m.appearance} size="md" />
                <span className="lb">{m.name}</span>
              </span>
            ))}
            {shop.machines.length > BANNER_MACHINES ? (
              <span className="plus">+{shop.machines.length - BANNER_MACHINES}</span>
            ) : null}
          </span>
        ) : null}
      </div>
      <div className="bt6-head">
        <StoreFace name={shop.name} storeType={face.storeType} city={city} size="lg" />
        <div className="min-w-0">
          <h3>{shop.name}</h3>
          <p>
            {city ? (
              <span className="cityc">
                <i aria-hidden="true" />
                {city}
              </span>
            ) : null}
            {city ? " · " : null}
            {plural(shop.machines.length, "automat", "automater")}
          </p>
        </div>
      </div>
      <dl className="bt6-num">
        <div>
          <dt>Vår vinst {days}</dt>
          <dd className={shop.profitOre > 0 ? "up" : undefined}>{kr(shop.profitOre)}</dd>
        </div>
        <div>
          <dt>Sålda pack</dt>
          <dd>{formatInt(sales?.sold ?? 0)}</dd>
        </div>
        <div>
          <dt>Andel {monthShortCap(month.month).toLocaleLowerCase("sv-SE")}</dt>
          <dd>{kr(shop.earnedMonthOre)}</dd>
        </div>
      </dl>
      {top.length > 0 ? (
        <div className="bt6-top">
          <div className="k">
            <b>Mest sålda här · {days}</b>
            <span>
              {formatInt(topSum)} av {formatInt(sales?.sold ?? 0)} pack
            </span>
          </div>
          <ol>
            {top.map((t, i) => (
              <li key={t.title} style={{ "--i": i } as CSSProperties}>
                <PackImage title={t.title} size="xs" className="pk" />
                <span className="t">{t.title}</span>
                <span className="bar" aria-hidden="true">
                  <i style={{ "--w": t.count / maxTop } as CSSProperties} />
                </span>
                <span className="n tnum">{formatInt(t.count)}</span>
              </li>
            ))}
          </ol>
        </div>
      ) : null}
      {pay ? (
        <div className="bt6-pay">
          <div>
            <span className="lab">Att betala · {monthName(pay.month)}</span>
            <span className="amt tnum">{krExact(pay.leftOre)}</span>
            <span className={pay.due < today ? "due dn" : "due"}>
              {pay.due < today
                ? `Försenad sedan ${dayMonth(pay.due)}`
                : `Senast ${dayMonth(pay.due)}`}
            </span>
          </div>
          {canEdit ? (
            <PaySheet
              item={pay}
              today={today}
              trigger={
                <Button variant="act" size="lg">
                  Betala
                </Button>
              }
            />
          ) : null}
        </div>
      ) : null}
      <dl className="bt6-facts">
        <div>
          <dt>Kontrakt</dt>
          <dd>
            {contract ?? "–"}
            {shop.contract === "signed" && shop.agreement?.validTo ? (
              <b> t.o.m. {dayMonthShort(shop.agreement.validTo)}</b>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>Avtal</dt>
          <dd>{shop.agreement?.terms ?? "Inget avtal (0 %)"}</dd>
        </div>
        <div>
          <dt>Strömmen</dt>
          <dd>{powerText(shop.power)}</dd>
        </div>
        <div>
          <dt>Senast påfylld</dt>
          <dd>{lastRefill ? refillText(lastRefill, today) : "–"}</dd>
        </div>
      </dl>
      <details className="bt6-more">
        <summary>
          Automater, andel per månad, ström och kontakt
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path
              d="m6 9 6 6 6-6"
              stroke="currentColor"
              strokeWidth="2.2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </summary>
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
                    {m.packs.slice(0, MINI_PACKS).map((p, i) => (
                      <span
                        key={`${p.name}-${i}`}
                        className={p.empty ? "ps e" : "ps"}
                        title={p.name}
                      >
                        <PackImage title={p.name} size="xs" />
                      </span>
                    ))}
                    {m.packs.length > MINI_PACKS ? (
                      <span className="more">+{m.packs.length - MINI_PACKS}</span>
                    ) : null}
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
          <h4>Avtal och kontakt</h4>
          <dl className="g4-dl">
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
      </details>
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
