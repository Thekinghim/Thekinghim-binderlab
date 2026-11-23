import Image from "next/image";
import Link from "next/link";

import { DeltaBadge } from "@/components/v2/badge";
import { MachineGlyph } from "@/components/v2/machine-glyph";
import { formatInt, NBSP } from "@/lib/format";
import { PACK_IMAGES, packInitials, packKey } from "@/lib/pack-image";
import type { StoreReport } from "@/reports";
import type { PortalTrendMonth } from "@/server/portal/model";
import type { PortalMachineScreen } from "@/server/portal/screens";

import {
  compactKr,
  compensationChange,
  compSegments,
  isBestMonth,
  packsPerDay,
  podium,
} from "./hero-model";
import { dateTimeText, kr, monthNameText, monthShortText, monthText } from "./text";

/**
 * Översiktens nya delar (uppgradering 7): ersättningen som ett stort tal med stapel bredvid
 * butikens automat med packen på skärmen, pallen med de fem mest köpta packen och
 * staplarna per månad. Allt är serverkomponenter utan klientkod; inga inköpspriser och ingen
 * vinst för oss finns i indata (StoreReport, assertStoreReportSafe).
 */

// ---------------------------------------------------------------------------
// Ersättningen
// ---------------------------------------------------------------------------

export function CompensationHero({
  report,
  trend,
  partial,
  days,
  hasAgreement,
  machines,
  timeZone,
}: {
  report: StoreReport;
  trend: readonly PortalTrendMonth[];
  partial: boolean;
  /** Dagar i perioden (till och med i dag för pågående månad). */
  days: number;
  hasAgreement: boolean;
  machines: readonly MachineOnStage[];
  timeZone: string;
}) {
  const c = report.compensation;
  const segments = compSegments(c);
  const segTotal = segments.reduce((s, x) => s + x.ore, 0);
  const change = compensationChange(trend, report.month);
  const monthName = monthNameText(report.month);
  return (
    <section className="v2-card pt-hero" aria-labelledby="ersattning-rubrik">
      <div className="pt-hero-l">
        <p className="pt-eyebrow">
          {report.store.name} · {monthName}
          {partial ? " hittills" : ""}
        </p>
        <h2 id="ersattning-rubrik" className="pt-hero-lbl">
          Er ersättning
        </h2>
        {c.pending ? (
          <>
            <p className="pt-big pt-big-pending">Står i månadsrapporten</p>
            <p className="pt-vs">
              Er andel av vinsten räknas när månaden stängs.
              {segTotal > 0 ? ` Hittills ${kr(segTotal)} i provision och hyra.` : ""}
            </p>
          </>
        ) : (
          <>
            <p className="pt-big">
              <span className="num">{kr(c.totalOre)}</span>
              {change && change.changeBp !== 0 ? <DeltaBadge bp={change.changeBp} /> : null}
            </p>
            <p className="pt-vs">
              {!hasAgreement
                ? "Inget avtal är registrerat för månaden."
                : change
                  ? change.changeBp === 0
                    ? `samma som i ${monthNameText(change.prevMonth)}`
                    : `mot ${kr(change.prevOre)} i ${monthNameText(change.prevMonth)}`
                  : partial
                    ? "Pågående månad: ingen jämförelse förrän den är slut."
                    : c.modelText}
            </p>
          </>
        )}

        {segments.length > 0 ? (
          <>
            <div
              className="pt-stack"
              role="img"
              aria-label={`${segments.map((s) => `${s.label} ${kr(s.ore)}`).join(" plus ")}.`}
            >
              {segments.map((s) => (
                <span
                  key={s.kind}
                  className="seg"
                  data-kind={s.kind}
                  style={{ flexGrow: s.ore, flexBasis: 0 }}
                />
              ))}
            </div>
            <p className="pt-legend">
              {segments.map((s, i) => (
                <span key={s.kind} className="it">
                  {i > 0 ? (
                    <span aria-hidden className="op">
                      +
                    </span>
                  ) : null}
                  <span aria-hidden className="dot" data-kind={s.kind} />
                  {s.label}
                  <b>{kr(s.ore)}</b>
                </span>
              ))}
              {segments.length > 1 && !c.pending ? (
                <span className="it tot">
                  <span aria-hidden className="op">
                    =
                  </span>
                  <b>{kr(c.totalOre)}</b>
                </span>
              ) : null}
            </p>
          </>
        ) : null}

        <Link href="#underlag" className="pt-how">
          <span aria-hidden className="chev">
            ›
          </span>
          Så räknas det
        </Link>

        <dl className="pt-mini">
          <div>
            <dt>kunderna köpte för</dt>
            <dd>{kr(report.sales.revenueOre)}</dd>
          </div>
          <div>
            <dt>sålda i {monthName}</dt>
            <dd>
              {formatInt(report.sales.orders)}
              {NBSP}pack
            </dd>
          </div>
          <div>
            <dt>i snitt</dt>
            <dd>
              {formatInt(packsPerDay(report.sales.orders, days))}
              {NBSP}pack/dag
            </dd>
          </div>
        </dl>
      </div>
      <MachineStage machines={machines} timeZone={timeZone} />
    </section>
  );
}

// ---------------------------------------------------------------------------
// Automaten
// ---------------------------------------------------------------------------

export interface MachineOnStage {
  readonly machineId: string;
  readonly code: string;
  readonly name: string;
  readonly screen: PortalMachineScreen | null;
}

/** Läst av Awish inom så här lång tid = "Live". */
const LIVE_MS = 3 * 60 * 60 * 1000;

function fackText(screen: PortalMachineScreen | null): string {
  if (!screen || screen.channels === null || screen.channels === 0)
    return "Automaten står i butiken.";
  if (screen.status === "empty") return "Automaten är tom. Den fylls på snart.";
  return `${formatInt(screen.channelsWithPacks ?? 0)} av ${formatInt(screen.channels)} fack har pack.`;
}

function fleetFackText(machines: readonly MachineOnStage[]): string {
  let channels = 0;
  let withPacks = 0;
  for (const m of machines) {
    channels += m.screen?.channels ?? 0;
    withPacks += m.screen?.channelsWithPacks ?? 0;
  }
  if (channels === 0) return `${formatInt(machines.length)} automater i butiken.`;
  return `${formatInt(withPacks)} av ${formatInt(channels)} fack har pack.`;
}

function MachineStage({
  machines,
  timeZone,
  now = new Date(),
}: {
  machines: readonly MachineOnStage[];
  timeZone: string;
  now?: Date;
}) {
  if (machines.length === 0) {
    return (
      <div className="pt-hero-r pt-stage-empty">
        <MachineGlyph size="l" status="offline" decorative />
        <p>Ingen automat står i butiken i dag.</p>
      </div>
    );
  }
  const first = machines[0]!;
  const readAt = first.screen?.readAt ?? null;
  const live = readAt !== null && now.getTime() - Date.parse(readAt) < LIVE_MS;
  const many = machines.length > 1;
  const shown = machines.slice(0, 3);
  return (
    <div className="pt-hero-r" data-count={shown.length}>
      <div className="pt-stage-hd">
        {live ? (
          <span className="pt-live">
            <i aria-hidden />
            Live
          </span>
        ) : readAt ? (
          <span className="pt-read">Läst {dateTimeText(readAt, timeZone, now)}</span>
        ) : (
          <span />
        )}
        <span className="pt-mname">
          {many ? `${formatInt(machines.length)} automater` : `${first.code} · ${first.name}`}
        </span>
      </div>
      <ul className="pt-stage" aria-label="Automaterna i butiken">
        {shown.map((m) => (
          <li key={m.machineId} className="pt-mach">
            <MachineGlyph
              look={m.screen?.look}
              size={shown.length > 2 ? "l" : "xl"}
              status={m.screen?.status ?? "ok"}
              slots={m.screen?.slots}
              name={`${m.code} ${m.name}`}
            />
            {many ? <span className="pt-mach-n">{m.code}</span> : null}
          </li>
        ))}
      </ul>
      <div className="pt-stage-ft">
        <span className="pt-stage-txt">
          <b className="pt-stage-name">
            {many ? `${formatInt(machines.length)} automater` : `${first.code} · ${first.name}`}
          </b>
          {many ? fleetFackText(machines) : fackText(first.screen)}
        </span>
        <Link
          href={many ? "/portal/felanmalan" : `/portal/felanmalan?automat=${first.machineId}`}
          className="v2-btn touch pt-felbtn"
        >
          <svg aria-hidden viewBox="0 0 16 16" width="14" height="14">
            <path
              d="M10.5 2.5l3 3-7.5 7.5H3v-3zM9 4l3 3"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.4"
              strokeLinejoin="round"
            />
          </svg>
          Felanmäl
        </Link>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Pallen
// ---------------------------------------------------------------------------

export function PodiumCard({ report }: { report: StoreReport }) {
  const { places, ordersTop } = podium(report.topTitles);
  const monthName = monthNameText(report.month);
  return (
    <section className="v2-card pt-podcard" aria-labelledby="pall-rubrik">
      <div className="v2-card-hd">
        <h2 id="pall-rubrik">Mest köpt hos er</h2>
        <span className="lk">
          {monthName} · {formatInt(report.sales.orders)}
          {NBSP}pack
        </span>
      </div>
      {places.length === 0 ? (
        <p className="pt-note px-[18px] py-6">Inga sålda pack i {monthName} ännu.</p>
      ) : (
        <ol className="pt-podium" data-n={places.length}>
          {places.map((p) => (
            <li key={p.rank} className="pod" data-rank={p.rank}>
              <span className="sr-only">Plats {p.rank}: </span>
              <PodiumPack title={p.name} />
              <span className="cnt">
                <b>{formatInt(p.orders)}</b> st
              </span>
              <span className="ttl">{p.name}</span>
              <span aria-hidden className="plinth">
                <span>{p.rank}</span>
              </span>
            </li>
          ))}
        </ol>
      )}
      {places.length > 0 ? (
        <p className="pt-pod-ft">
          Topp {formatInt(places.length)} står för {formatInt(ordersTop)} av{" "}
          {formatInt(report.sales.orders)} sålda pack.
        </p>
      ) : null}
    </section>
  );
}

function PodiumPack({ title }: { title: string }) {
  const key = packKey(title);
  if (!key) {
    return (
      <span aria-hidden className="cover none">
        <span>{packInitials(title)}</span>
      </span>
    );
  }
  const [w, h] = PACK_IMAGES[key];
  return (
    <span aria-hidden className="cover">
      <Image src={`/packs/${key}.webp`} alt="" width={w} height={h} unoptimized draggable={false} />
    </span>
  );
}

// ---------------------------------------------------------------------------
// Staplarna per månad
// ---------------------------------------------------------------------------

export function TrendBars({ trend, month }: { trend: readonly PortalTrendMonth[]; month: string }) {
  const max = Math.max(1, ...trend.map((t) => t.revenueOre));
  const best = isBestMonth(trend, month);
  return (
    <ol className="pt-bars" style={{ "--n": trend.length } as React.CSSProperties}>
      {trend.map((t, i) => {
        const sel = t.month === month;
        const h = Math.max(2, Math.round((t.revenueOre / max) * 80));
        return (
          <li
            key={t.month}
            className="bcol"
            data-sel={sel || undefined}
            style={{ "--i": i } as React.CSSProperties}
          >
            {sel && best ? (
              <span className="pt-bestbadge">
                <svg aria-hidden viewBox="0 0 16 16" width="14" height="14">
                  <path d="M8 1.6l1.9 4 4.3.5-3.2 3 .9 4.3L8 11.2l-3.8 2.2.9-4.3-3.2-3 4.3-.5z" />
                </svg>
                Bästa månaden hittills
              </span>
            ) : null}
            <Link
              href={`/portal?manad=${t.month}`}
              className="bhit"
              aria-current={sel ? "page" : undefined}
              aria-label={`${monthText(t.month)}${t.partial ? " (pågår)" : ""}: ${kr(t.revenueOre)}`}
            >
              <span aria-hidden className="bv">
                {compactKr(t.revenueOre)}
              </span>
              <span aria-hidden className="bar" style={{ height: `${h}%` }} />
              <span aria-hidden className="bm">
                {monthShortText(t.month)}
              </span>
            </Link>
          </li>
        );
      })}
    </ol>
  );
}
