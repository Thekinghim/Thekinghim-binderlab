import Link from "next/link";

import { cn } from "@/lib/cn";
import { Fragment, type CSSProperties, type ReactNode } from "react";

import { blockText, peakText, WEEKDAYS_SHORT, WHEN_BLOCKS } from "@/analytics/home-v2";
import { AxisTick } from "@/components/v2/axis-tick";
import { Badge, DeltaBadge } from "@/components/v2/badge";
import { ButtonLink } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { PackImage } from "@/components/v2/pack-image";
import { formatInt, NBSP } from "@/lib/format";
import type { SearchParamsInput } from "@/components/shell/period-state";
import { loadOps } from "@/server/data/v2/analytics/ops";
import { loadSoldoutShrink, SHRINK_DAYS } from "@/server/data/v2/analytics/soldout-shrink";
import { loadWhen } from "@/server/data/v2/analytics/when";

import {
  loadGeoCard,
  loadResultCard,
  loadShopsCard,
  loadStockCard,
  loadTopCard,
  loadWorstCard,
} from "./cards-data";
import { GeoBody } from "./geo-body";

const kr = (ore: number) => `${formatInt(Math.round(ore / 100))}${NBSP}kr`;
const signedKr = (ore: number) => `${ore > 0 ? "+" : ore < 0 ? "−" : ""}${kr(Math.abs(ore))}`;
const pct = (bp: number) => `${Math.round(bp / 100)}${NBSP}%`;
const dec1 = (tenths: number) =>
  (tenths / 10).toLocaleString("sv-SE", { minimumFractionDigits: 0, maximumFractionDigits: 1 });
const grow = (i: number) => ({ "--i": i }) as CSSProperties;

function XCard({
  title,
  link,
  className,
  children,
  actions,
}: {
  title: ReactNode;
  link?: { href: string; label: string };
  className?: string;
  children: ReactNode;
  actions?: ReactNode;
}) {
  // id = "hem-" + kortets klass utan "x-" (hem-res, hem-worst …), för länkar och e2e.
  const id = className ? `hem-${className.split(" ")[0]!.replace(/^x-/, "")}` : undefined;
  return (
    <Card id={id} className={`x-c ${className ?? ""}`} title={title} link={link} actions={actions}>
      <div className="x-b">{children}</div>
    </Card>
  );
}

/* 1. Resultat ------------------------------------------------------ */

export async function ResultCard({ sp }: { sp: SearchParamsInput }) {
  const r = await loadResultCard(sp);
  if (!r) return null;
  const max = Math.max(1, ...r.bars.map((b) => Math.max(b.value, b.previous ?? 0)));
  const hours = r.unit === "timme";
  // Många staplar (en månad per dag): var n:e etikett, så att datumen inte krockar.
  const step = hours ? 3 : Math.max(1, Math.ceil(r.bars.length / 8));
  const unitName = { vecka: "vecka", dag: "dag", timme: "timme", månad: "månad" }[r.unit];
  // Stödlinjer i hela kronor: 0, halva och den största "jämna" summan under toppen.
  const maxKr = max / 100;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.max(1, maxKr))));
  const topKr = Math.max(mag, Math.floor(maxKr / mag) * mag);
  const grid = [0, topKr / 2, topKr];
  // Inga köp i perioden (och ingen jämförelse att rita): en rad i stället för ett tomt diagram
  // med en ensam nolla.
  const sold = r.bars.some((b) => b.value > 0);
  const empty = !sold && !r.bars.some((b) => (b.previous ?? 0) > 0);
  const marginShown = r.marginBp !== null && (r.revenueOre ?? 0) > 0;
  return (
    <XCard
      title={`Resultat · ${r.periodText}`}
      link={{ href: "/pengar", label: "Pengar" }}
      className="x-res"
    >
      <div className="x-rt">
        <div className="x-rm">
          <span className="x-l">{r.pace ? "Vinst i dag" : "Vinst"}</span>
          <span className="x-big">{r.profitOre !== null ? kr(r.profitOre) : "–"}</span>
          {r.profitDeltaBp !== null ? (
            <span className="x-cmp">
              <DeltaBadge bp={r.profitDeltaBp} />
              {r.profitDeltaOre !== null ? `${signedKr(r.profitDeltaOre)} ${r.compareText}` : null}
            </span>
          ) : null}
        </div>
        <dl className="x-rk">
          <div>
            <dt>Intäkt</dt>
            <dd>{r.revenueOre !== null ? kr(r.revenueOre) : "–"}</dd>
          </div>
          <div>
            <dt>Köp</dt>
            <dd>{r.orders !== null ? formatInt(r.orders) : "–"}</dd>
          </div>
          <div>
            <dt>Marginal</dt>
            <dd>
              {marginShown && r.marginBp !== null
                ? `${(r.marginBp / 100).toLocaleString("sv-SE", { maximumFractionDigits: 1 })}${NBSP}%`
                : "–"}
            </dd>
          </div>
          {r.best ? (
            <div>
              <dt>Bästa {unitName}</dt>
              <dd>
                {r.best.label} · {kr(r.best.profitOre)}
              </dd>
            </div>
          ) : null}
        </dl>
      </div>
      {empty ? (
        <p className="x-sum">{r.pace ? "Inga köp hittills i dag." : "Inga köp i perioden."}</p>
      ) : null}
      {!sold && !empty && r.pace ? (
        <p className="x-sum">Inga köp hittills i dag. Konturerna visar en vanlig dag.</p>
      ) : null}
      {empty ? null : (
        <>
          <div className="x-leg" aria-hidden="true">
            {hours ? null : (
              <span>
                <i className="lp" />
                Vinst
              </span>
            )}
            <span>
              <i className="lr" />
              Intäkt
            </span>
            {hours && !r.pace ? null : (
              <span>
                <i className="lgh" />
                {r.pace ? "Vanlig dag samma timme" : "Förra perioden"}
                {r.previousPerBarOre !== null
                  ? `, vinst per ${unitName} ${kr(r.previousPerBarOre)}`
                  : ""}
              </span>
            )}
          </div>
          <div className={cn("x-ch", hours && "hrs")}>
            <div className="x-plot" role="img" aria-label={`Intäkt och vinst per ${unitName}.`}>
              {grid.map((g, gi) => (
                <span
                  key={gi}
                  className={cn("x-gl", g === 0 && "z")}
                  style={{ bottom: `${((g * 100) / max) * 100}%` }}
                >
                  <i>{g >= 1000 ? `${formatInt(g / 1000)}k` : formatInt(g)}</i>
                </span>
              ))}
              {r.bars.map((b, i) => (
                <div
                  key={b.key}
                  className={cn("x-col", b.partial && "part")}
                  title={`${b.label}: intäkt ${kr(b.value)}${b.part !== undefined ? `, vinst ${kr(b.part)}` : ""}${b.previous ? `, förra ${kr(b.previous)}` : ""}`}
                >
                  {b.previous ? (
                    <span className="x-gh" style={{ height: `${(b.previous / max) * 100}%` }} />
                  ) : null}
                  <span
                    className="x-rv"
                    style={{ height: `${(b.value / max) * 100}%`, ...grow(i) }}
                  />
                  {b.part !== undefined ? (
                    <span
                      className="x-pf"
                      style={{ height: `${(Math.max(0, b.part) / max) * 100}%`, ...grow(i) }}
                    />
                  ) : null}
                  {r.best && b.label === r.best.label && !hours ? (
                    <span className="x-anc" style={{ bottom: `${(b.value / max) * 100}%` }}>
                      <span className="x-bl">Bäst</span>
                    </span>
                  ) : null}
                </div>
              ))}
            </div>
            <div className="x-xl v2-axr" aria-hidden="true">
              {r.bars.map((b, i) => (
                <span key={b.key}>
                  <AxisTick index={i} count={r.bars.length} step={step}>
                    {b.label}
                  </AxisTick>
                  {b.partial && !hours ? (
                    <small>{i === r.bars.length - 1 ? "pågår" : "del"}</small>
                  ) : null}
                </span>
              ))}
            </div>
          </div>
        </>
      )}
    </XCard>
  );
}

/* 2. När säljer vi mest -------------------------------------------- */

export async function WhenCardView({ sp }: { sp: SearchParamsInput }) {
  const w = await loadWhen(sp);
  if (!w) return null;
  const g = w.grid;
  const span = w.pattern ? "mönster 30 dagar" : `${formatInt(w.days)} dagar`;
  return (
    <XCard title={`När säljer vi mest · ${span}`} className="x-when">
      {g.total === 0 ? (
        <p className="x-sum">Inga köp med klockslag i perioden.</p>
      ) : (
        <>
          <p className="x-sum">
            {g.peak ? (
              <>
                Mest: <b>{peakText(g.peak)}</b> · {dec1(g.peak.perWeekTenths)} pack i snitt per
                vecka.
              </>
            ) : null}
          </p>
          <div
            className="x-hm"
            role="img"
            aria-label={`Sålda pack per veckodag och tid.${g.peak ? ` Mest ${peakText(g.peak)}.` : ""}`}
          >
            {g.cells.map((row, d) => (
              <Fragment key={d}>
                <span className="x-hl">{WEEKDAYS_SHORT[d]}</span>
                {row.map((c, b) => (
                  <span
                    key={b}
                    className={`x-hc l${g.levels[d]?.[b] ?? 0}`}
                    title={`${WEEKDAYS_SHORT[d]} ${blockText(b)}: ${formatInt(c)} pack`}
                  />
                ))}
                <span className="x-hs">
                  {formatInt(Math.round((g.perWeekTenths[d] ?? 0) / 10))}
                </span>
              </Fragment>
            ))}
            <span />
            {Array.from({ length: WHEN_BLOCKS }, (_, b) => (
              <span key={b} className="x-hx">
                {b % 2 ? "" : String(b * 2).padStart(2, "0")}
              </span>
            ))}
            <span className="x-hx r">pack/v</span>
          </div>
          <div className="x-ramp" aria-hidden="true">
            <span>Färre</span>
            {[1, 2, 3, 4, 5].map((l) => (
              <i key={l} className={`x-hc l${l}`} style={{ height: 8 }} />
            ))}
            <span>Fler pack</span>
          </div>
        </>
      )}
    </XCard>
  );
}

/* 3. Vinst per stad / automat -------------------------------------- */

export async function GeoCardView({ sp }: { sp: SearchParamsInput }) {
  const g = await loadGeoCard(sp);
  if (!g || g.machines.length === 0) return null;
  return <GeoBody data={g} />;
}

/* 4. Mest sålda ---------------------------------------------------- */

export async function TopCardView({ sp }: { sp: SearchParamsInput }) {
  const rows = await loadTopCard(sp);
  if (!rows || rows.length === 0) return null;
  return (
    <XCard
      title="Mest sålda"
      link={{ href: "/lonsamhet?vy=titel", label: "Alla titlar" }}
      className="x-top"
    >
      <div className="x-tr x-th">
        <span>Titel · intäkt</span>
        <span>Pack</span>
        <span>Vinst/pack</span>
        <span>Trend</span>
      </div>
      {rows.map((t) => (
        <div className="x-tr" key={t.titleId}>
          <span className="x-tn">
            <span className="x-pkb">
              <PackImage title={t.name} size="s" />
            </span>
            <span>
              <b>{t.name}</b>
              <small>{kr(t.revenueOre)}</small>
            </span>
          </span>
          <span>{formatInt(t.orders)}</span>
          <span
            className={t.profitPerPackOre !== null && t.profitPerPackOre <= 0 ? "x-neg" : undefined}
          >
            {t.profitPerPackOre !== null ? kr(t.profitPerPackOre) : "–"}
          </span>
          <span className={cn("x-trd", t.trendBp !== null && t.trendBp < 0 && "dn")}>
            {/* −100 % = inget sålt de senaste 7 dagarna: ett streck, inte ett larm. */}
            {t.trendBp === null || t.trendBp <= -10_000
              ? "–"
              : `${t.trendBp > 0 ? "+" : "−"}${pct(Math.abs(t.trendBp))}`}
          </span>
        </div>
      ))}
      <div className="x-ft">
        <span>Trend = sålda per dag senaste 7 dagarna mot hela perioden.</span>
      </div>
    </XCard>
  );
}

/* 5. Sämst presterande --------------------------------------------- */

export async function WorstCardView() {
  const w = await loadWorstCard();
  if (!w) return null;
  return (
    <XCard
      title="Sämst presterande · senaste 30 dagarna"
      link={{ href: "/automater?f=under", label: "Alla" }}
      className="x-worst"
    >
      <p className="x-sum">
        {w.medianOre !== null ? (
          <>
            En vanlig automat tjänar <b>{kr(w.medianOre)}</b> per dag.{" "}
          </>
        ) : null}
        {w.rows.length === 0
          ? "Ingen automat tjänar under hälften av det."
          : `${formatInt(w.rows.length)} ${w.rows.length === 1 ? "tjänar" : "tjänar"} hälften eller mindre.`}
      </p>
      {w.rows.map((m) => {
        const share =
          w.medianOre && w.medianOre > 0
            ? Math.max(0, Math.min(1, m.profitPerDayOre / (w.medianOre * 1.5)))
            : 0;
        const medianAt = w.medianOre && w.medianOre > 0 ? 1 / 1.5 : null;
        return (
          <div className="x-wr" key={m.machineId} data-hem-worst={m.code}>
            <span className="x-wn">
              <b>
                {m.name} <span className="wid text-v2-mute">{m.code}</span>
              </b>
              <small className={m.action.label === "Fyll på" ? "o" : undefined}>
                {[m.storeName, m.hint].filter(Boolean).join(" · ")}
              </small>
            </span>
            <span className="x-wv">
              <b>{kr(m.profitPerDayOre)}</b>
              {m.vsMedianBp !== null ? (
                <small className="o">{`${m.vsMedianBp > 0 ? "+" : "−"}${pct(Math.abs(m.vsMedianBp))} mot vanlig`}</small>
              ) : null}
              <span className="x-bul" aria-hidden="true">
                <i style={{ width: `${share * 100}%` }} />
                {medianAt !== null ? <em style={{ left: `${medianAt * 100}%` }} /> : null}
              </span>
            </span>
            <ButtonLink prefetch={false} size="sm" href={m.action.href}>
              {m.action.label}
            </ButtonLink>
          </div>
        );
      })}
    </XCard>
  );
}

/* 6. Lager --------------------------------------------------------- */

export async function StockCardView() {
  const s = await loadStockCard();
  if (!s) return null;
  const total = Math.max(1, s.home + s.inMachines);
  const homeShare = s.home / total;
  return (
    <XCard title="Lager" link={{ href: "/vart-lager", label: "Vårt lager" }} className="x-stock">
      <div className="x-st3">
        <div>
          <span className="x-l">Hemma</span>
          <b>{formatInt(s.home)}</b>
          <small>pack{s.homeValueOre !== null ? ` · ${kr(s.homeValueOre)}` : ""}</small>
        </div>
        <div>
          <span className="x-l">I automaterna</span>
          <b>{formatInt(s.inMachines)}</b>
          <small>pack{s.machineValueOre !== null ? ` · ${kr(s.machineValueOre)}` : ""}</small>
        </div>
        <div>
          <span className="x-l">Lagervärde</span>
          <b>
            {s.homeValueOre !== null && s.machineValueOre !== null
              ? kr(s.homeValueOre + s.machineValueOre)
              : "–"}
          </b>
          <small>till inköpspris</small>
        </div>
      </div>
      <div className="x-split" aria-hidden="true">
        <i style={{ flex: homeShare }} />
        <i className="o" style={{ flex: 1 - homeShare }} />
      </div>
      <div className="x-legr">
        <span>
          <i />
          Hemma {pct(Math.round(homeShare * 10_000))}
        </span>
        <span>
          <i className="o" />I automaterna {pct(Math.round((1 - homeShare) * 10_000))}
        </span>
      </div>
      <div className="x-sh line">
        <span className="x-l">Räcker under 7 dagar</span>
        <span className="x-shv">
          <b>{formatInt(s.runsOutCount)}</b> titlar
        </span>
      </div>
      {s.runsOut.length === 0 ? (
        <p className="x-sum">Allt räcker minst en vecka.</p>
      ) : (
        s.runsOut.map((t) => (
          <div className="x-lr" key={t.titleId}>
            <span className="x-pkb">
              <PackImage title={t.name} size="s" />
            </span>
            <span className="x-ln">
              <b>{t.name}</b>
              <small>
                {formatInt(t.home)} hemma
                {t.perDayTenths !== null ? ` · ${dec1(t.perDayTenths)}/dag` : ""}
              </small>
            </span>
            <Badge tone={t.home <= 0 ? "critical" : "warning"}>
              {t.home <= 0 ? "Slut hemma" : `${formatInt(t.lastsDays ?? 0)}${NBSP}d`}
            </Badge>
            {t.verb ? (
              <ButtonLink prefetch={false} size="sm" href="/vart-lager">
                {t.verb}
              </ButtonLink>
            ) : null}
          </div>
        ))
      )}
    </XCard>
  );
}

/* 7. Slutsålt och svinn -------------------------------------------- */

export async function LossCardView({ sp }: { sp: SearchParamsInput }) {
  const l = await loadSoldoutShrink(sp);
  if (!l) return null;
  return (
    <XCard
      title="Slutsålt och svinn"
      link={{ href: "/automater?f=behover", label: "Automater" }}
      className="x-loss"
    >
      <div className="x-sh">
        <span className="x-l">Slutsålt kostade · förlorad försäljning</span>
      </div>
      {l.lost ? (
        <>
          <div className="x-st3 two">
            <div>
              <b>{kr(l.lost.revenueOre)}</b>
              <small>i perioden, intäkt</small>
            </div>
            <div>
              <b>{kr(l.lost.perDayOre)}</b>
              <small>per dag i snitt</small>
            </div>
          </div>
          <p className="x-sum">
            {l.lost.ongoing > 0 ? (
              <>
                <b>{formatInt(l.lost.ongoing)}</b>{" "}
                {l.lost.ongoing === 1 ? "titel är slut" : "titlar är slut"} i en automat just
                nu.{" "}
              </>
            ) : null}
            <Link prefetch={false} href={l.lost.href}>
              Underlaget →
            </Link>
          </p>
        </>
      ) : (
        <p className="x-sum">Inget såldes slut i perioden.</p>
      )}
      <div className="x-sh line">
        <span className="x-l">Svinn · {formatInt(SHRINK_DAYS)} dagar</span>
        {l.shrink ? (
          <span className="x-shv">
            <b>{formatInt(l.shrink.missing)} pack</b>
            {l.shrink.valueOre !== null && l.shrink.valueOre > 0
              ? ` · −${kr(l.shrink.valueOre)}`
              : ""}{" "}
            · {formatInt(l.shrink.machines.length)} automater
          </span>
        ) : null}
      </div>
      {!l.shrink ? (
        <p className="x-sum">Svinnkontrollen gick inte att läsa just nu.</p>
      ) : l.shrink.machines.length === 0 ? (
        <p className="x-sum">Inga pack saknas.</p>
      ) : (
        l.shrink.machines.slice(0, 3).map((m) => (
          <Link prefetch={false} className="x-lr" key={m.machineId} href={l.shrink!.href}>
            <span className="x-ln">
              <b>
                {m.name} <span className="wid text-v2-mute">{m.code}</span>
              </b>
              <small>
                {[m.storeName, `${formatInt(m.missing)} pack saknas`].filter(Boolean).join(" · ")}
              </small>
            </span>
            {m.valueOre !== null ? <span className="x-num">−{kr(m.valueOre)}</span> : null}
          </Link>
        ))
      )}
    </XCard>
  );
}

/* 8. Butiker ------------------------------------------------------- */

const dueText = (iso: string) =>
  new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "long", timeZone: "UTC" }).format(
    new Date(`${iso}T12:00:00Z`),
  );

/**
 * `withSplit`: "Vem pengarna är till" står redan på Hem (ägare och admin). Butikernas andel
 * står då bara där, med samma tal som på Pengar; här bara för läsaren.
 */
export async function ShopsCardView({
  sp,
  withSplit = false,
  canEdit = false,
}: {
  sp: SearchParamsInput;
  withSplit?: boolean;
  /** Får skapa avräkningar (ägare och admin): annars bara en länk att titta. */
  canEdit?: boolean;
}) {
  const s = await loadShopsCard(sp);
  if (!s) return null;
  const split = !withSplit && s.split && s.split.totalOre > 0 ? s.split : null;
  // En saknad avräkning förfaller också (den 15:e månaden efter): den äldsta av de två.
  const oldestDue =
    s.oldestDue && s.missing
      ? s.oldestDue < s.missing.due
        ? s.oldestDue
        : s.missing.due
      : (s.oldestDue ?? s.missing?.due ?? null);
  return (
    <XCard title="Butiker" link={{ href: "/butiker", label: "Butiker" }} className="x-shops">
      <div className="x-st3 two">
        <div>
          <span className="x-l">Avräkningar att betala</span>
          <b>{kr(s.unpaidOre)}</b>
          <small>
            {formatInt(s.stores)} {s.stores === 1 ? "butik" : "butiker"}
            {s.missing ? ` · ${formatInt(s.missing.stores)} saknar avräkning` : ""}
          </small>
        </div>
        <div>
          <span className="x-l">Äldsta förfaller</span>
          <b>{oldestDue ? dueText(oldestDue) : "–"}</b>
          <small>
            {oldestDue === s.oldestDue && s.oldestStore
              ? s.oldestStore
              : s.missing
                ? "Avräkning saknas"
                : "Inget obetalt"}
          </small>
        </div>
      </div>
      {s.missing ? (
        <Link className="x-lr" href={s.missing.href} data-testid="hem-missing-settlements">
          <span className="x-ln">
            <b>{s.missing.text}</b>
            <small>{canEdit ? "Skapa dem på Utbetalning" : "Se Utbetalning"}</small>
          </span>
          <span className="x-num">→</span>
        </Link>
      ) : null}
      {s.rows.slice(0, 3).map((r) => (
        <Link
          prefetch={false}
          className="x-lr"
          key={r.storeId}
          href={`/butiker?valj=${encodeURIComponent(r.storeId)}`}
        >
          <span className="x-ln">
            <b>{r.name}</b>
            <small>Senast {dueText(r.due)}</small>
          </span>
          <span className="x-num">{kr(r.leftOre)}</span>
        </Link>
      ))}
      {split ? (
        <>
          <div className="x-sh line">
            <span className="x-l">Butikernas andel</span>
          </div>
          <p className="x-sum">
            <b>{kr(split.storesOre)}</b> ·{" "}
            {pct(Math.round((split.storesOre * 10_000) / split.totalOre))} av vinsten före andelen
          </p>
          <div className="x-split" aria-hidden="true">
            <i className="o" style={{ flex: Math.max(0, split.storesOre) }} />
            <i className="g" style={{ flex: Math.max(0, split.ourOre) }} />
          </div>
          <div className="x-legr sp">
            <span>
              <i className="o" />
              Butikerna
            </span>
            <span>
              <i className="g" />
              Vi {kr(split.ourOre)}
            </span>
          </div>
        </>
      ) : null}
    </XCard>
  );
}

/* 10. Driftstatus -------------------------------------------------- */

export async function OpsCardView({ timeZone }: { timeZone: string }) {
  const o = await loadOps();
  const time = o.syncedAt
    ? new Intl.DateTimeFormat("sv-SE", { hour: "2-digit", minute: "2-digit", timeZone }).format(
        new Date(o.syncedAt),
      )
    : "–";
  return (
    <XCard title="Driftstatus" link={{ href: "/drift", label: "Drift" }} className="x-ops">
      <div className="x-ops4">
        <div>
          <span className="x-l">Online nu</span>
          <b>
            {formatInt(o.online)} av {formatInt(o.total)}
          </b>
          <small>
            {o.offline.length > 0 ? `${formatInt(o.offline.length)} offline` : "Alla svarar"}
          </small>
        </div>
        <div>
          <span className="x-l">Ström av just nu</span>
          <b>{o.powerOff > 0 ? formatInt(o.powerOff) : "Ingen"}</b>
          <small>
            {o.powerWindow ? `enligt butikens tider, ${o.powerWindow}` : "enligt butikernas tider"}
          </small>
        </div>
        <div>
          <span className="x-l">Senaste Awish-synk</span>
          <b>{time}</b>
          <small>
            {o.syncState === "failed" ? "Synken misslyckades" : "Köp kommer var 5:e minut"}
          </small>
        </div>
      </div>
      {o.offline.length > 0 ? (
        <p className="x-sum">
          Offline nu:{" "}
          {o.offline.map((m, i) => (
            <span key={m.id}>
              {i > 0 ? ", " : ""}
              <Link prefetch={false} href={`/automater?valj=${encodeURIComponent(m.code)}`}>
                {m.name}
              </Link>
            </span>
          ))}
          .
        </p>
      ) : null}
    </XCard>
  );
}
