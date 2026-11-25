/**
 * Hems hjältekort (mockarna i "visuellt/02"): ersätter de åtta grå KPI-rutorna som första
 * rad. Tre delar i ett kort: periodens vinst med dagsserien, pallen med periodens tre mest
 * sålda pack och månadens mål som ring. Resten av nyckeltalen står kompakt under. På telefon
 * (≤ 900 px) blir målet ett eget kort under hjälten och nyckeltalen visar fyra åt gången.
 *
 * Bara ekonomiroller (sidan visar inte kortet för påfyllaren och servern ger inga tal).
 */

import Link from "next/link";
import type { CSSProperties } from "react";

import { DeltaBadge, deltaText } from "@/components/v2/badge";
import { ButtonLink } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { PackPodium } from "@/components/v2/pack-visuals";
import { ProgressRing, RingKey } from "@/components/v2/progress-ring";
import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";
import type { SearchParamsInput } from "@/components/shell/period-state";
import type { KpiBandTile } from "@/server/data/v2/analytics/kpi-band";
import { loadContext } from "@/server/data/core";

import { GoalCelebration, HeroIntro, KpiRow } from "./hero-client";
import { loadGoalCelebration, loadHemHero, type HeroGoal, type HeroSpark } from "./hero-data";
import { celebrateKey, sparkGeometry } from "./hero-model";

const krInt = (ore: number) => formatInt(Math.round(ore / 100));
const kr = (ore: number) => `${krInt(ore)}${NBSP}kr`;
const signedKr = (ore: number) => `${ore > 0 ? "+" : ore < 0 ? "−" : ""}${kr(Math.abs(ore))}`;
const order = (i: number) => ({ "--i": i }) as CSSProperties;

/* ------------------------------------------------------------------ */
/* Sparklinje                                                          */
/* ------------------------------------------------------------------ */

function HeroSparkline({ spark }: { spark: HeroSpark }) {
  const g = sparkGeometry(spark.current, spark.previous);
  if (!g) return null;
  return (
    <>
      <svg
        className="hh-spark"
        viewBox="0 0 300 96"
        preserveAspectRatio="none"
        aria-hidden="true"
        focusable="false"
      >
        <defs>
          <linearGradient id="hh-spark-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="var(--v2-profit)" stopOpacity="0.18" />
            <stop offset="1" stopColor="var(--v2-profit)" stopOpacity="0" />
          </linearGradient>
        </defs>
        {g.previous ? <path className="pv" d={g.previous} /> : null}
        <path className="ar" d={g.area} fill="url(#hh-spark-fill)" />
        <path className="ln" d={g.line} />
      </svg>
      <div className="hh-axis" aria-hidden="true">
        {spark.axis.map((a, i) => (
          <span key={i}>{a}</span>
        ))}
      </div>
      <div className="hh-legend" aria-hidden="true">
        <span>
          <i />
          {spark.name}
        </span>
        {g.previous ? (
          <span>
            <i className="p" />
            Förra perioden
          </span>
        ) : null}
      </div>
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Målring                                                             */
/* ------------------------------------------------------------------ */

function goalFmt(goal: HeroGoal) {
  return (v: number) => (goal.unit === "ore" ? kr(v) : formatInt(v));
}

function GoalBody({ goal, phone }: { goal: HeroGoal; phone?: boolean }) {
  const fmt = goalFmt(goal);
  const percent = goal.target > 0 ? Math.round((goal.actual / goal.target) * 100) : null;
  const label = [
    percent !== null
      ? `${percent} procent av målet ${fmt(goal.target)}`
      : `Mål ${fmt(goal.target)}`,
    `hittills ${fmt(goal.actual)}`,
    goal.pace !== null && !goal.reached ? `takten i dag ${fmt(goal.pace)}` : null,
    !goal.reached ? `prognos ${fmt(goal.forecast)}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <>
      <div className="hh-ringwrap">
        <ProgressRing
          value={goal.actual}
          goal={goal.target}
          pace={goal.reached ? null : goal.pace}
          forecast={goal.reached ? null : goal.forecast}
          label={label}
          caption={`av ${fmt(goal.target)}`}
        />
        <ul className="hh-gl">
          <li>
            <RingKey kind="result" />
            <span>
              <strong>{fmt(goal.actual)}</strong>
              <em>hittills</em>
            </span>
          </li>
          {goal.reached ? (
            <li>
              <span className="hh-gk-ok" aria-hidden="true">
                <svg viewBox="0 0 24 24">
                  <path d="M5 12.5l4.5 4.5L19 7.5" />
                </svg>
              </span>
              <span>
                <strong>Målet nått</strong>
                <em>{fmt(goal.actual - goal.target)} över</em>
              </span>
            </li>
          ) : (
            <>
              {goal.pace !== null ? (
                <li>
                  <RingKey kind="pace" />
                  <span>
                    <strong>{fmt(goal.pace)}</strong>
                    <em>takten i dag</em>
                    {goal.behind > 0 ? (
                      <span className="hh-behind">{fmt(goal.behind)} efter</span>
                    ) : null}
                  </span>
                </li>
              ) : null}
              <li>
                <RingKey kind="forecast" />
                <span>
                  <strong>{fmt(goal.forecast)}</strong>
                  <em>prognos {goal.endText}</em>
                </span>
              </li>
            </>
          )}
        </ul>
      </div>
      {goal.requiredPerDay !== null && !goal.reached ? (
        <p className="hh-need">
          Behövs <b>{fmt(goal.requiredPerDay)} per dag</b>{" "}
          {phone
            ? "resten av månaden."
            : `i ${formatInt(goal.daysLeft)} ${goal.daysLeft === 1 ? "dag" : "dagar"} till.`}
        </p>
      ) : null}
    </>
  );
}

function NoGoal({ canEdit }: { canEdit: boolean }) {
  return (
    <div className="hh-nogoal">
      <p>Inget mål för månaden.</p>
      {canEdit ? (
        <ButtonLink size="sm" href="/expansion?vy=mal">
          Sätt ett mål
        </ButtonLink>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Kompakta nyckeltal                                                  */
/* ------------------------------------------------------------------ */

function compactValue(t: KpiBandTile): string {
  // null = går inte att räkna (marginal utan intäkt): ett streck, inte "0,0 %".
  if (t.value === null && t.unit === "bp") return "–";
  const v = t.value ?? 0;
  if (t.unit === "ore") return kr(v);
  if (t.unit === "bp")
    return `${(Math.round(v / 10) / 10).toLocaleString("sv-SE", { minimumFractionDigits: 1 })}${NBSP}%`;
  return formatInt(v);
}

function CompactKpi({ t }: { t: KpiBandTile }) {
  const d = t.deltaBp;
  const rounded = d === null ? 0 : t.deltaUnit === "pe" ? Math.round(d / 10) : Math.round(d / 100);
  const tone = d === null || rounded === 0 || t.neutral ? "eq" : d > 0 ? "up" : "dn";
  // Utan förändring: jämförelsen i ord bara för "Vinst i dag" ("i går 0 kr samma tid").
  const note =
    d === null && t.id === "profit-today" && t.compare
      ? t.compare.replace(/ samma tid$/, "")
      : null;
  // Kompakt: en förändring som avrundas till 0 visas inte (talet står ändå).
  const showDelta = d !== null && rounded !== 0;
  return (
    <Link href={t.href} className="hh-k" title={t.compare ?? undefined}>
      <span className="l">{t.label}</span>
      <span className="v">
        {compactValue(t)}
        {showDelta ? <span className={cn("d", tone)}>{deltaText(d, t.deltaUnit)}</span> : null}
        {note ? <span className="d eq">{note}</span> : null}
      </span>
    </Link>
  );
}

/* ------------------------------------------------------------------ */
/* Kortet                                                              */
/* ------------------------------------------------------------------ */

export async function HemHero({ sp }: { sp: SearchParamsInput }) {
  const [h, ctx] = await Promise.all([loadHemHero(sp), loadContext()]);
  if (!h) return null;
  const goal = h.goal;
  const cele = goal ? await loadGoalCelebration(goal) : null;
  const p = h.profit;
  const profitLabel = p ? (p.label === "Vinst" ? `Vinst · ${h.periodName}` : p.label) : "Vinst";
  const goalTitle = goal ? `Mål i ${goal.monthName}` : null;

  return (
    <HeroIntro className="hh">
      <div className="v2-card hh-card">
        <section className="hh-sec hh-profit" style={order(0)} aria-label={profitLabel}>
          <span className="lab">{profitLabel}</span>
          <Link href={p?.href ?? "/pengar"} className="hh-big">
            {krInt(p?.value ?? 0)}
            <small>{NBSP}kr</small>
          </Link>
          {p && p.deltaBp !== null ? (
            <div className="hh-dl">
              <DeltaBadge bp={p.deltaBp} />
              <span>
                {p.deltaOre !== null ? signedKr(p.deltaOre) : null}
                {p.compareText ? <span className="vs"> {p.compareText}</span> : null}
              </span>
            </div>
          ) : p?.compareText && p.deltaOre !== null ? (
            // Ingen procent (förra perioden 0 kr): skillnaden i kronor, aldrig bara "mot …".
            <div className="hh-dl">
              <span>
                {signedKr(p.deltaOre)}
                <span className="vs"> {p.compareText}</span>
              </span>
            </div>
          ) : null}
          {h.spark ? <HeroSparkline spark={h.spark} /> : null}
        </section>

        <section className="hh-sec hh-pod" style={order(1)} aria-labelledby="hh-pod-h">
          <div className="hh-hd">
            <span className="lab" id="hh-pod-h">
              Mest sålda · {h.periodName}
            </span>
            <Link className="lk" href={h.topHref}>
              Alla titlar <span aria-hidden="true">→</span>
            </Link>
          </div>
          {h.top.length > 0 ? (
            <PackPodium
              className="hh-podium"
              aria-label={`Mest sålda ${h.periodName}`}
              items={h.top.map((t) => ({
                title: t.name,
                label: `${formatInt(t.orders)}${NBSP}st`,
              }))}
            />
          ) : (
            <p className="hh-empty">Inga sålda pack i perioden.</p>
          )}
        </section>

        <section className="hh-sec hh-goal" style={order(2)} aria-labelledby="hh-goal-h">
          <div className="hh-hd">
            <span className="lab" id="hh-goal-h">
              {goalTitle ? `${goalTitle} · ${goal?.label}` : "Mål för månaden"}
            </span>
            <Link className="lk" href="/expansion?vy=mal">
              Mål <span aria-hidden="true">→</span>
            </Link>
          </div>
          {goal ? <GoalBody goal={goal} /> : <NoGoal canEdit={ctx.canEdit} />}
        </section>
      </div>

      {/* Telefon: målet som eget kort under hjälten (mockens ordning). */}
      <Card
        className="hh-goalcard"
        title={
          goalTitle ? (
            <>
              {goalTitle} <small>· {goal?.label}</small>
            </>
          ) : (
            "Mål för månaden"
          )
        }
        link={{ href: "/expansion?vy=mal", label: "Mål" }}
      >
        <div className="hh-goalcard-b">
          {goal ? <GoalBody goal={goal} phone /> : <NoGoal canEdit={ctx.canEdit} />}
        </div>
      </Card>

      {h.kpis.length > 0 ? (
        <KpiRow count={h.kpis.length} label="Nyckeltal för perioden">
          {h.kpis.map((t) => (
            <CompactKpi key={t.id} t={t} />
          ))}
        </KpiRow>
      ) : null}

      {goal && cele ? (
        <GoalCelebration
          storageKey={celebrateKey(ctx.organization.id, ctx.user.id, goal.month, goal.id)}
          titles={cele.titles}
          heading="Målet nått!"
          body={
            <>
              {goalFmt(goal)(goal.target)} {goal.label} i {goal.monthName},
              <br />
              {cele.ahead}.{cele.top ? ` ${cele.top} drog mest.` : ""}
            </>
          }
        />
      ) : null}
    </HeroIntro>
  );
}
