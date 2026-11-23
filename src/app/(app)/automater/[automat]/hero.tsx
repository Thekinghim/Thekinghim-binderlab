import type { ReactNode } from "react";

import { PACE_WINDOW_DAYS } from "@/analytics/fleet-status";
import { ButtonLink } from "@/components/v2/button";
import { MachineGlyph, glyphStatusOf } from "@/components/v2/machine-glyph";
import { PackImage } from "@/components/v2/pack-image";
import { FleetStatusBadge } from "@/components/v2/status-dot";
import { cn } from "@/lib/cn";
import { formatDecimal, formatInt, formatSek, MINUS, NBSP } from "@/lib/format";
import type { MachineReadiness } from "@/server/onboarding/machine-ready";

import { ReadySteps } from "../_components/ready-list";
import type { KpiView } from "../_lib/types";
import type { MachineScreen } from "../_lib/v2-data";
import { glyphSlotsOf, sinceText } from "../_lib/v2-model";

import "./hero.css";

/** En titel att fylla på vid nästa besök (lagrets nivå "nu" eller "snart"). */
export interface HeroRefill {
  readonly titleId: string;
  readonly name: string;
  readonly onHand: number;
  /** Kapaciteten från Awish, annars null. */
  readonly capacity: number | null;
}

/**
 * Automatens överdel (V2, mockupen visuellt/01): bilden av automaten till vänster (240 px,
 * skärmen visar packen och fyllnaden), till höger namn, butik, läge och tre nyckeltal,
 * sedan vad som ska fyllas på vid nästa besök och Startklar som en ring (5/6) med stegen
 * bakom "Visa stegen". Serverkomponent utan klientkod. Sidan finns bara för roller som
 * ser ekonomi (requireAutomaterEconomy), så kronor får stå här.
 */
export function MachineHero({
  code,
  name,
  city,
  storeName,
  screen,
  kpis,
  pendingToday,
  days,
  refill,
  ready,
  canEdit,
  now,
  timeZone,
  facts,
}: {
  code: string;
  name: string;
  city: string | null;
  storeName: string | null;
  /** Bilden och läget ur flottans läge (null = kunde inte läsas: svart bild utan fack). */
  screen: MachineScreen | null;
  kpis: readonly KpiView[];
  pendingToday: boolean;
  /** "30 d" */
  days: string;
  refill: readonly HeroRefill[];
  ready: MachineReadiness | null;
  canEdit: boolean;
  now: string;
  timeZone: string;
  /** Ansvarig, driftstart m.m. längst ned. */
  facts?: ReactNode;
}) {
  const revenue = kpis.find((k) => k.id === "revenue");
  const profit = kpis.find((k) => k.id === "profit");
  const slots = screen ? glyphSlotsOf(screen.slots) : undefined;
  const filled = screen?.lastRefillAt
    ? sinceText(screen.lastRefillAt, Date.parse(now), timeZone)
    : null;
  const sub = [
    filled
      ? filled === "i dag" || filled === "i går"
        ? `fylld ${filled}`
        : `fylld för ${filled.replace(" d sen", NBSP + "dagar")} sedan`
      : null,
    screen?.units != null && screen.capacity != null
      ? `${formatInt(screen.units)} av ${formatInt(screen.capacity)} pack`
      : screen?.units != null
        ? `${formatInt(screen.units)} pack`
        : null,
  ].filter(Boolean);

  return (
    <section className="v2-card mh" aria-labelledby="mh-name">
      <div className="mh-fig">
        <MachineGlyph
          look={screen?.appearance}
          size="xl"
          status={screen ? glyphStatusOf(screen.status) : "ok"}
          slots={slots}
          name={code}
          className="mh-gl-xl"
        />
        <MachineGlyph
          look={screen?.appearance}
          size="l"
          status={screen ? glyphStatusOf(screen.status) : "ok"}
          slots={slots}
          name={code}
          className="mh-gl-l"
        />
      </div>
      <div className="mh-body">
        <div className="mh-top">
          <span className="lab">{[code, city].filter(Boolean).join(" · ")}</span>
          {screen ? (
            <span className="mh-status" data-status={screen.status}>
              <FleetStatusBadge status={screen.status} daysLeft={screen.daysLeft} />
            </span>
          ) : null}
        </div>
        <h2 id="mh-name">{name}</h2>
        <p className="mh-sub">
          <b>{storeName ?? "Ingen butik"}</b>
          {sub.map((t) => (
            <span key={t}> · {t}</span>
          ))}
        </p>

        {pendingToday ? (
          <p className="mh-pending">Inga order från {code} i dag än.</p>
        ) : (
          <dl className="mh-kpis">
            {revenue ? (
              <Kpi label={`Intäkt ${days}`} value={formatSek(revenue.value / 100)} kpi={revenue} />
            ) : null}
            {profit ? (
              <Kpi
                label={`${profit.label} ${days}`}
                value={formatSek(profit.value / 100)}
                kpi={profit}
                tone="pf"
              />
            ) : null}
            {/* Takten räknas på de senaste 14 dagarna (flottans läge), inte på perioden: det
                står under värdet, och periodens order står inte här för att inte blanda ihop
                två tidsfönster. */}
            <div>
              <dt>Sålt per dag</dt>
              <dd>
                <span className="v">
                  {screen
                    ? `${formatDecimal(Math.round(screen.perDayMilli / 100) / 10)}${NBSP}pack`
                    : "–"}
                </span>
                {screen ? (
                  <small>
                    snitt senaste {formatInt(PACE_WINDOW_DAYS)}
                    {NBSP}d
                  </small>
                ) : null}
              </dd>
            </div>
          </dl>
        )}

        {refill.length > 0 || ready ? (
          <div className={cn("mh-row", refill.length > 0 && ready && "two")}>
            {refill.length > 0 ? <RefillCard refill={refill} /> : null}
            {ready ? <ReadyRing ready={ready} canEdit={canEdit} /> : null}
          </div>
        ) : null}

        {facts ? <div className="mh-facts">{facts}</div> : null}
      </div>
    </section>
  );
}

function deltaText(d: NonNullable<KpiView["delta"]>): string {
  const pct = Math.round(Math.abs(d.value) * 100);
  return `${d.value > 0 ? "+" : d.value < 0 ? MINUS : "±"}${formatInt(pct)}${NBSP}%`;
}

function Kpi({
  label,
  value,
  kpi,
  tone,
}: {
  label: string;
  value: string;
  kpi: KpiView;
  tone?: "pf";
}) {
  const d = kpi.delta && kpi.delta.kind === "relative" ? kpi.delta : null;
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        <span className={cn("v", tone, kpi.value < 0 && "neg")}>{value}</span>
        {d ? (
          <small className={cn("dl", d.value < 0 ? "down" : d.value > 0 ? "up" : undefined)}>
            <span aria-hidden="true">{d.value < 0 ? "▼" : d.value > 0 ? "▲" : ""}</span>{" "}
            {deltaText(d)}
            <span className="sr-only"> mot perioden innan</span>
          </small>
        ) : null}
      </dd>
    </div>
  );
}

function RefillCard({ refill }: { refill: readonly HeroRefill[] }) {
  return (
    <div className="mh-card mh-refill">
      <p className="mh-card-h">Fyll på vid nästa besök</p>
      <ul>
        {refill.slice(0, 2).map((r) => {
          const f = r.capacity ? Math.max(0, Math.min(1, r.onHand / r.capacity)) : null;
          return (
            <li key={r.titleId}>
              <PackImage title={r.name} size="m" />
              <span className="t">
                <b>{r.name}</b>
                <small>
                  <span className={cn(r.onHand <= 0 && "crit", r.onHand > 0 && "warn")}>
                    {r.onHand <= 0 ? "Slut" : formatInt(r.onHand)}
                  </span>
                  {r.onHand > 0
                    ? r.capacity
                      ? ` av ${formatInt(r.capacity)} kvar`
                      : " kvar"
                    : r.capacity
                      ? ` · plats för ${formatInt(r.capacity)}`
                      : ""}
                </small>
                {f !== null ? (
                  <span className="v2-track mh-bar" aria-hidden="true">
                    <i
                      className={f <= 0.25 ? "critical" : "warning"}
                      style={{ transform: `scaleX(${f})` }}
                    />
                  </span>
                ) : null}
              </span>
            </li>
          );
        })}
      </ul>
      {refill.length > 2 ? (
        <p className="mh-more">
          + {formatInt(refill.length - 2)} {refill.length - 2 === 1 ? "titel" : "titlar"} till
        </p>
      ) : null}
    </div>
  );
}

/** Startklar som en ring med ett segment per steg (klara segment mörka). */
function ReadyRing({ ready, canEdit }: { ready: MachineReadiness; canEdit: boolean }) {
  const n = Math.max(1, ready.total);
  const r = 26;
  const c = 2 * Math.PI * r;
  const gap = n > 1 ? 4 : 0;
  const seg = c / n - gap;
  const next = ready.next;
  return (
    <div className="mh-card mh-ready" data-startklar={ready.code}>
      <div className="mh-ready-top">
        <span className="mh-ring">
          <svg viewBox="0 0 64 64" width="64" height="64" aria-hidden="true">
            {Array.from({ length: n }, (_, i) => (
              <circle
                key={i}
                cx="32"
                cy="32"
                r={r}
                fill="none"
                strokeWidth="5"
                className={i < ready.done ? "on" : "off"}
                strokeDasharray={`${seg} ${c - seg}`}
                strokeDashoffset={-(i * (c / n)) + gap / 2}
                transform="rotate(-90 32 32)"
              />
            ))}
          </svg>
          <span className="n">
            {formatInt(ready.done)}/{formatInt(ready.total)}
          </span>
        </span>
        <span className="mh-ready-t">
          <b>Startklar</b>
          {/* Samma text som Startklar-listan: "BL-001: 5 av 6 klart." */}
          <span className="sr-only">{` ${ready.code}: ${ready.progress}.`}</span>
          {next ? <small>{`Nästa: ${next.next}.`}</small> : null}
          {canEdit && next?.href ? (
            <ButtonLink
              href={next.href}
              variant="act"
              size="sm"
              touch
              className="mt-1.5 self-start"
            >
              {next.next.charAt(0).toUpperCase() + next.next.slice(1)}
            </ButtonLink>
          ) : null}
        </span>
      </div>
      <details className="mh-steps">
        <summary>
          <span className="o">Visa stegen</span>
          <span className="c">Dölj stegen</span>
        </summary>
        <ReadySteps ready={ready} canEdit={canEdit} />
      </details>
    </div>
  );
}
