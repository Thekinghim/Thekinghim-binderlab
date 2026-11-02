import type { CSSProperties, ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { cn } from "@/lib/cn";
import { NBSP, formatInt, formatNumber } from "@/lib/format";
import { motion } from "@/lib/tokens";
import { contrast, displayValue, resolveToken, type ThemeTokens } from "./tokens";

/* ------------------------------------------------------------------ */
/* Färg                                                                */
/* ------------------------------------------------------------------ */

type Requirement = "text" | "graphic" | "decor" | "surface";

type ColorRow = { token: string; role: string; req: Requirement; against?: string };

export const colorGroups: ReadonlyArray<{ title: string; rows: ReadonlyArray<ColorRow> }> = [
  {
    title: "Ytor",
    rows: [
      { token: "--bl-bg", role: "Bakgrund", req: "surface" },
      { token: "--bl-surface", role: "Panel", req: "surface" },
      { token: "--bl-surface-raised", role: "Meny, dialog, notis", req: "surface" },
      { token: "--bl-surface-hover", role: "Rad under pekaren, valt segment", req: "surface" },
    ],
  },
  {
    title: "Linjer",
    rows: [
      { token: "--bl-line", role: "Hårfin avdelare", req: "decor" },
      { token: "--bl-line-strong", role: "Tabellhuvud, knappkant", req: "decor" },
      { token: "--bl-line-control", role: "Fältkant, tröskel", req: "graphic" },
      { token: "--bl-grid", role: "Koordinatnät på mätytor", req: "decor" },
    ],
  },
  {
    title: "Text",
    rows: [
      { token: "--bl-fg", role: "Siffror, rubriker, fokusring", req: "text" },
      { token: "--bl-fg-muted", role: "Brödtext, sekundärt", req: "text" },
      { token: "--bl-fg-subtle", role: "Etiketter, grå rubrikdel", req: "text" },
      { token: "--bl-fg-disabled", role: "Inaktiv kontroll", req: "text" },
      { token: "--bl-fg-faint", role: "Axlar och dekor, aldrig text", req: "decor" },
    ],
  },
  {
    title: "Signal",
    rows: [
      { token: "--bl-signal", role: "Kräver åtgärd: glyf, stapel, nod", req: "graphic" },
      { token: "--bl-signal-fg", role: "Signal som text", req: "text" },
      { token: "--bl-signal-line", role: "Kant på kritisk status", req: "graphic" },
      {
        token: "--bl-on-signal",
        role: "Text på fylld signal",
        req: "text",
        against: "--bl-signal",
      },
    ],
  },
  {
    title: "Inverterat",
    rows: [
      { token: "--bl-inverse-bg", role: "Primärknapp", req: "graphic" },
      {
        token: "--bl-inverse-fg",
        role: "Text på primärknapp",
        req: "text",
        against: "--bl-inverse-bg",
      },
    ],
  },
];

export const colorTokenCount = colorGroups.reduce((n, g) => n + g.rows.length, 0);

const reqLabel: Record<Requirement, string> = {
  text: `≥${NBSP}4,5:1`,
  graphic: `≥${NBSP}3:1`,
  decor: "dekor",
  surface: "yta",
};
const reqMin: Partial<Record<Requirement, number>> = { text: 4.5, graphic: 3 };

const ratio = (r: number) => `${formatNumber(Math.floor(r * 10) / 10, 1)}:1`;

function ThemeCell({
  tokens,
  row,
  bgToken,
}: {
  tokens: Record<string, string>;
  row: ColorRow;
  bgToken: string;
}) {
  const value = resolveToken(tokens, row.token);
  const bg = resolveToken(tokens, row.against ?? bgToken);
  const c = row.req === "surface" ? null : contrast(value, bg);
  const min = reqMin[row.req];
  const fails = c !== null && min !== undefined && c < min;
  return (
    <div className="flex min-w-0 items-center gap-2 sm:gap-3">
      <span
        aria-hidden
        className="size-6 shrink-0 rounded-xs border border-line-strong"
        style={{ background: value }}
      />
      <span className="meta hidden min-w-0 truncate text-muted sm:inline">
        {displayValue(value)}
      </span>
      <span
        className={cn(
          "meta tnum ml-auto shrink-0 text-right",
          c === null ? "text-subtle" : fails ? "text-signal-fg" : "text-fg",
        )}
      >
        {c === null ? "–" : ratio(c)}
        {fails ? " under krav" : ""}
      </span>
    </div>
  );
}

/** Tokentabell: mörkt och ljust sida vid sida med kontrast mot bakgrunden, beräknad ur tokens.css. */
export function ColorTable({ tokens }: { tokens: ThemeTokens }) {
  return (
    <table className="w-full border-collapse text-left">
      <caption className="sr-only">
        Färgtokens med roll, värde och kontrast mot bakgrunden i mörkt och ljust läge
      </caption>
      <thead>
        <tr className="border-b border-line-strong">
          <th scope="col" className="label pb-2 font-normal text-subtle">
            Token
          </th>
          <th scope="col" className="label hidden pb-2 font-normal text-subtle lg:table-cell">
            Roll
          </th>
          <th scope="col" className="label pb-2 pl-2 font-normal text-subtle sm:pl-4">
            Mörkt <span className="hidden sm:inline">· mot bg</span>
          </th>
          <th scope="col" className="label pb-2 pl-2 font-normal text-subtle sm:pl-4">
            Ljust <span className="hidden sm:inline">· mot bg</span>
          </th>
          <th
            scope="col"
            className="label hidden pb-2 pl-4 text-right font-normal text-subtle sm:table-cell"
          >
            Krav
          </th>
        </tr>
      </thead>
      {colorGroups.map((g) => (
        <tbody key={g.title}>
          <tr>
            <th
              scope="rowgroup"
              colSpan={5}
              className="label pt-6 pb-2 text-left font-normal text-fg"
            >
              {g.title}
              <span className="ml-2 text-subtle">{String(g.rows.length).padStart(2, "0")}</span>
            </th>
          </tr>
          {g.rows.map((r) => (
            <tr key={r.token} className="border-t border-line">
              <th
                scope="row"
                className="w-[34%] py-2 pr-2 align-middle font-normal sm:w-[20%] lg:w-[16%]"
              >
                <code className="meta block [overflow-wrap:anywhere] text-fg">
                  {r.token.replace("--bl-", "")}
                </code>
                {/* Rollen bryts i stället för att kapas: "aldrig text" får inte försvinna. */}
                <span className="mt-0.5 block text-xs text-subtle lg:hidden">{r.role}</span>
              </th>
              <td className="hidden py-2 pr-4 align-middle text-sm text-muted lg:table-cell">
                {r.role}
              </td>
              <td className="py-2 pl-2 align-middle sm:pl-4">
                <ThemeCell tokens={tokens.dark} row={r} bgToken="--bl-bg" />
              </td>
              <td className="py-2 pl-2 align-middle sm:pl-4">
                <ThemeCell tokens={tokens.light} row={r} bgToken="--bl-bg" />
              </td>
              <td className="meta hidden py-2 pl-4 text-right align-middle text-subtle sm:table-cell">
                {reqLabel[r.req]}
              </td>
            </tr>
          ))}
        </tbody>
      ))}
    </table>
  );
}

/** Lägst till högst. Numret är tokenens: data-1 är starkast, data-0 ligger närmast ytan. */
const ramp = [
  "--bl-data-0",
  "--bl-data-5",
  "--bl-data-4",
  "--bl-data-3",
  "--bl-data-2",
  "--bl-data-1",
];

/** Dataskalan som en tunn rad per läge, med tokenens nummer och hex under varje steg. */
export function DataRamp({ tokens }: { tokens: ThemeTokens }) {
  return (
    <div className="flex flex-col gap-4">
      {(["dark", "light"] as const).map((t) => (
        <div key={t} className="grid grid-cols-[56px_minmax(0,1fr)] items-start gap-3">
          <span className="label pt-1 text-subtle">{t === "dark" ? "Mörkt" : "Ljust"}</span>
          <div className="grid grid-cols-6 gap-px">
            {ramp.map((name) => {
              const v = resolveToken(tokens[t], name);
              return (
                <div key={name} className="flex min-w-0 flex-col gap-1.5">
                  <span aria-hidden className="h-6" style={{ background: v }} />
                  <span className="meta tnum text-subtle">
                    <span className="hidden md:inline">data-</span>
                    {name.replace("--bl-data-", "")}
                  </span>
                  <span className="meta hidden truncate text-subtle md:block">
                    {displayValue(v)}
                  </span>
                </div>
              );
            })}
          </div>
        </div>
      ))}
      <p className="text-sm text-subtle">
        Lägst till högst. Numret är tokenens: 1 är starkast och används för den aktuella serien, 0
        ligger närmast ytan.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Typografi                                                           */
/* ------------------------------------------------------------------ */

type TypeRow = {
  token: string;
  spec: string;
  className: string;
  sample: ReactNode;
  font: "Geist" | "Geist Mono";
};

export function typeScale(revenue: string): TypeRow[] {
  return [
    {
      token: "display",
      spec: "64 / 64 · −4 %",
      className: "text-3xl md:text-display font-medium tnum",
      sample: revenue,
      font: "Geist",
    },
    {
      token: "3xl",
      spec: "44 / 48 · −3 %",
      className: "text-2xl md:text-3xl font-medium",
      sample: "Intäkt per automat.",
      font: "Geist",
    },
    {
      token: "2xl",
      spec: "32 / 36 · −2,5 %",
      className: "text-xl md:text-2xl font-medium",
      sample: "Black Bolt sålde slut i BL-002.",
      font: "Geist",
    },
    {
      token: "xl",
      spec: "24 / 32 · −2 %",
      className: "text-xl font-medium",
      sample: "Lagret i BL-003 räcker 2 dagar till.",
      font: "Geist",
    },
    {
      token: "lg",
      spec: "20 / 28 · −1,5 %",
      className: "text-lg font-medium",
      sample: "Påfyllning BL-002 Mobilia, fack 3.",
      font: "Geist",
    },
    {
      token: "md",
      spec: "16 / 24",
      className: "text-md",
      sample: "BL-002 Mobilia har sålt slut på Black Bolt i fack 3.",
      font: "Geist",
    },
    {
      token: "base",
      spec: "14 / 20",
      className: "text-base",
      sample: "30th Celebration · fack 2 · 12 kvar",
      font: "Geist",
    },
    {
      token: "sm",
      spec: "13 / 20",
      className: "text-sm text-muted",
      sample: "Senast synkad 14:32 från 3 av 3 automater.",
      font: "Geist",
    },
    {
      token: "label",
      spec: "11 / 16 · +8 % · versal",
      className: "label text-muted",
      sample: "06 / Nyckeltal · 30 d",
      font: "Geist Mono",
    },
    {
      token: "meta",
      spec: "12 / 16 · gemen",
      className: "meta text-muted",
      sample: "BL-001 · 1 nov. 17:17 · order 42780",
      font: "Geist Mono",
    },
  ];
}

// Ettor är smala i proportionella siffror: 1 111 mot 8 808 visar skillnaden.
const tnumSamples = [111_100, 880_800, 11_100, 404_000];

/** Typskalan i rader: token och mått till vänster, produkttext till höger. */
export function TypeScale({ revenue }: { revenue: string }) {
  const rows = typeScale(revenue);
  return (
    <div className="flex flex-col">
      {rows.map((t) => (
        <div
          key={t.token}
          className="grid grid-cols-1 items-baseline gap-1 border-t border-line py-4 md:grid-cols-12 md:gap-8"
        >
          <div className="flex items-baseline gap-3 md:col-span-3 md:flex-col md:gap-0.5">
            <span className="label text-fg">{t.token}</span>
            <span className="meta tnum text-subtle">
              {t.spec} · {t.font.replace(" ", NBSP)}
            </span>
          </div>
          {/* Provtexten bryts hellre än kapas; raden linjerar på första baslinjen. */}
          <p className={cn(t.className, "min-w-0 text-pretty md:col-span-9")}>{t.sample}</p>
        </div>
      ))}
      <div className="grid grid-cols-1 gap-1 border-y border-line py-4 md:grid-cols-12 md:gap-8">
        <div className="flex items-baseline gap-3 md:col-span-3 md:flex-col md:gap-0.5">
          <span className="label text-fg">tnum</span>
          <span className="meta text-subtle">Geist med tabulära siffror</span>
        </div>
        <div className="grid grid-cols-2 gap-8 md:col-span-9 md:max-w-md">
          {[
            { label: "Proportionell", tnum: false },
            { label: "Tabulär", tnum: true },
          ].map((c) => (
            <div key={c.label} className="flex flex-col">
              <span className="label mb-2 text-subtle">{c.label}</span>
              {tnumSamples.map((v) => (
                <span key={v} className={cn("text-right text-md", c.tnum && "tnum")}>
                  {formatInt(v / 100)}
                  {NBSP}kr
                </span>
              ))}
              <span
                className={cn(
                  "mt-1 border-t border-line-strong pt-1 text-right text-md text-fg",
                  c.tnum && "tnum",
                )}
              >
                {formatInt(tnumSamples.reduce((s, v) => s + v, 0) / 100)}
                {NBSP}kr
              </span>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Mått                                                                */
/* ------------------------------------------------------------------ */

/** Måttlinje med ändstreck och etikett i mono. */
function Dim({
  className,
  style,
  label,
  vertical,
}: {
  className?: string;
  style?: CSSProperties;
  label: string;
  vertical?: boolean;
}) {
  return (
    <span aria-hidden className={cn("pointer-events-none absolute", className)} style={style}>
      <span
        className={cn(
          "absolute bg-line-control",
          vertical ? "inset-y-0 left-1/2 w-px" : "inset-x-0 top-1/2 h-px",
        )}
      />
      <span
        className={cn(
          "absolute bg-line-control",
          vertical
            ? "top-0 left-[calc(50%-3px)] h-px w-[7px]"
            : "top-[calc(50%-3px)] left-0 h-[7px] w-px",
        )}
      />
      <span
        className={cn(
          "absolute bg-line-control",
          vertical
            ? "bottom-0 left-[calc(50%-3px)] h-px w-[7px]"
            : "top-[calc(50%-3px)] right-0 h-[7px] w-px",
        )}
      />
      <span
        className={cn(
          "meta tnum absolute bg-bg px-0.5 leading-none text-fg",
          vertical
            ? "top-1/2 left-[calc(50%+6px)] -translate-y-1/2"
            : "top-[calc(50%-14px)] left-1/2 -translate-x-1/2",
        )}
      >
        {label}
      </span>
    </span>
  );
}

/**
 * Avstånd uppmätta på en riktig nyckeltalscell: luft, avstånd mellan etikett,
 * värde och delta, och 8 px-rytmen under.
 */
export function SpacingSpecimen({ value, delta }: { value: string; delta: string }) {
  const steps = [4, 8, 12, 16, 24, 32, 40, 48, 64];
  return (
    <div className="flex flex-col gap-10">
      <div className="grid-field relative overflow-hidden rounded-md border border-line px-6 py-12 sm:px-12">
        <div className="relative mx-auto w-full max-w-[320px]">
          {/* Cellen: samma mått som KpiStrip (py 16, etikett → värde 12, värde → delta 4). */}
          <div className="relative border-y border-line-strong bg-bg py-4">
            <p className="label text-muted">Intäkt</p>
            <p className="tnum mt-3 text-2xl font-medium">{value}</p>
            <p className="meta tnum mt-1 text-fg">{delta}</p>
            <Dim vertical label="16" className="top-0 right-0 h-4 w-8 translate-x-full" />
            <Dim vertical label="12" className="top-8 right-0 h-3 w-8 translate-x-full" />
            <Dim vertical label="16" className="right-0 bottom-0 h-4 w-8 translate-x-full" />
          </div>
          <Dim label="320 · 2 kolumner" className="-bottom-8 left-0 h-4 w-full" />
        </div>
      </div>
      <p className="text-sm text-subtle">
        <span className="meta tnum text-fg">
          {steps.join(" · ")}
          {NBSP}px
        </span>
        . Stegen på 8 bär layouten, 4 och 12 finjusterar kontroller.
      </p>
    </div>
  );
}

/**
 * Hörnet på ett element förstorat 4×: samma radie- och kantklasser som
 * komponenten, med radien utmätt (streckad kvadrat = r × 4 px).
 */
function Corner({ r, label, className }: { r: number; label: string; className: string }) {
  return (
    <figure className="m-0 flex min-w-0 flex-col gap-2">
      <div className="relative h-28 overflow-hidden rounded-xs border border-line bg-bg">
        <span
          aria-hidden
          className={cn(
            "absolute top-5 left-5 block h-12 w-16 origin-top-left scale-[4]",
            className,
          )}
        />
        <span
          aria-hidden
          className="absolute border-r border-b border-dashed border-line-control"
          style={{ top: 20, left: 20, width: r * 4, height: r * 4 }}
        />
        <span className="meta tnum absolute bottom-2 left-2 bg-bg px-1 text-fg">R {r}</span>
      </div>
      <figcaption className="meta text-subtle">{label}</figcaption>
    </figure>
  );
}

export function RadiusSpecimen() {
  return (
    <div className="grid grid-cols-3 gap-3">
      <Corner r={2} label="Statusetikett" className="rounded-xs border border-line-control" />
      <Corner
        r={4}
        label="Knapp, fält"
        className="rounded-sm border border-line-strong bg-surface"
      />
      <Corner r={6} label="Panel, dialog" className="rounded-md border border-line bg-surface" />
    </div>
  );
}

/** Kanter på riktiga kontroller: tabellrad (line), knapp (line-strong) och fält (line-control). */
export function BorderSpecimen({ row }: { row: { id: string; name: string; value: string } }) {
  return (
    <div className="flex flex-col gap-6">
      <div className="grid grid-cols-[minmax(0,1fr)_112px] items-center gap-4">
        <div className="flex h-9 min-w-0 items-center justify-between gap-3 border-y border-line text-base">
          <span className="truncate">
            <span className="meta mr-2 text-subtle">{row.id}</span>
            {row.name}
          </span>
          <span className="tnum shrink-0">{row.value}</span>
        </div>
        <span className="meta text-subtle">line · rad</span>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_112px] items-center gap-4">
        <div className="flex gap-2">
          <Button size="sm" iconLeft="download">
            Exportera
          </Button>
        </div>
        <span className="meta text-subtle">line-strong · knapp</span>
      </div>
      <div className="grid grid-cols-[minmax(0,1fr)_112px] items-end gap-4">
        <Input label="Inköpspris" defaultValue="31" suffix="kr" />
        <span className="meta pb-2 text-subtle">line-control · fält</span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Rörelse                                                             */
/* ------------------------------------------------------------------ */

/**
 * Tiderna som sidan visar: tre övergångar och två loopar. motion.count
 * (uppräkning, 420 ms) är ett tillval i KpiStrip och visas inte här.
 */
export const durations: ReadonlyArray<{ token: string; ms: number; use: string; loop?: boolean }> =
  [
    { token: "fast", ms: motion.fast, use: "Hover, färg och fokus" },
    { token: "base", ms: motion.base, use: "Segment och värdebyte i nyckeltal" },
    { token: "slow", ms: motion.slow, use: "Dialog och notis glider in" },
    { token: "tick", ms: motion.tick, use: "Knapp som laddar, tre punkter", loop: true },
    { token: "pulse", ms: motion.pulse, use: "Laddningsytor, en hel puls", loop: true },
  ];

const AXIS_MAX = 200;

/**
 * Övergångarna på en axel 0–200 ms, där varje token är en nod på sitt värde.
 * Raderna spelar upp sin rörelse vid hover eller fokus (ingen knapp).
 * Looparna står för sig under axeln, eftersom de inte är övergångar.
 */
export function MotionTimeline() {
  const ticks = [0, motion.fast, motion.base, motion.slow, AXIS_MAX];
  const transitions = durations.filter((d) => !d.loop);
  const loops = durations.filter((d) => d.loop);
  const row =
    "group grid grid-cols-[minmax(0,1fr)] gap-2 border-b border-line py-3 outline-offset-2 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:gap-8";
  const name = (d: (typeof durations)[number]) => (
    <span className="flex items-baseline gap-3">
      <span className="label w-12 shrink-0 text-fg">{d.token}</span>
      <span className="meta tnum w-16 shrink-0 text-muted">
        {formatInt(d.ms)}
        {NBSP}ms
      </span>
      <span className="min-w-0 text-sm text-subtle">{d.use}</span>
    </span>
  );
  return (
    <div className="flex flex-col">
      <div
        className="hidden md:grid md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)] md:gap-8"
        aria-hidden
      >
        <span className="label self-end pb-1 text-subtle">Övergång</span>
        <div className="relative h-10">
          <span className="absolute inset-x-0 bottom-0 h-px bg-line-strong" />
          {ticks.map((t) => (
            <span
              key={t}
              className={cn(
                "absolute bottom-0 flex flex-col gap-1",
                t === AXIS_MAX ? "-translate-x-full items-end" : "-translate-x-1/2 items-center",
              )}
              style={{ left: `${(t / AXIS_MAX) * 100}%` }}
            >
              <span className="meta tnum whitespace-nowrap text-subtle">
                {t === AXIS_MAX ? `${t}${NBSP}ms` : t}
              </span>
              <span className="h-2 w-px bg-line-strong" />
            </span>
          ))}
        </div>
      </div>
      <ul className="flex flex-col">
        {transitions.map((d) => (
          <li
            key={d.token}
            tabIndex={0}
            aria-label={`${d.token}, ${d.ms} millisekunder: ${d.use}`}
            className={row}
          >
            {name(d)}
            <span className="relative h-4">
              <span className="absolute inset-x-0 top-1/2 h-px bg-line" />
              <span
                className="absolute top-1/2 h-px bg-line-control"
                style={{ left: 0, width: `${(d.ms / AXIS_MAX) * 100}%` }}
              />
              <span
                className="absolute top-[calc(50%-4px)] size-2 bg-fg"
                style={{ left: `calc(${(d.ms / AXIS_MAX) * 100}% - 4px)` }}
              />
              {/* Spelas upp vid hover/fokus: kvadraten löper sträckan på tokenens tid. */}
              <span
                className="absolute top-[calc(50%-4px)] left-0 size-2 border border-fg bg-bg opacity-0 transition-[left,opacity] group-hover:left-[calc(100%-8px)] group-hover:opacity-100 group-focus-visible:left-[calc(100%-8px)] group-focus-visible:opacity-100 motion-reduce:hidden"
                style={{
                  transitionDuration: `${d.ms}ms`,
                  transitionTimingFunction: "var(--bl-ease)",
                }}
              />
            </span>
          </li>
        ))}
      </ul>
      <p className="label mt-8 pb-1 text-subtle">Loop</p>
      <ul className="flex flex-col border-t border-line">
        {loops.map((d) => (
          <li key={d.token} className={row}>
            {name(d)}
            <span className="meta self-center text-subtle">upprepas tills laddningen är klar</span>
          </li>
        ))}
      </ul>
      <p className="mt-3 text-sm text-subtle">
        Alla övergångar startar snabbt och bromsar in mot slutet. Med reducerad rörelse står allt
        still.
      </p>
    </div>
  );
}
