import Link from "next/link";

import type { ShrinkageMachine, ShrinkageReport } from "@/analytics/shrinkage";
import { MachineGlyph, glyphStatusOf } from "@/components/v2/machine-glyph";
import { PackImage } from "@/components/v2/pack-image";
import { cn } from "@/lib/cn";
import { formatInt, MINUS, NBSP } from "@/lib/format";

import { machineHref } from "../_lib/model";
import type { MachineScreen } from "../_lib/v2-data";
import { glyphSlotsOf } from "../_lib/v2-model";

import "./svinn.css";

type TileState = "missing" | "ok" | "count";

/** Rutans läge: pack saknas, stämmer, eller inget att jämföra med (räkna automaten). */
export function tileState(m: ShrinkageMachine, flagged: boolean): TileState {
  if (flagged) return "missing";
  return m.lines.some((l) => l.state !== "unknown") ? "ok" : "count";
}

/** Ankaret till en flaggad automats kort längre ned. */
export function svinnAnchor(machineId: string): string {
  return `svinn-${machineId}`;
}

/**
 * Svinn i en blick (mockupen visuellt/01): en stor siffra (pack som saknas) och en ruta per
 * automat med automatens bild. Bocken = stämmer, "Räkna" = inget saldo att jämföra med,
 * "−2 pack" i rött med packbilderna som saknas. Serverkomponent utan klientkod.
 */
export function SvinnOverview({
  report,
  screens,
  value,
  period,
}: {
  report: ShrinkageReport;
  /** Perioden i rubriken ("1–30 nov."). */
  period: string;
  screens: ReadonlyMap<string, MachineScreen>;
  /** Värdet av det som saknas ("≈ 240 kr"), eller null. */
  value: string | null;
}) {
  const flaggedIds = new Set(report.flagged.map((m) => m.machineId));
  const all = [...report.flagged, ...report.ok].sort((a, b) =>
    a.code.localeCompare(b.code, "sv", { numeric: true }),
  );
  const ok = report.ok.filter((m) => tileState(m, false) === "ok").length;
  const uncounted = report.ok.length - ok;
  if (all.length === 0) return null;

  return (
    <section className="v2-card sv" aria-labelledby="sv-h">
      <div className="v2-card-hd">
        <h2 id="sv-h">
          Svinn <span className="font-normal text-v2-mute">{period}</span>
        </h2>
      </div>
      <div className="sv-body">
        <div className="sv-total">
          <p className={cn("sv-big", report.missing > 0 && "crit")}>
            {report.missing > 0 ? `${formatInt(report.missing)}${NBSP}pack saknas` : "Inget saknas"}
          </p>
          <p className="sv-sub">
            {[
              `${formatInt(ok)} ${ok === 1 ? "automat stämmer" : "automater stämmer"}`,
              uncounted > 0 ? `${formatInt(uncounted)} ej räknade` : null,
              value && report.missing > 0 ? `värde ${value}` : null,
            ]
              .filter(Boolean)
              .join(" · ")}
          </p>
        </div>
        <ul className="sv-grid">
          {all.map((m) => (
            <li key={m.machineId}>
              <Tile
                m={m}
                state={tileState(m, flaggedIds.has(m.machineId))}
                screen={screens.get(m.machineId) ?? null}
              />
            </li>
          ))}
        </ul>
      </div>
    </section>
  );
}

function Tile({
  m,
  state,
  screen,
}: {
  m: ShrinkageMachine;
  state: TileState;
  screen: MachineScreen | null;
}) {
  const missingTitles = m.lines.filter((l) => l.flagged && (l.missing ?? 0) > 0).slice(0, 3);
  const href =
    state === "missing"
      ? `#${svinnAnchor(m.machineId)}`
      : state === "count"
        ? `/fyll-pa/${encodeURIComponent(m.machineId)}`
        : machineHref(m.code);
  const label =
    state === "missing"
      ? `${MINUS}${formatInt(m.missing)}${NBSP}pack`
      : state === "ok"
        ? "Stämmer"
        : "Räkna";
  return (
    <Link
      href={href}
      className={cn("sv-tile", state)}
      aria-label={`${m.code} ${m.name}: ${
        state === "missing"
          ? `${formatInt(m.missing)} pack saknas`
          : state === "ok"
            ? "stämmer"
            : "inget att jämföra med, räkna automaten"
      }`}
    >
      <span className="sv-fig">
        <MachineGlyph
          look={screen?.appearance}
          size="m"
          status={screen ? glyphStatusOf(screen.status) : "ok"}
          slots={screen ? glyphSlotsOf(screen.slots) : undefined}
          decorative
        />
        <span className={cn("sv-mark", state)} aria-hidden="true">
          {state === "ok" ? (
            <svg viewBox="0 0 12 12" width="12" height="12" fill="none">
              <path
                d="M2.5 6.2 4.9 8.5 9.5 3.6"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          ) : state === "count" ? (
            "#"
          ) : (
            `${MINUS}${formatInt(m.missing)}`
          )}
        </span>
      </span>
      <span className="sv-code">{m.code}</span>
      <span className={cn("sv-lab", state)}>{label}</span>
      {missingTitles.length > 0 ? (
        <span className="sv-packs" aria-hidden="true">
          {missingTitles.map((l) => (
            <PackImage key={l.titleId} title={l.titleName} size="xs" />
          ))}
        </span>
      ) : null}
    </Link>
  );
}
