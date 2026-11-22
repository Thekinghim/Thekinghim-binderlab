/**
 * Pengars kort (G4), serverkomponenter. Varje kort läser sin laddare (src/server/data/v2/
 * analytics) och strömmar för sig (Suspense i sidan). Talen formateras här; inget räknas.
 */

import Link from "next/link";
import type { CSSProperties } from "react";

import { DeltaBadge } from "@/components/v2/badge";
import { Button } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { PackImage } from "@/components/v2/pack-image";
import { RollingNumber } from "@/components/v2/rolling-number";
import { Sparkline } from "@/components/v2/sparkline";
import { periodQuery, type SearchParamsInput } from "@/components/shell/period-state";
import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";
import { loadMoneyGoal, loadMoneyPriceAdvice } from "@/server/data/v2/analytics/goal";
import { loadMoneyGeo } from "@/server/data/v2/analytics/geo";
import { loadMoneyMonths } from "@/server/data/v2/analytics/months12";
import { axisKr, chartScale, goalShortOre } from "@/server/data/v2/analytics/money-model";
import { loadMoneyResult, loadMoneyWaterfall } from "@/server/data/v2/analytics/result";
import { loadMoneyPay } from "@/server/data/v2/analytics/shops";
import { loadMoneyTop } from "@/server/data/v2/analytics/top";
import { loadMoneyWorst } from "@/server/data/v2/analytics/worst";

import { PaySheet } from "../../butiker/_components/v2/pay-sheet";
import { CityList } from "./city-list";
import { kr, krExact, dayMonth, dayMonthShort, monthName, pct, plural, signedPct } from "./fmt";
import { MonthsTable } from "./months-table";

const idx = (i: number) => ({ "--i": i }) as CSSProperties;

/* ------------------------------------------------------------------ */

export async function ResultCard({ sp }: { sp: SearchParamsInput }) {
  const r = await loadMoneyResult(sp);
  if (!r) return null;
  const scale = chartScale(
    Math.max(0, ...r.bars.map((b) => Math.max(b.profitOre, b.paceOre ?? 0))),
  );
  const max = scale.topOre;
  const unitName =
    r.unit === "hour"
      ? "timme"
      : r.unit === "week"
        ? "vecka"
        : r.unit === "month"
          ? "månad"
          : "dag";
  // Många staplar (en månad per dag, ett halvår per vecka): tätare, utan belopp över
  // staplarna (de står i staplarnas text) och var n:e etikett.
  const dense = r.bars.length > 10;
  const step = r.labelStep;
  // Fler än 5 staplar: beloppen kort, som axeln ("117k", "4 572"), så att de inte krockar.
  const amt = (ore: number) =>
    r.bars.length <= 5
      ? kr(ore)
      : Math.abs(ore) >= 1_000_000
        ? `${formatInt(Math.round(ore / 100_000))}k`
        : formatInt(Math.round(ore / 100));
  return (
    <Card
      title={`Resultat · ${r.periodLabel}`}
      actions={
        <a
          className="lk"
          href={`/pengar/export${periodQuery(sp) || "?period=30d"}`}
          download
          title="Perioden per titel och automat som CSV"
        >
          CSV <span aria-hidden="true">↓</span>
        </a>
      }
    >
      <div className="g4-res">
        <div className="l">
          <span className="lab">
            {r.profitLabel} · {plural(r.periodDays, "dag", "dagar")}
          </span>
          <div className="g4-big" data-testid="pengar-vinst">
            <span style={{ color: r.profitOre < 0 ? "var(--v2-crit-text)" : undefined }}>
              <RollingNumber value={r.profitOre} unit="kr" />
            </span>
          </div>
          {r.deltaBp !== null && r.deltaOre !== null ? (
            <div className="g4-delta">
              <DeltaBadge bp={r.deltaBp} />
              <span>
                {r.deltaOre >= 0 ? "+" : "−"}
                {kr(Math.abs(r.deltaOre))} {r.compareText}
              </span>
            </div>
          ) : null}
          <div className="g4-kpis">
            <div>
              <small>Intäkt</small>
              <b>{kr(r.revenueOre)}</b>
            </div>
            <div>
              <small>Marginal</small>
              <b>{r.marginBp !== null ? pct(r.marginBp) : "–"}</b>
            </div>
            <div>
              <small>Vinst per dag</small>
              <b>{r.profitPerDayOre !== null ? kr(r.profitPerDayOre) : "–"}</b>
            </div>
          </div>
        </div>
        <div className="r">
          {r.unit !== null && r.bars.length > 0 ? (
            <>
              <div className="g4-chart-hd">
                <b>{r.unit === "hour" ? "Intäkt per timme" : `Vinst per ${unitName}`}</b>
                {r.best ? (
                  <span>
                    Bästa {unitName}: {r.best.label}
                  </span>
                ) : null}
              </div>
              <div className="g4-wc">
                <div
                  className={cn("g4-bars", dense && "dense")}
                  role="list"
                  aria-label={r.unit === "hour" ? "Intäkt per timme" : `Vinst per ${unitName}`}
                >
                  {scale.ticks.map((t) => (
                    <span
                      key={t}
                      className={t === 0 ? "g4-gl z" : "g4-gl"}
                      style={{ bottom: `${(t / max) * 100}%` }}
                      aria-hidden="true"
                    >
                      <i>{axisKr(t)}</i>
                    </span>
                  ))}
                  {r.bars.map((b, i) => {
                    const h = Math.max(0, b.profitOre) / max;
                    const pace =
                      b.partial && b.paceOre !== null ? Math.max(0, b.paceOre) / max : null;
                    const text = [
                      `${r.unit === "week" ? `Vecka ${b.label.replace(/^v\. /, "")}` : r.unit === "hour" ? `Kl. ${b.label}` : b.label}${b.partialText ? ` (${b.partialText})` : ""}: ${r.unit === "hour" ? "intäkt" : "vinst"} ${kr(b.profitOre)}`,
                      b.paceOre !== null ? `takt ${kr(b.paceOre)} för hela veckan` : null,
                    ]
                      .filter(Boolean)
                      .join(", ");
                    return (
                      <div
                        key={b.key}
                        role="listitem"
                        tabIndex={0}
                        className={cn(
                          "wk",
                          b.partial && "now",
                          !b.partial && b.partialText && "part",
                        )}
                        style={idx(i)}
                        title={text}
                        aria-label={text}
                      >
                        {pace !== null ? (
                          <span
                            className="pace"
                            style={{ ...idx(i), height: `${pace * 100}%`, bottom: 0 }}
                            aria-hidden="true"
                          />
                        ) : null}
                        <span className="bar" style={{ ...idx(i), height: `${h * 100}%` }} />
                        <span
                          className="amt"
                          aria-hidden="true"
                          style={{
                            ...idx(i),
                            bottom: `calc(${Math.max(h, pace ?? 0) * 100}% + 4px)`,
                          }}
                        >
                          {amt(b.profitOre)}
                        </span>
                      </div>
                    );
                  })}
                </div>
                <div className={cn("g4-wls", dense && "dense")} aria-hidden="true">
                  {r.bars.map((b, i) => (
                    <span key={b.key}>
                      {i % step === 0 ? <AxisLabel label={b.label} /> : ""}
                      {b.partialText ? <small>{b.partialText}</small> : null}
                      {b.paceOre !== null ? (
                        <small className="tk">takt {kr(b.paceOre).replace(/\s?kr$/, "")}</small>
                      ) : null}
                    </span>
                  ))}
                </div>
              </div>
            </>
          ) : (
            <div className="g4-chart-hd">
              <b>{formatInt(r.orders)} sålda pack</b>
              <span>{r.periodLabel}</span>
            </div>
          )}
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

export async function WaterfallCard({ sp, days }: { sp: SearchParamsInput; days: string }) {
  const w = await loadMoneyWaterfall(sp);
  if (!w) return null;
  let i = 0;
  return (
    <Card
      title={`Från intäkt till vinst · ${days}`}
      link={{ href: "/lonsamhet", label: "Alla siffror" }}
    >
      <div className="g4-wf">
        {w.rows.map((row) => {
          const cls =
            row.kind === "result"
              ? `g4-wrow sum${row.valueOre < 0 ? " neg" : ""}`
              : row.kind === "base"
                ? "g4-wrow base"
                : row.kind === "cost"
                  ? "g4-wrow c"
                  : "g4-wrow";
          const bar =
            row.kind === "revenue"
              ? "rev"
              : row.kind === "base"
                ? "base"
                : row.kind === "result"
                  ? "win"
                  : "";
          const sign = row.valueOre < 0 ? "−" : "";
          return (
            <div key={row.key} className={cls} data-waterfall={row.key}>
              <div className="wl">
                <b>{row.label}</b>
                <small>{row.sub}</small>
              </div>
              <div className="g4-wtrack" aria-hidden="true">
                <i
                  className={bar}
                  style={{
                    ...idx(i++),
                    left: `${row.from * 100}%`,
                    width: `max(${(row.to - row.from) * 100}%, ${row.to > row.from ? "4px" : "0px"})`,
                  }}
                />
              </div>
              <div className="wa">
                {sign}
                {kr(Math.abs(row.valueOre))}
                {row.shareBp !== null ? <small>{pct(row.shareBp)}</small> : null}
              </div>
              <div className="wp">{row.shareBp !== null ? pct(row.shareBp) : ""}</div>
            </div>
          );
        })}
      </div>
      {w.unpricedRevenueOre > 0 ? (
        <div className="g4-foot">
          {kr(w.unpricedRevenueOre)} i intäkt saknar inköpspris och ingår inte.{" "}
          <Link href="/inkopspriser" className="underline underline-offset-4">
            Lägg in priset
          </Link>
        </div>
      ) : null}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

export async function CityCard({ sp, days }: { sp: SearchParamsInput; days: string }) {
  const g = await loadMoneyGeo(sp);
  if (!g || g.cities.length === 0) return null;
  return <CityList cities={g.cities} days={days} />;
}

/* ------------------------------------------------------------------ */

export async function WorstCard() {
  const w = await loadMoneyWorst();
  if (!w) return null;
  return (
    <Card
      title="Underpresterar · vinst per dag, 30 d"
      actions={
        w.medianProfitPerDayOre !== null ? (
          <span className="lk">Median {kr(w.medianProfitPerDayOre)}/dag</span>
        ) : undefined
      }
      className="g4-worst"
    >
      {w.rows.length === 0 ? (
        <div className="g4-bempty">Ingen automat tjänar under hälften av medianen. Bra.</div>
      ) : (
        w.rows.slice(0, 4).map((m) => {
          const reason =
            m.emptySlots > 0
              ? plural(m.emptySlots, "fack tomt", "fack tomma")
              : m.power
                ? `Strömmen av ${m.power.off}–${m.power.on}`
                : null;
          return (
            <div key={m.machineId} className="wr">
              <div className="min-w-0">
                <b>
                  {m.storeName ?? m.name} <span className="id">{m.code}</span>
                </b>
                <small className={m.emptySlots > 0 ? "o" : undefined}>
                  {[m.city, reason].filter(Boolean).join(" · ") || "Säljer för lite"}
                </small>
              </div>
              <div className="wv">
                {kr(m.profitPerDayOre)}
                {m.vsMedianBp !== null ? (
                  <small className="o">{signedPct(m.vsMedianBp)} mot median</small>
                ) : null}
              </div>
              <Link className="v2-btn" href={`/automater?valj=${encodeURIComponent(m.code)}`}>
                {m.emptySlots > 0 ? "Fyll på" : "Visa automaten"}
              </Link>
            </div>
          );
        })
      )}
      <Link className="g4-more" href="/automater">
        Alla automater och rangordningen <span aria-hidden="true">→</span>
      </Link>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

export async function PayCard() {
  const pay = await loadMoneyPay();
  if (!pay) return null;
  return (
    <Card
      title="Att betala"
      count={pay.items.length > 0 ? pay.items.length : null}
      link={{ href: "/butiker", label: "Butiker" }}
      className="g4-pay"
    >
      {pay.items.length === 0 ? (
        <div className="empty">Inget att betala till butikerna just nu.</div>
      ) : (
        <>
          {pay.items.slice(0, 4).map((i, n) => (
            <div key={i.id} className={n === 0 ? "it hot" : "it"} data-pay-item>
              <div className="body">
                <div className="t">Betala {i.storeName}.</div>
                <div className="d">
                  <b>{krExact(i.leftOre)}</b> ·{" "}
                  <span className={i.late ? "dn" : undefined}>
                    {i.late
                      ? `försenad sedan ${dayMonthShort(i.due)}`
                      : `senast ${dayMonth(i.due)}`}
                  </span>
                </div>
                {n === 0 ? <div className="d2">Butikens andel för {monthName(i.month)}</div> : null}
              </div>
              {pay.canEdit ? (
                <div className="go">
                  <PaySheet
                    item={i}
                    today={pay.today}
                    trigger={
                      <Button variant={n === 0 ? "act" : "default"} size="lg">
                        Betala
                      </Button>
                    }
                  />
                </div>
              ) : null}
            </div>
          ))}
          <div className="psum">
            <span>{plural(pay.stores, "butik", "butiker")}</span>
            <b>{kr(pay.totalOre)} totalt</b>
          </div>
        </>
      )}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

export async function GoalCard() {
  const g = await loadMoneyGoal();
  if (!g) return null;
  const fmt = (v: number) => (g.unit === "ore" ? kr(v) : formatInt(v));
  const short = goalShortOre(g);
  const reached = g.target > 0 ? Math.round((g.actual * 100) / g.target) : 0;
  const what = g.metric === "profit" ? "Vinst" : "Intäkt";
  return (
    <Card title={`Mål i ${g.monthName}`} link={{ href: "/expansion", label: "Mål" }}>
      <div className="g4-goal">
        <span className="lab">{what}</span>
        <div className="n">
          {fmt(g.actual)} <span>av {fmt(g.target)}</span>
        </div>
        <div className="g4-gbar" aria-hidden="true">
          {g.forecastBp !== null ? (
            <i className="fc" style={{ width: `${g.forecastBp / 100}%` }} />
          ) : null}
          <i className="have" style={{ width: `${g.barBp / 100}%` }} />
          {g.forecastBp !== null ? (
            <>
              <i className="mk" style={{ left: `${g.forecastBp / 100}%` }} />
              <span
                className="mkl"
                style={{
                  left: `${Math.max(g.forecastBp / 100, 35)}%`,
                }}
              >
                Prognos <b>{fmt(g.forecast)}</b>
              </span>
            </>
          ) : null}
        </div>
        <div className="g4-gleg">
          <span>
            <b>
              {formatInt(reached)}
              {NBSP}%
            </b>{" "}
            nått
          </span>
          <span>{plural(g.daysLeft, "dag kvar", "dagar kvar")}</span>
        </div>
        <div className="g4-gtx">
          {short > 0 ? (
            <>
              Med takten nu saknas <b>{fmt(short)}</b> till målet.
            </>
          ) : (
            <>Med takten nu når ni målet.</>
          )}
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

export async function PriceCard() {
  const a = await loadMoneyPriceAdvice();
  if (!a) return null;
  const whole = (ore: number) => krExact(ore);
  return (
    <Card
      title="Prisråd"
      link={{ href: "/lonsamhet#prisrad", label: a.more > 0 ? `Alla ${a.more + 1}` : "Mer" }}
    >
      <div className="g4-price">
        <span className="lab">Under målet {pct(a.targetBp, 0)} marginal</span>
        <div className="t">
          {a.suggestedPriceOre !== null
            ? `Höj ${a.name} till ${whole(a.suggestedPriceOre)}.`
            : `${a.name} når inte målet.`}
        </div>
        <div className="d">
          Säljs för {whole(a.salePriceOre)}, inköp {whole(a.unitCostOre)}.
        </div>
        <div className="g4-pcmp">
          <div>
            <small>Vinst per pack nu</small>
            <b className={a.profitNowOre <= 0 ? "dn" : undefined}>{whole(a.profitNowOre)}</b>
          </div>
          <div>
            <small>
              {a.suggestedPriceOre !== null ? `Med ${whole(a.suggestedPriceOre)}` : "Med nytt pris"}
            </small>
            <b>{a.profitSuggestedOre !== null ? whole(a.profitSuggestedOre) : "–"}</b>
          </div>
        </div>
        <div className="row">
          <span>Efter kortavgift, före butikens andel. Priset ändras i Awish.</span>
        </div>
      </div>
    </Card>
  );
}

/* ------------------------------------------------------------------ */

export async function TopCard({ sp, days }: { sp: SearchParamsInput; days: string }) {
  const top = await loadMoneyTop(sp);
  if (!top || top.length === 0) return null;
  return (
    <Card
      title={`Bästsäljare · vinst ${days}`}
      link={{ href: "/lonsamhet?vy=title", label: "Alla titlar" }}
      className="g4-best"
    >
      {top.map((t, i) => (
        <div key={t.titleId} className="brow">
          <span className="rk">{i + 1}.</span>
          <div className="tn">
            <PackImage title={t.name} size="m" />
            <div className="tx">
              <b>{t.name}</b>
              <small>
                {formatInt(t.orders)} pack · intäkt {kr(t.revenueOre)}
              </small>
            </div>
          </div>
          <span className="kr">{kr(t.profitOre)}</span>
          <div className="share">
            <span className="track" aria-hidden="true">
              <i style={{ ...idx(i), transform: `scaleX(${(t.shareBp ?? 0) / 10_000})` }} />
            </span>
            <span>{t.shareBp !== null ? pct(t.shareBp) : ""}</span>
          </div>
          <div className="ch">
            {t.weekly.length > 1 ? (
              <Sparkline values={t.weekly} height={16} dot={false} className="spark" />
            ) : null}
            {t.deltaBp !== null ? (
              <span className={t.deltaBp >= 0 ? "up" : "dn"}>{signedPct(t.deltaBp)}</span>
            ) : null}
          </div>
        </div>
      ))}
    </Card>
  );
}

/* ------------------------------------------------------------------ */

export async function MonthsCard() {
  const t = await loadMoneyMonths();
  if (!t || t.rows.length === 0) return null;
  return <MonthsTable table={t} />;
}

export function EmptyMoney() {
  return (
    <Card title="Pengar">
      <Empty title="Ingen försäljning ännu">
        När automaterna har sålt visas resultat, vinst per automat och det som ska betalas här.
      </Empty>
    </Card>
  );
}

/** Stapelns etikett; ett år ("jan ’26") står på en egen rad under månaden. */
function AxisLabel({ label }: { label: string }) {
  const at = label.indexOf(" ’");
  if (at < 0) return <>{label}</>;
  return (
    <>
      {label.slice(0, at)}
      <small>{label.slice(at + 1)}</small>
    </>
  );
}
