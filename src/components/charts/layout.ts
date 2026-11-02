/**
 * Placering av direktetiketter i diagram. Etiketter provas i en lista med
 * kandidatlägen och får den första platsen som inte krockar med serielinjer,
 * redan placerade etiketter eller ritytans kanter. Inga legender behövs.
 */

export type Pt = readonly [number, number];
export type Box = { x: number; y: number; w: number; h: number };

export type LabelKind = "title" | "body" | "value" | "caps";
export type LabelSpan = { text: string; kind: LabelKind };
export type LabelLine = ReadonlyArray<LabelSpan>;

/** Teckenbredd i px per typ (Geist ≈ 0,56 em, Geist Mono 0,6 em + spärrning). */
const SPEC: Record<LabelKind, { size: number; char: number; lh: number }> = {
  title: { size: 12, char: 6.7, lh: 15 },
  body: { size: 12, char: 6.4, lh: 15 },
  value: { size: 11, char: 6.6, lh: 14 },
  caps: { size: 10, char: 6.6, lh: 14 },
};

export function labelSpec(kind: LabelKind) {
  return SPEC[kind];
}

export function measureLines(lines: ReadonlyArray<LabelLine>): { w: number; h: number } {
  let w = 0;
  let h = 0;
  for (const line of lines) {
    let lw = 0;
    let lh = 0;
    for (const s of line) {
      const sp = SPEC[s.kind];
      lw += s.text.length * sp.char;
      lh = Math.max(lh, sp.lh);
    }
    w = Math.max(w, lw);
    h += lh;
  }
  return { w: Math.ceil(w), h };
}

export function boxesOverlap(a: Box, b: Box, pad = 2): boolean {
  return (
    a.x < b.x + b.w + pad && a.x + a.w + pad > b.x && a.y < b.y + b.h + pad && a.y + a.h + pad > b.y
  );
}

function inside(p: Pt, b: Box) {
  return p[0] >= b.x && p[0] <= b.x + b.w && p[1] >= b.y && p[1] <= b.y + b.h;
}

function segmentsCross(a: Pt, b: Pt, c: Pt, d: Pt): boolean {
  const o = (p: Pt, q: Pt, r: Pt) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const d1 = o(c, d, a);
  const d2 = o(c, d, b);
  const d3 = o(a, b, c);
  const d4 = o(a, b, d);
  return d1 * d2 < 0 && d3 * d4 < 0;
}

export function segmentHitsBox(a: Pt, b: Pt, box: Box, pad = 3): boolean {
  const r = { x: box.x - pad, y: box.y - pad, w: box.w + pad * 2, h: box.h + pad * 2 };
  if (Math.max(a[0], b[0]) < r.x || Math.min(a[0], b[0]) > r.x + r.w) return false;
  if (Math.max(a[1], b[1]) < r.y || Math.min(a[1], b[1]) > r.y + r.h) return false;
  if (inside(a, r) || inside(b, r)) return true;
  const tl: Pt = [r.x, r.y];
  const tr: Pt = [r.x + r.w, r.y];
  const bl: Pt = [r.x, r.y + r.h];
  const br: Pt = [r.x + r.w, r.y + r.h];
  return (
    segmentsCross(a, b, tl, tr) ||
    segmentsCross(a, b, tr, br) ||
    segmentsCross(a, b, br, bl) ||
    segmentsCross(a, b, bl, tl)
  );
}

export function polylineHitsBox(pts: ReadonlyArray<Pt>, box: Box, pad = 3): boolean {
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    if (a && b && segmentHitsBox(a, b, box, pad)) return true;
  }
  return false;
}

export type Obstacles = {
  boxes: Box[];
  lines: ReadonlyArray<ReadonlyArray<Pt>>;
  points?: ReadonlyArray<Pt>;
  bounds: Box;
};

/**
 * Hårda hinder för ett enskilt anrop: en kandidat som korsar dessa linjer
 * väljs aldrig, inte ens för obligatoriska etiketter. Används för att en
 * etikett aldrig ska dölja huvudserien.
 */
export type PlaceOptions = { hard?: ReadonlyArray<ReadonlyArray<Pt>> };

const HARD = 1000;

function cost(b: Box, obs: Obstacles, opts?: PlaceOptions): number {
  let c = 0;
  for (const l of opts?.hard ?? []) if (polylineHitsBox(l, b)) return HARD;
  const { bounds } = obs;
  if (
    b.x < bounds.x ||
    b.y < bounds.y ||
    b.x + b.w > bounds.x + bounds.w ||
    b.y + b.h > bounds.y + bounds.h
  )
    c += 100;
  for (const o of obs.boxes) if (boxesOverlap(b, o)) c += 10;
  for (const l of obs.lines) if (polylineHitsBox(l, b)) c += 4;
  for (const p of obs.points ?? [])
    if (inside(p, { x: b.x - 6, y: b.y - 6, w: b.w + 12, h: b.h + 12 })) c += 4;
  return c;
}

/**
 * Väljer första kandidaten utan krock. `required` etiketter tar minst dåliga
 * läget om ingen är fri; valfria etiketter utelämnas (null) i stället för att
 * lägga sig över data. Med `opts.hard` returneras null hellre än ett läge som
 * korsar de hårda linjerna.
 */
export function place(
  candidates: ReadonlyArray<Box>,
  obs: Obstacles,
  required = false,
  opts?: PlaceOptions,
): Box | null {
  let best: Box | null = null;
  let bestCost = Infinity;
  for (const c of candidates) {
    const k = cost(c, obs, opts);
    if (k === 0) return c;
    if (k < bestCost) {
      bestCost = k;
      best = c;
    }
  }
  if (!required) return null;
  if (bestCost < 100) return best;
  return opts?.hard ? null : (candidates[0] ?? null);
}

/** Kandidatlägen runt en punkt, i fallande preferens. */
export function aroundPoint(
  p: Pt,
  size: { w: number; h: number },
  prefer: "above" | "below" = "above",
  gap = 12,
): Box[] {
  const [x, y] = p;
  const { w, h } = size;
  const above = [
    { x: x + 8, y: y - gap - h, w, h },
    { x: x - 8 - w, y: y - gap - h, w, h },
    { x: x - w / 2, y: y - gap - h, w, h },
  ];
  const below = [
    { x: x + 8, y: y + gap, w, h },
    { x: x - 8 - w, y: y + gap, w, h },
    { x: x - w / 2, y: y + gap, w, h },
  ];
  const side = [
    { x: x + 12, y: y - h / 2, w, h },
    { x: x - 12 - w, y: y - h / 2, w, h },
  ];
  const far = [
    { x: x + 8, y: y - gap * 3 - h, w, h },
    { x: x - 8 - w, y: y - gap * 3 - h, w, h },
    { x: x + 8, y: y + gap * 3, w, h },
    { x: x - 8 - w, y: y + gap * 3, w, h },
  ];
  return prefer === "above"
    ? [...above, ...side, ...below, ...far]
    : [...below, ...side, ...above, ...far];
}

/** Ledlinje från en punkt till närmaste kant på en etikettruta, kortad vid punkten. */
export function leader(
  p: Pt,
  b: Box,
  start = 5,
): { x1: number; y1: number; x2: number; y2: number } | null {
  const tx = Math.min(Math.max(p[0], b.x), b.x + b.w);
  const ty = Math.min(Math.max(p[1], b.y), b.y + b.h);
  const dx = tx - p[0];
  const dy = ty - p[1];
  const len = Math.hypot(dx, dy);
  if (len < start + 4) return null;
  return { x1: p[0] + (dx / len) * start, y1: p[1] + (dy / len) * start, x2: tx, y2: ty };
}
