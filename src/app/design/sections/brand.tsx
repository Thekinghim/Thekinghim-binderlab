import {
  MIN_SYMBOL_PX,
  SIGNAL_RING_MIN_PX,
  SYMBOL_GRID,
  SYMBOL_PARTS,
  Symbol,
  WORDMARK_SIZES,
  Wordmark,
} from "@/components/brand/wordmark";
import { NBSP } from "@/lib/format";
import { SpecSection, Sub } from "./section";

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
        className="font-mono text-[17px] sm:text-label"
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
  // ryggen når ascenderhöjden och kortet x-höjden (se WORDMARK_SIZES).
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
      aria-label={`Konstruktionsritning: rygg ${spine.w} × ${spine.h}, ring ${ring.w} × ${ring.h} och kort ${card.w} × ${card.h} enheter på ett 16-rutnät`}
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
            className="hidden font-mono text-label sm:inline"
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

export function BrandSection({ index }: { index: number }) {
  const n = String(index).padStart(2, "0");
  const parts = [
    {
      k: "Rygg",
      r: SYMBOL_PARTS.spine,
      d: "Pärmens rygg och stammen i ett gement b. Når textens ascenderhöjd.",
    },
    {
      k: "Kort",
      r: SYMBOL_PARTS.card,
      d: "Ett samlarkort i fickan, b:ets båge, i kortets egen proportion 63 × 88 mm.",
    },
    {
      k: "Ring",
      r: SYMBOL_PARTS.ring,
      d: `Fäster kortet vid baslinjen. Signalfärg först från ${SIGNAL_RING_MIN_PX} px (rapporthuvud, omslag), annars textfärg.`,
    },
  ];
  return (
    <SpecSection
      id="varumarke"
      index={index}
      eyebrow="Ordmärke"
      title="Tre rektanglar på ett 16-rutnät."
      aside={`Pixelexakt i 16 px, läsbar från ${MIN_SYMBOL_PX} px.`}
      space="tight"
    >
      <Sub index={`${n}.1`} label="Konstruktion" meta="16 × 16 enheter" className="lg:col-span-6">
        <div className="flex justify-center py-2">
          <Construction />
        </div>
      </Sub>

      <div className="flex min-w-0 flex-col gap-12 lg:col-span-6">
        <Sub index={`${n}.2`} label="Delar" meta={`${parts.length} st`}>
          <dl className="flex flex-col">
            {parts.map((p) => (
              <div
                key={p.k}
                className="grid grid-cols-[64px_56px_minmax(0,1fr)] items-baseline gap-x-4 border-b border-line py-2.5 first:pt-0"
              >
                <dt className="text-base font-medium">{p.k}</dt>
                <dd className="meta tnum text-muted">
                  {p.r.w}
                  {NBSP}×{NBSP}
                  {p.r.h}
                </dd>
                <dd className="text-sm text-muted">{p.d}</dd>
              </div>
            ))}
          </dl>
        </Sub>

        <Sub index={`${n}.3`} label="Storlekar" meta="faktisk storlek">
          <ul className="flex flex-col">
            {(Object.keys(WORDMARK_SIZES) as (keyof typeof WORDMARK_SIZES)[])
              .filter((k) => k !== "xl")
              .map((k) => (
                <li
                  key={k}
                  className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-4 border-b border-line py-3 first:pt-0"
                >
                  <Wordmark size={k} />
                  <span className="meta tnum text-right text-subtle">
                    {WORDMARK_SIZES[k].symbol}
                    {NBSP}px · {WORDMARK_SIZES[k].use}
                  </span>
                </li>
              ))}
            <li className="flex items-end gap-6 pt-4">
              {[12, 16, 24, 32].map((px) => (
                <figure key={px} className="m-0 flex flex-col items-start gap-2">
                  <Symbol size={px} className="text-fg" />
                  <figcaption className="meta tnum text-subtle">{px}</figcaption>
                </figure>
              ))}
            </li>
          </ul>
        </Sub>
      </div>
    </SpecSection>
  );
}
