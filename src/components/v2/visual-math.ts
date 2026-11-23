/**
 * Ren logik bakom de visuella byggstenarna (ProgressRing, StoreFace, PackFan, PackStack,
 * ProfitBar). Inga React-beroenden, så att den testas för sig (visual-math.test.ts).
 */

/* ------------------------------------------------------------------ Målring */

/** Ringens mått i viewBox 0 0 150 150 (samma som mocken på Hem). */
export const RING = { box: 150, cx: 75, r: 62, stroke: 13 } as const;

export type RingInput = {
  /** Utfallet hittills (samma enhet som goal). */
  value: number;
  goal: number;
  /** Där takten säger att man borde vara i dag (samma enhet). Ger en markör på ringen. */
  pace?: number | null;
  /** Prognos vid periodens slut (samma enhet). Ger en streckad båge efter utfallet. */
  forecast?: number | null;
};

export type RingGeometry = {
  /** Omkrets för r. */
  c: number;
  /** Utfallets andel av målet, 0–1 (klämd). */
  result: number;
  /** stroke-dasharray för utfallsbågen, eller null när utfallet är 0. */
  resultDash: string | null;
  /** SVG-path för den streckade prognosbågen, eller null när prognosen inte går längre än utfallet. */
  forecastPath: string | null;
  /** Takt-markören tvärs över ringen, eller null utan takt. */
  paceTick: { x1: number; y1: number; x2: number; y2: number } | null;
  /** Utfallet i hela procent av målet, oklämt (kan vara över 100), eller null utan mål. */
  percent: number | null;
  /** Målet nått. */
  reached: boolean;
};

const clamp01 = (x: number) => (Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : 0);
const r2 = (x: number) => Math.round(x * 100) / 100;

/** Punkt på ringen för andel t (0 = överst när svg:n är vriden −90°, medurs). */
function at(t: number, r: number): [number, number] {
  const a = t * 2 * Math.PI;
  return [r2(RING.cx + r * Math.cos(a)), r2(RING.cx + r * Math.sin(a))];
}

/** Liten lucka mellan utfallets runda ände och prognosbågen. */
const FORECAST_GAP = 0.012;
/** En båge kan inte gå hela varvet runt med A-kommandot: stanna strax före. */
const MAX_ARC = 0.999;

export function ringGeometry({ value, goal, pace, forecast }: RingInput): RingGeometry {
  const { r } = RING;
  const c = 2 * Math.PI * r;
  if (!(goal > 0)) {
    return {
      c,
      result: 0,
      resultDash: null,
      forecastPath: null,
      paceTick: null,
      percent: null,
      reached: false,
    };
  }
  const result = clamp01(value / goal);
  const resultDash = result > 0 ? `${r2(c * result)} ${r2(c)}` : null;

  let forecastPath: string | null = null;
  if (forecast != null && result < 1) {
    const from = Math.min(result + (result > 0 ? FORECAST_GAP : 0), MAX_ARC);
    const to = Math.min(clamp01(forecast / goal), MAX_ARC);
    if (to - from > 0.005) {
      const [sx, sy] = at(from, r);
      const [ex, ey] = at(to, r);
      const large = to - from > 0.5 ? 1 : 0;
      forecastPath = `M${sx},${sy}A${r},${r} 0 ${large} 1 ${ex},${ey}`;
    }
  }

  let paceTick: RingGeometry["paceTick"] = null;
  if (pace != null && Number.isFinite(pace)) {
    const t = clamp01(pace / goal);
    const [x1, y1] = at(t, r - 10);
    const [x2, y2] = at(t, r + 10);
    paceTick = { x1, y1, x2, y2 };
  }

  return {
    c,
    result,
    resultDash,
    forecastPath,
    paceTick,
    percent: Number.isFinite(value) ? Math.round((value / goal) * 100) : null,
    reached: value >= goal,
  };
}

/* ---------------------------------------------------------------- Butikssymbol */

export type StoreGlyph =
  "card" | "dice" | "bag" | "reel" | "pin" | "blocks" | "kiosk" | "book" | "wave" | "fuel" | "game";

/**
 * Nyckelord i butikstypen (fri text, t.ex. "Serie- och spelbutik", "livs", "Biograf") → symbol.
 * Första träffen vinner, så de mer specifika orden står först.
 */
const GLYPH_RULES: ReadonlyArray<readonly [RegExp, StoreGlyph]> = [
  [/rollspel|brädspel|bradspel|sällskapsspel|sallskapsspel/, "dice"],
  [/kort|tcg|serie|samlar/, "card"],
  [/spel(?!hall)|gaming|game/, "game"],
  [/bio|film/, "reel"],
  [/bowling|nöje|noje|spelhall|arkad|kägel|kagel/, "pin"],
  [/leksak|lek/, "blocks"],
  [/köpcentr|kopcentr|galleria|varuhus|center|centrum/, "bag"],
  [/bok|bibliotek/, "book"],
  [/bad|sim|fritid|sport|gym|ishall/, "wave"],
  [/bensin|mack|tank|station/, "fuel"],
  [/kiosk|livs|butik|pressbyr|tobak|närbutik|narbutik|handel|ica|coop/, "kiosk"],
];

/** Symbol för butikstypen, eller null (då visas initialer). */
export function storeGlyph(storeType: string | null | undefined): StoreGlyph | null {
  const t = storeType?.trim().toLowerCase();
  if (!t) return null;
  for (const [re, g] of GLYPH_RULES) if (re.test(t)) return g;
  return null;
}

/** Två bokstäver ur butiksnamnet: "Köpcentrum Kvarnhagen" → "KK", "Lekboden" → "LE". */
export function storeInitials(name: string | null | undefined): string {
  const words = (name ?? "")
    .split(/[\s\-–·,.&/]+/)
    .map((w) => w.replace(/[^\p{L}\p{N}]/gu, ""))
    .filter(Boolean);
  if (words.length === 0) return "?";
  if (words.length === 1) return words[0]!.slice(0, 2).toLocaleUpperCase("sv-SE");
  return (words[0]![0]! + words[1]![0]!).toLocaleUpperCase("sv-SE");
}

/**
 * Stadsfärger: [bakgrund, symbol]. Ljusa toner med en mörk symbol i samma kulör, kontrast ≥ 4,5:1.
 * Samma stad får alltid samma färg (hash av namnet), utan stad blir det neutralt grått.
 */
export const CITY_TONES: ReadonlyArray<readonly [string, string]> = [
  ["#e3ebff", "#3550c8"], // blå
  ["#dcf3ee", "#0f6b5c"], // grön-turkos
  ["#ffefd2", "#8a5200"], // bärnsten
  ["#e6f2fa", "#1f6690"], // havsblå
  ["#eee6ff", "#6a3fc4"], // lila
  ["#e2f4dc", "#2f7a23"], // grön
  ["#fde7ef", "#a3285a"], // hallon
  ["#ffe6dc", "#a3401c"], // korall
];
export const NEUTRAL_TONE = ["#efefef", "#5a5a5a"] as const;

/** FNV-1a över normaliserat namn: stabil mellan körningar och miljöer. */
export function hashString(s: string): number {
  let h = 0x811c9dc5;
  for (const ch of s) {
    h ^= ch.codePointAt(0)!;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

export function cityTone(city: string | null | undefined): readonly [string, string] {
  const c = city?.trim().toLocaleLowerCase("sv-SE");
  if (!c) return NEUTRAL_TONE;
  return CITY_TONES[hashString(c) % CITY_TONES.length]!;
}

export type StoreFaceChoice = {
  glyph: StoreGlyph | null;
  initials: string;
  bg: string;
  fg: string;
};

export function storeFace(input: {
  name: string | null | undefined;
  storeType?: string | null;
  city?: string | null;
}): StoreFaceChoice {
  const [bg, fg] = cityTone(input.city);
  return { glyph: storeGlyph(input.storeType), initials: storeInitials(input.name), bg, fg };
}

/* ---------------------------------------------------------------- Packsolfjäder */

export type FanSlot = {
  /** Förskjutning i sidled i procent av packens egen bredd. */
  x: number;
  /** Lyft uppåt i px (negativt = upp). */
  y: number;
  /** Vridning i grader. */
  rotate: number;
  /** Skala (mittenpacket lite större vid udda antal). */
  scale: number;
  z: number;
  /** Lätt mörkare ju längre ut, så mitten läses som främst. */
  dim: number;
};

/** Hur många pack solfjädern visar som mest. */
export const FAN_MAX = 5;

/**
 * Solfjäderns lägen för n pack (1–5), i ordning vänster → höger. Symmetrisk runt mitten,
 * mitten överst; tre pack ger mockens ±52 % och ±8°, fyra–fem tätare (±7° per steg).
 */
export function fanLayout(n: number): FanSlot[] {
  const count = Math.max(0, Math.min(FAN_MAX, Math.floor(n)));
  if (count === 0) return [];
  const step = count <= 3 ? 52 : 46;
  const rot = count <= 3 ? 8 : 7;
  const mid = (count - 1) / 2;
  return Array.from({ length: count }, (_, i) => {
    const o = i - mid;
    const d = Math.abs(o);
    const center = d === 0;
    return {
      x: r2(o * step),
      y: center && count >= 3 ? -6 : r2(d * d * 1.5),
      rotate: r2(o * rot),
      scale: center && count >= 3 ? 1.08 : 1,
      z: 10 - Math.ceil(d),
      dim: center ? 1 : r2(1 - 0.03 * Math.ceil(d)),
    };
  });
}

/**
 * Solfjäderns bredd i packbredder (för behållaren): mitten plus det yttersta packets
 * förskjutning åt båda håll, plus lite luft för vridningen.
 */
export function fanWidthInPacks(n: number): number {
  const slots = fanLayout(n);
  if (slots.length === 0) return 0;
  const maxX = Math.max(...slots.map((s) => Math.abs(s.x))) / 100;
  return r2(1 + 2 * maxX + (slots.length > 1 ? 0.25 : 0));
}

/* ---------------------------------------------------------------- Packhög */

/**
 * Hur många kopior bakom packet en hög visar för ett antal hemma: fler pack = tjockare hög,
 * men aldrig mer än fyra. Gränserna är mockens (Vårt lager).
 */
export function stackDepth(count: number | null | undefined): number {
  const n = count ?? 0;
  if (!(n >= 20)) return 0;
  if (n < 60) return 1;
  if (n < 120) return 2;
  if (n < 200) return 3;
  return 4;
}

/* ---------------------------------------------------------------- Vinststapel */

export type ProfitBarParts = {
  /** Stapelns längd i procent av skalan (0–100). */
  widthPct: number;
  /** Inköpsdelens andel av stapeln (0–100). null = okänt inköp. */
  costPct: number | null;
  /** Vinstdelens andel av stapeln (0–100). null = okänt inköp. */
  profitPct: number | null;
  /** Marginal i procent med en decimal, eller null när den inte går att räkna. */
  marginPct: number | null;
  /** Inköpet är större än intäkten. */
  loss: boolean;
};

/**
 * Delarna i en staplad intäktsstapel: inköp (grått) + vinst (grönt), längd relativt `max`.
 * Okänt inköp (null) ger en randig stapel utan marginal; förlust ger bara inköpsdelen.
 */
export function profitBarParts(
  revenue: number,
  cost: number | null | undefined,
  max: number,
): ProfitBarParts {
  const rev = Math.max(0, Number.isFinite(revenue) ? revenue : 0);
  const scale = max > 0 ? max : rev;
  const widthPct = scale > 0 ? r2(Math.min(100, (rev / scale) * 100)) : 0;
  if (cost == null || !Number.isFinite(cost)) {
    return { widthPct, costPct: null, profitPct: null, marginPct: null, loss: false };
  }
  if (rev <= 0) {
    return { widthPct, costPct: 0, profitPct: 0, marginPct: null, loss: cost > 0 };
  }
  const loss = cost > rev;
  const costPct = r2(Math.min(100, Math.max(0, (cost / rev) * 100)));
  return {
    widthPct,
    costPct,
    profitPct: r2(100 - costPct),
    marginPct: Math.round(((rev - cost) / rev) * 1000) / 10,
    loss,
  };
}
