import { useId } from "react";

import { cn } from "@/lib/cn";
import { DEFAULT_MACHINE_LOOK, type MachineLook } from "@/lib/machine-look";
import { PACK_IMAGES, packInitials, packKey } from "@/lib/pack-image";

import {
  GLYPH_HEIGHT,
  GLYPH_VIEW_H,
  GLYPH_VIEW_W,
  glyphAriaLabel,
  glyphWidth,
  isTinyGlyph,
  screenGrid,
  type GlyphSize,
  type GlyphSlot,
  type GlyphStatus,
  type ScreenCell,
} from "./machine-glyph-model";

export type { GlyphSize, GlyphSlot, GlyphStatus } from "./machine-glyph-model";
export { glyphStatusOf, slotsFromFill } from "./machine-glyph-model";

/**
 * Bilden av en av VÅRA automater (inline SVG): en smal kiosk på svart hjulbas med stor stående
 * pekskärm, lucka under skärmen och ett nedre skåp.
 *
 *   look="stjarnor"  svart med silverkant, gula stjärnor, blå och gula strålar från skärmen,
 *                    ordmärket "binderlab" ovanför skärmen (de flesta butiker)
 *   look="gul"       gul, svart skärm, två fyllda paneler med rund läsare, vit blixt på skåpet
 *
 * Läget visas på skärmen: packbilderna (fack ur Awish) med fyllnadsstapel, tomt fack = grått
 * med röd kant, offline = släckt skärm med wifi-av, fyll på = orange prick, tom = röd prick.
 * I xs och s (≤ 40 px) är skärmen bara en färg. Gult betyder bara "den gula kiosken": läget
 * fyll på är orange, så att en svart automat aldrig ser gul ut i liten storlek. Inga externa bilder utom packbilderna
 * (public/packs, samma som PackImage), och de bara från m (96 px).
 */
export function MachineGlyph({
  look = DEFAULT_MACHINE_LOOK,
  size = "m",
  status = "ok",
  slots,
  name,
  className,
  decorative = false,
}: {
  look?: MachineLook | null;
  size?: GlyphSize;
  status?: GlyphStatus;
  slots?: readonly GlyphSlot[];
  /** Automatens kod eller namn i skärmläsarens text ("BL-001, gul automat. …"). */
  name?: string | null;
  className?: string;
  /** Texten står redan bredvid (t.ex. i en listrad): bilden döljs för skärmläsare. */
  decorative?: boolean;
}) {
  const kind: MachineLook = look ?? DEFAULT_MACHINE_LOOK;
  const height = GLYPH_HEIGHT[size];
  const width = glyphWidth(size);
  const tiny = isTinyGlyph(size);
  // Ritenheter per skärmpixel: linjer hålls minst en pixel breda i alla storlekar.
  const px = GLYPH_VIEW_H / height;
  const uid = useId().replace(/[^a-zA-Z0-9_-]/g, "");
  const label = glyphAriaLabel({ look: kind, status, slots, name });
  const screen = kind === "gul" ? GUL_SCREEN : STAR_SCREEN;

  return (
    <svg
      viewBox={`0 0 ${GLYPH_VIEW_W} ${GLYPH_VIEW_H}`}
      width={width}
      height={height}
      className={cn("v2-mglyph", className)}
      data-look={kind}
      data-status={status}
      data-size={size}
      role={decorative ? undefined : "img"}
      aria-label={decorative ? undefined : label}
      aria-hidden={decorative ? true : undefined}
      focusable="false"
    >
      {decorative ? null : <title>{label}</title>}
      <Base look={kind} px={px} tiny={tiny} />
      {kind === "gul" ? (
        <GulBody uid={uid} px={px} tiny={tiny} size={size} />
      ) : (
        <StarBody uid={uid} px={px} tiny={tiny} size={size} />
      )}
      <Screen
        uid={uid}
        rect={screen}
        look={kind}
        status={status}
        slots={slots}
        size={size}
        px={px}
        tiny={tiny}
      />
    </svg>
  );
}

// ---------------------------------------------------------------------------
// Mått (viewBox 100 × 280, mätta ur ägarens foton)
// ---------------------------------------------------------------------------

interface Box {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

const STAR_UPPER: Box = { x: 4, y: 4, w: 92, h: 164 };
const STAR_LOWER: Box = { x: 6, y: 170, w: 88, h: 86 };
const STAR_SCREEN: Box = { x: 14, y: 23, w: 72, h: 107 };

// Den gula är smalare (1 : 3,3 i fotot).
const GUL_UPPER: Box = { x: 12, y: 4, w: 76, h: 146 };
const GUL_LOWER: Box = { x: 12, y: 152, w: 76, h: 101 };
const GUL_SCREEN: Box = { x: 25, y: 15, w: 50, h: 92 };

/** Färger ur fotona. Bilden är en illustration av en fysisk sak: fasta färger, båda lägen. */
const C = {
  black: "#101013",
  blackEdge: "#4B4B52",
  trim: "#D4D6DB",
  trimShade: "#9EA1A8",
  star: "#F7D21B",
  ray: "#2F5FE0",
  rayYellow: "#F2CE1A",
  brandBlue: "#2F6BFF",
  yellow: "#F8CF1C",
  yellowShade: "#E7BC0E",
  yellowEdge: "#B38F00",
  screenOn: "#0F1630",
  screenOff: "#050507",
  screenTinyOk: "#3A62D8",
  cellBg: "#1B2546",
  track: "#2E3A63",
  bar: "#E9EDF7",
  warn: "#FFB800",
  /** Fyll på: orange, inte gul (gult = den gula kiosken). */
  refill: "#FF7A00",
  crit: "#E22C38",
  wheel: "#6B6E75",
  wheelHub: "#C9CBD0",
} as const;

// ---------------------------------------------------------------------------
// Bas med hjul
// ---------------------------------------------------------------------------

function Base({ look, px, tiny }: { look: MachineLook; px: number; tiny: boolean }) {
  const edge = Math.max(0.8, px);
  const plate =
    look === "gul"
      ? { x: 8, y: 253, w: 84, h: 11, fill: C.yellow, stroke: C.yellowEdge }
      : { x: 3, y: 256, w: 94, h: 9, fill: C.black, stroke: C.blackEdge };
  return (
    <g>
      {(look === "gul" ? [20, 80] : [16, 84]).map((cx) => (
        <g key={cx}>
          {tiny ? null : (
            <rect x={cx - 3} y={plate.y + plate.h} width={6} height={4} fill={C.wheel} />
          )}
          <circle cx={cx} cy={272} r={tiny ? 7 : 6} fill={C.wheel} />
          {tiny ? null : <circle cx={cx} cy={272} r={2.2} fill={C.wheelHub} />}
        </g>
      ))}
      <rect
        x={plate.x}
        y={plate.y}
        width={plate.w}
        height={plate.h}
        rx={2}
        fill={plate.fill}
        stroke={plate.stroke}
        strokeWidth={edge}
      />
    </g>
  );
}

// ---------------------------------------------------------------------------
// Svart med stjärnor
// ---------------------------------------------------------------------------

/** Femuddig stjärna kring (cx, cy). */
function starPath(cx: number, cy: number, r: number, turn = 0): string {
  const pts: string[] = [];
  for (let i = 0; i < 10; i++) {
    const rad = i % 2 === 0 ? r : r * 0.42;
    const a = ((-90 + turn + i * 36) * Math.PI) / 180;
    pts.push(`${(cx + rad * Math.cos(a)).toFixed(2)} ${(cy + rad * Math.sin(a)).toFixed(2)}`);
  }
  return `M${pts.join("L")}Z`;
}

/** Kil från (cx, cy) i vinkeln `deg` (0 = höger, medurs), `spread` grader bred. */
function rayPath(cx: number, cy: number, deg: number, spread: number, len = 260): string {
  const a1 = ((deg - spread / 2) * Math.PI) / 180;
  const a2 = ((deg + spread / 2) * Math.PI) / 180;
  return `M${cx} ${cy}L${(cx + len * Math.cos(a1)).toFixed(2)} ${(cy + len * Math.sin(a1)).toFixed(2)}L${(cx + len * Math.cos(a2)).toFixed(2)} ${(cy + len * Math.sin(a2)).toFixed(2)}Z`;
}

// Strålarna i fotot: gula kilar upp till höger och ner till vänster, tunna blå runt om.
const UPPER_RAYS: readonly (readonly [number, number, "b" | "y"])[] = [
  [-62, 5, "y"],
  [-38, 2.2, "b"],
  [-14, 1.6, "b"],
  [12, 2, "b"],
  [38, 1.6, "b"],
  [66, 2.4, "b"],
  [118, 2.4, "b"],
  [134, 5.5, "y"],
  [158, 1.8, "b"],
  [186, 1.6, "b"],
  [208, 2.2, "b"],
  [232, 1.8, "b"],
  [-104, 2, "b"],
];
// Skåpet: en bred gul kil ner till vänster och några blå ner till höger (fotot).
const LOWER_RAYS: readonly (readonly [number, number, "b" | "y"])[] = [
  [126, 6, "y"],
  [64, 3.4, "b"],
  [46, 2, "b"],
  [104, 1.6, "b"],
];

// Stjärnorna (x, y, radie) runt skärmen och på skåpet, ungefär som på fotot.
const UPPER_STARS: readonly (readonly [number, number, number])[] = [
  [9.5, 13, 3.4],
  [90.5, 13, 3],
  [9, 40, 2.6],
  [91, 34, 2.2],
  [9, 62, 3],
  [91, 58, 3.2],
  [9, 84, 2.2],
  [91, 82, 2.4],
  [9, 104, 3],
  [91, 106, 3.4],
  [9, 124, 2],
  [91, 128, 2.4],
  [12, 146, 3.6],
  [28, 138, 2],
  [36, 158, 2.6],
  [64, 160, 2],
  [84, 140, 2],
  [88, 152, 3.4],
  [24, 160, 1.6],
  [80, 162, 1.8],
];
const LOWER_STARS: readonly (readonly [number, number, number])[] = [
  [14, 180, 2],
  [30, 192, 3.2],
  [54, 186, 2.2],
  [74, 182, 2.6],
  [86, 196, 3.6],
  [16, 212, 2.6],
  [44, 208, 2],
  [62, 216, 3],
  [80, 226, 2.2],
  [24, 236, 3.4],
  [50, 240, 2.4],
  [70, 246, 2],
  [88, 244, 3],
  [36, 224, 1.6],
  [12, 196, 1.4],
  [40, 176, 1.4],
  [64, 198, 1.6],
  [88, 214, 1.4],
  [56, 230, 1.4],
  [30, 250, 1.4],
  [80, 254, 1.2],
  [72, 172, 1.2],
];
// Små storlekar: färre och större stjärnor, så att de syns som stjärnor och inte som brus.
const TINY_STARS: readonly (readonly [number, number, number])[] = [
  [11, 150, 9],
  [86, 152, 7],
  [26, 206, 10],
  [74, 236, 9],
  [70, 190, 6],
];

function StarBody({
  uid,
  px,
  tiny,
  size,
}: {
  uid: string;
  px: number;
  tiny: boolean;
  size: GlyphSize;
}) {
  const U = STAR_UPPER;
  const L = STAR_LOWER;
  const S = STAR_SCREEN;
  const trim = Math.max(2.4, 1.1 * px);
  const edge = Math.max(0.8, px);
  const cx = S.x + S.w / 2;
  const cy = S.y + S.h / 2;
  const hatch = { x: 32, y: 139, w: 14, h: 14 };
  const reader = { x: 54, y: 137, w: 14, h: 18 };
  const upperClip = `${uid}-su`;
  const lowerClip = `${uid}-sl`;
  const rays = tiny
    ? UPPER_RAYS.filter(([, , c]) => c === "y").map(([d, w, c]) => [d, w * 1.6, c] as const)
    : UPPER_RAYS;
  const lowerRays = tiny ? LOWER_RAYS.filter(([, , c]) => c === "y") : LOWER_RAYS;
  return (
    <g>
      <defs>
        <clipPath id={upperClip}>
          <rect x={U.x} y={U.y} width={U.w} height={U.h} rx={9} />
        </clipPath>
        <clipPath id={lowerClip}>
          <rect x={L.x} y={L.y} width={L.w} height={L.h} rx={5} />
        </clipPath>
      </defs>

      {/* Nedre skåpet */}
      <rect
        x={L.x}
        y={L.y}
        width={L.w}
        height={L.h}
        rx={5}
        fill={C.black}
        stroke={C.blackEdge}
        strokeWidth={edge}
      />
      <g clipPath={`url(#${lowerClip})`}>
        {lowerRays.map(([deg, spread, c]) => (
          <path
            key={`l${deg}`}
            d={rayPath(50, L.y - 6, deg, spread)}
            fill={c === "y" ? C.rayYellow : C.ray}
          />
        ))}
        {(tiny ? TINY_STARS.filter(([, y]) => y > L.y) : LOWER_STARS).map(([x, y, r]) => (
          <path key={`ls${x}-${y}`} d={starPath(x, y, r, (x * 7) % 30)} fill={C.star} />
        ))}
      </g>

      {/* Övre delen: silverkanten syns mest på höger sida och undertill (fotot) */}
      <rect x={U.x} y={U.y} width={U.w + 1.2} height={U.h + 1.6} rx={9.5} fill={C.trimShade} />
      <rect
        x={U.x}
        y={U.y}
        width={U.w}
        height={U.h}
        rx={9}
        fill={C.black}
        stroke={C.trim}
        strokeWidth={trim}
      />
      <g clipPath={`url(#${upperClip})`}>
        {rays.map(([deg, spread, c]) => (
          <path
            key={`u${deg}`}
            d={rayPath(cx, cy, deg, spread)}
            fill={c === "y" ? C.rayYellow : C.ray}
          />
        ))}
        {(tiny ? TINY_STARS.filter(([, y]) => y < U.y + U.h) : UPPER_STARS).map(([x, y, r]) => (
          <path key={`us${x}-${y}`} d={starPath(x, y, r, (y * 3) % 30)} fill={C.star} />
        ))}
      </g>
      {/* Kanten igen, ovanpå strålarna */}
      <rect
        x={U.x}
        y={U.y}
        width={U.w}
        height={U.h}
        rx={9}
        fill="none"
        stroke={C.trim}
        strokeWidth={trim}
      />

      {/* Ordmärket ovanför skärmen */}
      {tiny ? null : size === "m" ? (
        <rect x={34} y={12.5} width={32} height={4.5} rx={1} fill="#F4F4F6" />
      ) : (
        <text
          x={50}
          y={19.2}
          textAnchor="middle"
          fontSize={11.5}
          fontWeight={700}
          letterSpacing={-0.3}
          style={{
            fontFamily:
              'var(--font-google-sans), "Google Sans", system-ui, -apple-system, sans-serif',
          }}
        >
          <tspan fill="#FFFFFF">binder</tspan>
          <tspan fill={C.brandBlue}>lab</tspan>
        </text>
      )}

      {/* Kortläsaren till höger om luckan (fotot): ram, liten skärm och kortspringa */}
      {tiny ? null : (
        <g>
          <rect
            x={reader.x}
            y={reader.y}
            width={reader.w}
            height={reader.h}
            rx={2}
            fill="#1C1C21"
            stroke={C.trimShade}
            strokeWidth={Math.max(0.6, 0.6 * px)}
          />
          <rect
            x={reader.x + 2.5}
            y={reader.y + 2.5}
            width={reader.w - 5}
            height={6}
            rx={0.8}
            fill="#2C4FB8"
          />
          <rect
            x={reader.x + 2.5}
            y={reader.y + reader.h - 4.5}
            width={reader.w - 5}
            height={1.6}
            rx={0.8}
            fill="#050506"
          />
        </g>
      )}

      {/* Luckan under skärmen */}
      {tiny ? null : (
        <rect
          x={hatch.x}
          y={hatch.y}
          width={hatch.w}
          height={hatch.h}
          rx={1.5}
          fill="#050506"
          stroke="#2C2C31"
          strokeWidth={Math.max(0.6, 0.6 * px)}
        />
      )}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Gul
// ---------------------------------------------------------------------------

/** Vit blixtkrans bakom mitten av skåpet (som på fotot, utan figurer eller loggor). */
function burstPath(cx: number, cy: number): string {
  // Oregelbundna spetsar: lång, kort, lång … så att den ser ritad ut, inte som en stjärna.
  const radii = [38, 20, 33, 18, 42, 21, 31, 17, 39, 20, 35, 19, 43, 20, 30, 18];
  const pts = radii.map((r, i) => {
    const a = ((i * 360) / radii.length - 80) * (Math.PI / 180);
    return `${(cx + r * Math.cos(a)).toFixed(2)} ${(cy + r * 0.92 * Math.sin(a)).toFixed(2)}`;
  });
  return `M${pts.join("L")}Z`;
}

/** Sicksackblixt från (x, y) i riktningen `deg`. */
function boltPath(x: number, y: number, deg: number, len: number): string {
  const a = (deg * Math.PI) / 180;
  const n = (deg + 90) * (Math.PI / 180);
  const step = len / 4;
  const jag = len * 0.16;
  const pts: string[] = [];
  for (let i = 0; i <= 4; i++) {
    const side = i === 0 || i === 4 ? 0 : i % 2 === 0 ? -jag : jag;
    pts.push(
      `${(x + step * i * Math.cos(a) + side * Math.cos(n)).toFixed(2)} ${(y + step * i * Math.sin(a) + side * Math.sin(n)).toFixed(2)}`,
    );
  }
  return `M${pts.join("L")}`;
}

function GulBody({
  uid,
  px,
  tiny,
  size,
}: {
  uid: string;
  px: number;
  tiny: boolean;
  size: GlyphSize;
}) {
  const U = GUL_UPPER;
  const L = GUL_LOWER;
  const edge = Math.max(0.8, px);
  const lowerClip = `${uid}-gl`;
  const bcx = 50;
  const bcy = L.y + L.h * 0.52;
  const big = size === "l" || size === "xl";
  return (
    <g>
      <defs>
        <clipPath id={lowerClip}>
          <rect x={L.x} y={L.y} width={L.w} height={L.h} rx={3} />
        </clipPath>
      </defs>

      {/* Nedre skåpet med vit blixt */}
      <rect
        x={L.x}
        y={L.y}
        width={L.w}
        height={L.h}
        rx={3}
        fill={C.yellow}
        stroke={C.yellowEdge}
        strokeWidth={edge}
      />
      <g clipPath={`url(#${lowerClip})`}>
        <path
          d={burstPath(bcx, bcy)}
          fill="#FCE27A"
          stroke="#FFFFFF"
          strokeWidth={tiny ? Math.max(3, 1.2 * px) : 2.6}
          strokeLinejoin="miter"
        />
        {tiny ? null : (
          <g fill="none" stroke="#FFFFFF" strokeWidth={2.4} strokeLinejoin="miter">
            <path d={boltPath(24, 166, 210, 12)} />
            <path d={boltPath(76, 164, -30, 12)} />
            <path d={boltPath(22, 226, 165, 10)} />
            <path d={boltPath(78, 238, 15, 10)} />
          </g>
        )}
        {/* Blixten i mitten */}
        <path
          d="M54 182 L42 206 L49.5 206 L44.5 228 L60 200 L52 200 L57.5 182 Z"
          fill="#FFFFFF"
          stroke={C.yellowEdge}
          strokeWidth={tiny ? 0 : 0.8}
          strokeLinejoin="round"
        />
      </g>
      {/* Gångjärnsbandet mellan delarna */}
      <rect x={L.x} y={U.y + U.h} width={L.w} height={2} fill={C.trimShade} />

      {/* Övre delen */}
      <rect
        x={U.x}
        y={U.y}
        width={U.w}
        height={U.h}
        rx={6}
        fill={C.yellow}
        stroke={C.yellowEdge}
        strokeWidth={edge}
      />
      {/* Två försänkta paneler; läsaren (rund, svart) på den högra */}
      {tiny ? null : (
        <g>
          <rect
            x={18}
            y={116}
            width={26}
            height={27}
            rx={3}
            fill={C.yellowShade}
            stroke={C.yellowEdge}
            strokeWidth={Math.max(0.6, 0.7 * px)}
            strokeOpacity={0.55}
          />
          <rect
            x={47.5}
            y={116}
            width={34.5}
            height={27}
            rx={3}
            fill={C.yellowShade}
            stroke={C.yellowEdge}
            strokeWidth={Math.max(0.6, 0.7 * px)}
            strokeOpacity={0.55}
          />
          <circle cx={73.5} cy={129.5} r={7.4} fill={C.trim} />
          <circle cx={73.5} cy={129.5} r={6.2} fill="#0B0B0D" />
        </g>
      )}
      {/* Skruvarna på sidorna (fotot) */}
      {big ? (
        <g fill={C.trim} stroke={C.trimShade} strokeWidth={0.5}>
          <rect x={9.6} y={21} width={2.6} height={4} rx={1} />
          <rect x={87.8} y={21} width={2.6} height={4} rx={1} />
          <rect x={9.6} y={148} width={2.6} height={4} rx={1} />
          <rect x={87.8} y={148} width={2.6} height={4} rx={1} />
        </g>
      ) : null}
    </g>
  );
}

// ---------------------------------------------------------------------------
// Skärmen: läget och packen
// ---------------------------------------------------------------------------

const TINY_SCREEN_FILL: Readonly<Record<GlyphStatus, string>> = {
  ok: C.screenTinyOk,
  refill: C.refill,
  empty: C.crit,
  offline: "#26262B",
};

function Screen({
  uid,
  rect,
  look,
  status,
  slots,
  size,
  px,
  tiny,
}: {
  uid: string;
  rect: Box;
  look: MachineLook;
  status: GlyphStatus;
  slots: readonly GlyphSlot[] | undefined;
  size: GlyphSize;
  px: number;
  tiny: boolean;
}) {
  const { x, y, w, h } = rect;
  if (tiny) {
    return (
      <g>
        <rect
          x={x}
          y={y}
          width={w}
          height={h}
          rx={2}
          fill={TINY_SCREEN_FILL[status]}
          // Den gula har svart ram runt skärmen (fotot).
          stroke={look === "gul" ? "#101013" : status === "offline" ? "#5A5A61" : "none"}
          strokeWidth={look === "gul" ? 1.6 * px : px}
        />
        {status === "offline" ? (
          <path
            d={`M${x + w * 0.22} ${y + h * 0.72}L${x + w * 0.78} ${y + h * 0.28}`}
            stroke="#9A9AA2"
            strokeWidth={1.4 * px}
            strokeLinecap="round"
          />
        ) : null}
      </g>
    );
  }

  const offline = status === "offline";
  const grid = offline ? null : screenGrid(size, slots);
  // Överst på skärmen en rad som i kioskens gränssnitt: rubrikstreck och lägets prick.
  const dotR = Math.max(2.6, 2.2 * px);
  const headH = 2 * dotR + 4;
  const body: Box = { x, y: y + headH, w, h: h - headH };
  return (
    <g>
      <rect
        x={x}
        y={y}
        width={w}
        height={h}
        rx={1.6}
        fill={offline ? C.screenOff : C.screenOn}
        stroke="#000000"
        strokeWidth={Math.max(0.8, 0.8 * px)}
      />
      {offline ? (
        <OfflineBadge cx={x + w / 2} cy={y + h / 2} r={Math.min(w, h) * 0.22} />
      ) : (
        <g>
          <rect
            x={x + 3}
            y={y + headH / 2 - Math.max(1, 0.6 * px)}
            width={w * 0.34}
            height={Math.max(2, 1.2 * px)}
            rx={Math.max(1, 0.6 * px)}
            fill="#33407A"
          />
          {grid && grid.cells.length > 0 ? (
            <PackGrid uid={uid} rect={body} grid={grid} px={px} />
          ) : (
            <IdleScreen rect={body} />
          )}
        </g>
      )}
      {/* Fyll på / tom: prick uppe till höger (formen bärs också av rutorna och texten) */}
      {status === "refill" || status === "empty" ? (
        <circle
          cx={x + w - dotR - 2.5}
          cy={y + headH / 2 + 0.5}
          r={dotR}
          fill={status === "refill" ? C.refill : C.crit}
        />
      ) : null}
      {/* Glansen i glaset (fotot på den gula) */}
      {offline ? (
        <path
          d={`M${x + w * 0.55} ${y}L${x + w} ${y}L${x + w} ${y + h * 0.35}Z`}
          fill="#FFFFFF"
          opacity={0.05}
        />
      ) : null}
    </g>
  );
}

/** Skärmen utan fackdata: en lugn startskärm (fyra rutor), inte tom. */
function IdleScreen({ rect }: { rect: Box }) {
  const p = 3;
  const g = 4;
  const cw = (rect.w - 2 * p - g) / 2;
  const ch = (rect.h - 2 * p - g) / 2;
  return (
    <g fill={C.cellBg}>
      {[0, 1, 2, 3].map((i) => (
        <rect
          key={i}
          x={rect.x + p + (i % 2) * (cw + g)}
          y={rect.y + p + Math.floor(i / 2) * (ch + g)}
          width={cw}
          height={ch}
          rx={1.5}
        />
      ))}
    </g>
  );
}

function OfflineBadge({ cx, cy, r }: { cx: number; cy: number; r: number }) {
  const s = r / 10;
  return (
    <g>
      <circle cx={cx} cy={cy} r={r} fill="#1C1C21" stroke="#3A3A41" strokeWidth={0.8} />
      <g
        fill="none"
        stroke="#B9B9C0"
        strokeWidth={1.3 * s}
        strokeLinecap="round"
        transform={`translate(${cx} ${cy + 1.5 * s})`}
      >
        <path d={`M${-6 * s} ${-2.5 * s}A${8.5 * s} ${8.5 * s} 0 0 1 ${6 * s} ${-2.5 * s}`} />
        <path d={`M${-3.4 * s} ${0.6 * s}A${4.8 * s} ${4.8 * s} 0 0 1 ${3.4 * s} ${0.6 * s}`} />
        <circle cx={0} cy={3.6 * s} r={0.6 * s} fill="#B9B9C0" />
        <path d={`M${-6.5 * s} ${-7 * s}L${6.5 * s} ${6 * s}`} stroke="#E22C38" />
      </g>
    </g>
  );
}

function PackGrid({
  uid,
  rect,
  grid,
  px,
}: {
  uid: string;
  rect: Box;
  grid: ReturnType<typeof screenGrid>;
  px: number;
}) {
  const pad = 3;
  const gap = 2.6;
  // rect börjar under rubrikraden: ingen extra luft upptill.
  const cw = (rect.w - 2 * pad - (grid.cols - 1) * gap) / grid.cols;
  const ch = (rect.h - 2 * pad - (grid.rows - 1) * gap) / grid.rows;
  const barH = Math.max(2.2, 2 * px);
  const greyId = `${uid}-grey`;
  const cells: (ScreenCell | "more")[] = [...grid.cells];
  if (grid.more > 0) cells.push("more");
  return (
    <g>
      <defs>
        <filter id={greyId} colorInterpolationFilters="sRGB">
          <feColorMatrix type="saturate" values="0" />
        </filter>
      </defs>
      {cells.map((cell, i) => {
        const cx = rect.x + pad + (i % grid.cols) * (cw + gap);
        const cy = rect.y + pad + Math.floor(i / grid.cols) * (ch + gap);
        if (cell === "more") {
          return (
            <g key="more">
              <rect x={cx} y={cy} width={cw} height={ch} rx={1.4} fill={C.cellBg} />
              <text
                x={cx + cw / 2}
                y={cy + ch / 2}
                textAnchor="middle"
                dominantBaseline="central"
                fontSize={Math.min(cw, ch) * 0.34}
                fontWeight={600}
                fill="#C9D1E8"
                style={{ fontFamily: "var(--font-google-sans), system-ui, sans-serif" }}
              >
                +{grid.more}
              </text>
            </g>
          );
        }
        return (
          <Cell
            key={`${cell.title}-${i}`}
            cell={cell}
            x={cx}
            y={cy}
            w={cw}
            h={ch}
            barH={barH}
            px={px}
            greyId={greyId}
          />
        );
      })}
    </g>
  );
}

function Cell({
  cell,
  x,
  y,
  w,
  h,
  barH,
  px,
  greyId,
}: {
  cell: ScreenCell;
  x: number;
  y: number;
  w: number;
  h: number;
  barH: number;
  px: number;
  greyId: string;
}) {
  const barGap = Math.max(1.2, 0.8 * px);
  const imgH = h - barH - barGap - 1;
  const key = packKey(cell.title);
  const [iw, ih] = key ? PACK_IMAGES[key] : [131, 240];
  const aspect = iw / ih;
  // Bilden så stor som rutan tillåter, centrerad.
  const dispH = Math.min(imgH, (w - 1) / aspect);
  const dispW = dispH * aspect;
  const ix = x + (w - dispW) / 2;
  const iy = y + (imgH - dispH) / 2 + 0.5;
  const barColor =
    cell.tone === "empty"
      ? C.crit
      : cell.tone === "low"
        ? C.warn
        : cell.tone === "ok"
          ? C.bar
          : C.track;
  const fill = cell.fill ?? 0;
  const unknown = cell.tone === "unknown";
  return (
    <g>
      {/* Okänd fyllnad (ingen Awish-läsning): blekt, med "?" över bilden. */}
      <g
        opacity={cell.empty ? 0.38 : unknown ? 0.32 : 1}
        filter={cell.empty || unknown ? `url(#${greyId})` : undefined}
      >
        {key ? (
          <image
            href={`/packs/${key}.webp`}
            x={ix}
            y={iy}
            width={dispW}
            height={dispH}
            preserveAspectRatio="xMidYMid meet"
          />
        ) : (
          <g>
            <rect x={ix} y={iy} width={dispW} height={dispH} rx={1} fill="#3A4366" />
            <text
              x={ix + dispW / 2}
              y={iy + dispH / 2}
              textAnchor="middle"
              dominantBaseline="central"
              fontSize={Math.min(dispW * 0.42, 9)}
              fontWeight={600}
              fill="#DDE3F5"
              style={{ fontFamily: "var(--font-google-sans), system-ui, sans-serif" }}
            >
              {packInitials(cell.title)}
            </text>
          </g>
        )}
      </g>
      {unknown ? (
        <text
          x={ix + dispW / 2}
          y={iy + dispH / 2}
          textAnchor="middle"
          dominantBaseline="central"
          fontSize={Math.min(dispW * 0.7, dispH * 0.5)}
          fontWeight={700}
          fill="#DDE3F5"
          style={{ fontFamily: "var(--font-google-sans), system-ui, sans-serif" }}
        >
          ?
        </text>
      ) : null}
      {cell.empty ? (
        <rect
          x={ix - 0.8}
          y={iy - 0.8}
          width={dispW + 1.6}
          height={dispH + 1.6}
          rx={1.4}
          fill="none"
          stroke={C.crit}
          strokeWidth={Math.max(1, 0.9 * px)}
        />
      ) : null}
      {/* Fyllnaden */}
      <rect x={x + 1} y={y + h - barH} width={w - 2} height={barH} rx={barH / 2} fill={C.track} />
      {fill > 0 ? (
        <rect
          x={x + 1}
          y={y + h - barH}
          width={Math.max(barH, (w - 2) * fill)}
          height={barH}
          rx={barH / 2}
          fill={barColor}
        />
      ) : cell.empty ? (
        <rect x={x + 1} y={y + h - barH} width={barH} height={barH} rx={barH / 2} fill={C.crit} />
      ) : null}
    </g>
  );
}
