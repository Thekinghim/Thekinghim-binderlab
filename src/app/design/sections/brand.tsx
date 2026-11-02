import type { CSSProperties } from "react";
import { RasterPreview } from "@/components/brand/favicon-preview";
import {
  CLEARSPACE_UNITS,
  MIN_SYMBOL_PX,
  SYMBOL_GRID,
  SYMBOL_PARTS,
  Symbol,
  WORDMARK_SIZES,
  Wordmark,
} from "@/components/brand/wordmark";
import { CornerMarks, Panel, PanelHeader } from "@/components/ui/frame";
import { cn } from "@/lib/cn";
import { NBSP } from "@/lib/format";
import { SpecSection } from "./section";

const U = 24; // px per rutnätsenhet i konstruktionsritningen
const G = SYMBOL_GRID * U;

/** Måttlinje med ändstreck och etikett. Horisontell om y1 === y2. */
function Dim({
  x1,
  y1,
  x2,
  y2,
  label,
  side = "left",
}: {
  side?: "left" | "right";
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  label: string;
}) {
  const h = y1 === y2;
  return (
    <g>
      <path
        d={`M${x1} ${y1}L${x2} ${y2}${
          h ? `M${x1} ${y1 - 4}v8M${x2} ${y2 - 4}v8` : `M${x1 - 4} ${y1}h8M${x2 - 4} ${y2}h8`
        }`}
        stroke="var(--bl-fg-subtle)"
        strokeWidth={1}
        fill="none"
      />
      <text
        x={h ? (x1 + x2) / 2 : side === "left" ? x1 - 10 : x1 + 10}
        y={h ? y1 - 9 : (y1 + y2) / 2 + 4}
        textAnchor={h ? "middle" : side === "left" ? "end" : "start"}
        // Ritningen skalas till ca 0,62 vid 390 px; större enheter på mobil
        // ger samma läsbara storlek (ca 11 px) som på bredare skärmar.
        className="font-mono text-[17px] sm:text-[11px]"
        fill="var(--bl-fg-muted)"
      >
        {label}
      </text>
    </g>
  );
}

/** Symbolen på 16-rutnätet med mått och hjälplinjer. */
function Construction() {
  const { spine, card, ring } = SYMBOL_PARTS;
  // Hjälplinjerna stämmer med texten: Wordmark väljer textstorlek så att
  // ryggraden når ascenderhöjden och kortet x-höjden (se WORDMARK_SIZES).
  // below: etiketten under linjen i den smala (mobila) placeringen.
  const guides = [
    { y: spine.y, label: "ASCENDER", below: false },
    { y: card.y, label: "X-HÖJD", below: false },
    { y: spine.y + spine.h, label: "BASLINJE", below: true },
  ];
  const lines: string[] = [];
  for (let i = 0; i <= SYMBOL_GRID; i++) {
    lines.push(`M${i * U + 0.5} 0V${G}`, `M0 ${i * U + 0.5}H${G}`);
  }
  return (
    <svg
      viewBox={`-48 -44 ${G + 136} ${G + 72}`}
      className="block h-auto w-full max-w-[560px]"
      role="img"
      aria-label={`Konstruktionsritning: ryggrad ${spine.w} × ${spine.h}, ring ${ring.w} × ${ring.h} och kort ${card.w} × ${card.h} enheter på ett 16-rutnät`}
    >
      <path d={lines.join("")} stroke="var(--bl-line)" strokeWidth={1} fill="none" />
      {guides.map((g) => (
        <g key={g.label}>
          <path
            d={`M-12 ${g.y * U + 0.5}H${G + 12}`}
            stroke="var(--bl-line-strong)"
            strokeDasharray="3 3"
          />
          {/* Bred: till höger om rutnätet. Smal: i rutnätet, högerställd. */}
          <text
            x={G + 18}
            y={g.y * U + 4}
            className="hidden font-mono text-[10px] sm:inline"
            letterSpacing="0.08em"
            fill="var(--bl-fg-subtle)"
          >
            {g.label}
          </text>
          <text
            x={G - 6}
            y={g.below ? g.y * U + 18 : g.y * U - 6}
            textAnchor="end"
            className="font-mono text-[16px] sm:hidden"
            letterSpacing="0.08em"
            fill="var(--bl-fg-subtle)"
          >
            {g.label}
          </text>
        </g>
      ))}
      <g shapeRendering="crispEdges">
        <rect
          x={spine.x * U}
          y={spine.y * U}
          width={spine.w * U}
          height={spine.h * U}
          fill="var(--bl-fg)"
        />
        <rect
          x={card.x * U}
          y={card.y * U}
          width={card.w * U}
          height={card.h * U}
          fill="var(--bl-fg)"
        />
        <rect
          x={ring.x * U}
          y={ring.y * U}
          width={ring.w * U}
          height={ring.h * U}
          fill="var(--bl-signal)"
        />
      </g>
      <Dim
        x1={spine.x * U}
        y1={-16}
        x2={(spine.x + spine.w) * U}
        y2={-16}
        label={String(spine.w)}
      />
      <Dim x1={ring.x * U} y1={-16} x2={(ring.x + ring.w) * U} y2={-16} label={String(ring.w)} />
      <Dim x1={card.x * U} y1={-16} x2={(card.x + card.w) * U} y2={-16} label={String(card.w)} />
      <Dim
        x1={-16}
        y1={spine.y * U}
        x2={-16}
        y2={(spine.y + spine.h) * U}
        label={String(spine.h)}
      />
      <Dim
        x1={(card.x + card.w) * U + 12}
        y1={card.y * U}
        x2={(card.x + card.w) * U + 12}
        y2={(card.y + card.h) * U}
        label={String(card.h)}
        side="right"
      />
      {[
        [0, 0],
        [G, 0],
        [0, G],
        [G, G],
      ].map(([x, y]) => (
        <path
          key={`${x}-${y}`}
          d={`M${x! - 6} ${y! + 0.5}h13M${x! + 0.5} ${y! - 6}v13`}
          stroke="var(--bl-grid-mark)"
        />
      ))}
    </svg>
  );
}

/** 16 px-symbolen förstorad 8× med pixelrutnät. */
function PixelGrid() {
  const cells: string[] = [];
  for (let i = 1; i < SYMBOL_GRID; i++) {
    cells.push(`M${i} 0V16M0 ${i}H16`);
  }
  return (
    <div className="relative" style={{ width: 128, height: 128 }}>
      <svg viewBox="0 0 16 16" width={128} height={128} className="absolute inset-0" aria-hidden>
        <path d={cells.join("")} stroke="var(--bl-line)" strokeWidth={0.06} fill="none" />
      </svg>
      <Symbol size={128} className="absolute inset-0 text-fg" />
      <svg viewBox="0 0 16 16" width={128} height={128} className="absolute inset-0" aria-hidden>
        <path d={cells.join("")} stroke="var(--bl-bg)" strokeWidth={0.06} fill="none" />
        <rect
          x={0.03}
          y={0.03}
          width={15.94}
          height={15.94}
          fill="none"
          stroke="var(--bl-line-strong)"
          strokeWidth={0.06}
        />
      </svg>
    </div>
  );
}

function VariantTile({
  label,
  theme,
  mono,
  className,
  note,
}: {
  label: string;
  theme?: "light" | "dark";
  mono?: boolean;
  className?: string;
  note: string;
}) {
  return (
    <figure
      data-theme={theme}
      className={cn(
        "flex min-w-0 flex-col justify-between gap-6 rounded-md border border-line p-5 sm:gap-10",
        className,
      )}
    >
      <figcaption className="flex items-baseline justify-between gap-3">
        <span className="label text-muted">{label}</span>
        <span className="label text-subtle">{note}</span>
      </figcaption>
      <Wordmark size="md" mono={mono} />
    </figure>
  );
}

export function BrandSection({ index }: { index: number }) {
  // Friyta X i px: lg-symbolen (24 px) på mobil, xl-symbolen (64 px) från md
  const clearLg = (CLEARSPACE_UNITS * 24) / SYMBOL_GRID;
  const clearXl = (CLEARSPACE_UNITS * 64) / SYMBOL_GRID;
  return (
    <SpecSection
      id="varumarke"
      index={index}
      eyebrow="Ordmärke"
      title="Tre rektanglar på ett 16-rutnät."
      aside={`Pixelexakt från ${MIN_SYMBOL_PX} px.`}
      meta={[
        { label: "Delar", value: `${Object.keys(SYMBOL_PARTS).length} st` },
        { label: "Storlekar", value: `${Object.keys(WORDMARK_SIZES).length} st` },
        { label: "Minsta", value: `${MIN_SYMBOL_PX} px` },
      ]}
      tiles
    >
      {/* Konstruktion */}
      <Panel padded={false} className="lg:col-span-7">
        <PanelHeader
          label="Konstruktion"
          meta="16 × 16 enheter"
          className="border-b border-line px-4 py-3 md:px-5"
        />
        <div className="flex justify-center px-4 py-8 md:px-8 md:py-10">
          <Construction />
        </div>
      </Panel>

      {/* Delar och motivering */}
      <Panel className="flex flex-col gap-6 lg:col-span-5">
        <PanelHeader label="Delar" meta="3 st" />
        <dl className="flex flex-col divide-y divide-line border-y border-line">
          {[
            {
              k: "Ryggrad",
              r: SYMBOL_PARTS.spine,
              d: "Pärmens rygg och stammen i ett gement b. Når textens ascenderhöjd.",
            },
            {
              k: "Kort",
              r: SYMBOL_PARTS.card,
              d: "Ett samlarkort i fickan, b:ets båge. Proportionen 0,7 är kortets egen, 63 × 88 mm. Överkanten ligger på x-höjd.",
            },
            {
              k: "Ring",
              r: SYMBOL_PARTS.ring,
              d: "Fäster kortet i ryggen vid baslinjen och sluter b:et nedtill. Enda elementet i signalfärg; i enfärg får den samma färg som resten och formen är oförändrad.",
            },
          ].map((p) => (
            <div key={p.k} className="grid grid-cols-[88px_1fr] gap-x-4 gap-y-1 py-3">
              <dt className="text-base font-medium">{p.k}</dt>
              <dd className="label tnum text-right text-muted">
                {p.r.w} × {p.r.h}
              </dd>
              <dd className="col-span-2 text-sm text-muted">{p.d}</dd>
            </div>
          ))}
        </dl>
        <p className="text-sm text-muted">
          Bara fyllda ytor och heltalskoordinater, inga linjer: varje kant hamnar på en hel pixel i
          16 px. Vid andra storlekar avrundas kanterna till närmaste pixel.
        </p>
        <dl className="mt-auto grid grid-cols-2 gap-4 border-t border-line pt-4">
          <div>
            <dt className="label text-subtle">Minsta storlek</dt>
            <dd className="tnum mt-1 text-base">{MIN_SYMBOL_PX} px · 4 mm</dd>
          </div>
          <div>
            <dt className="label text-subtle">Friyta X</dt>
            <dd className="tnum mt-1 text-base">½ symbolhöjd</dd>
          </div>
        </dl>
      </Panel>

      {/* Ordmärke med friyta */}
      <Panel padded={false} grid="fine" className="lg:col-span-12">
        <PanelHeader
          label="Ordmärke"
          meta="Symbol / text · −0,03 em"
          className="border-b border-line bg-surface px-4 py-3 md:px-5"
        />
        <div className="flex justify-center overflow-hidden px-4 py-14 md:py-20">
          <div className="relative">
            <CornerMarks inset={-4} />
            <div
              className="relative border border-dashed border-line-strong p-(--clear) md:p-(--clear-xl)"
              style={{ "--clear": `${clearLg}px`, "--clear-xl": `${clearXl}px` } as CSSProperties}
            >
              {(["top", "bottom", "left", "right"] as const).map((side) => (
                <span
                  key={side}
                  aria-hidden
                  className="label absolute text-faint"
                  style={
                    side === "top" || side === "bottom"
                      ? { [side]: -16, left: "50%", transform: "translateX(-50%)" }
                      : { [side]: -14, top: "50%", transform: "translateY(-50%)" }
                  }
                >
                  X
                </span>
              ))}
              <div className="border border-line">
                <span className="block md:hidden">
                  <Wordmark size="lg" />
                </span>
                <span className="hidden md:block">
                  <Wordmark size="xl" />
                </span>
              </div>
            </div>
          </div>
        </div>
        <div className="grid grid-cols-2 border-t border-line bg-surface md:grid-cols-4">
          {(Object.keys(WORDMARK_SIZES) as (keyof typeof WORDMARK_SIZES)[]).map((k, i) => (
            <div
              key={k}
              className={cn(
                "flex flex-col gap-1 px-4 py-3 md:px-5",
                i % 2 === 1 && "border-l border-line",
                i >= 2 && "border-t border-line md:border-t-0",
                i === 2 && "md:border-l",
              )}
            >
              <span className="label text-muted">{k}</span>
              <span className="tnum text-sm">
                {WORDMARK_SIZES[k].symbol} / {WORDMARK_SIZES[k].text}
                {NBSP}px <span className="text-subtle">· {WORDMARK_SIZES[k].use}</span>
              </span>
            </div>
          ))}
        </div>
      </Panel>

      {/* Storlekar */}
      <Panel className="flex flex-col gap-8 lg:col-span-7">
        <PanelHeader label="Symbol i skala" meta="Faktisk storlek" />
        <div className="flex flex-wrap items-end gap-x-8 gap-y-6">
          {[16, 20, 24, 32, 64].map((s) => (
            <figure key={s} className="flex flex-col items-start gap-3">
              <Symbol size={s} className="text-fg" />
              <figcaption className="label tnum text-subtle">{s}</figcaption>
            </figure>
          ))}
        </div>
        <div className="flex flex-wrap items-end gap-8 border-t border-line pt-6">
          <figure className="flex flex-col gap-3">
            <PixelGrid />
            <figcaption className="label tnum text-subtle">16 px · 8×</figcaption>
          </figure>
          <figure className="flex flex-col gap-3">
            <div className="rounded-xs border border-line">
              <RasterPreview
                src="/icon.svg"
                label="Favicon rastrerad i 16 px, förstorad 8 gånger"
              />
            </div>
            <figcaption className="label tnum text-subtle">Favicon 16 px · 8×</figcaption>
          </figure>
          <figure className="flex flex-col gap-3">
            <div className="flex items-center gap-2 rounded-sm border border-line bg-raised px-2.5 py-2">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src="/icon.svg" width={16} height={16} alt="" />
              <span className="text-sm">Hem · Binderlab</span>
            </div>
            <figcaption className="label text-subtle">Flik, faktisk storlek</figcaption>
          </figure>
        </div>
      </Panel>

      {/* Varianter */}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:col-span-5">
        <VariantTile label="Mörk" note="Standard" theme="dark" className="bg-bg" />
        <VariantTile label="Ljus" note="Rapport" theme="light" className="bg-surface" />
        <VariantTile label="Svart" note="1 färg" theme="light" mono className="bg-raised" />
        <VariantTile label="Vit" note="1 färg" theme="dark" mono className="bg-bg" />
      </div>
    </SpecSection>
  );
}
