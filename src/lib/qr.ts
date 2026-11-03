/**
 * QR-koder utan beroenden (ISO/IEC 18004): byte-läge (UTF-8), version 1–10 och
 * felrättning L, M, Q eller H. Räcker för korta koder (gratis-pack) och länkar upp till
 * drygt 200 tecken. Ren funktion; ritas som SVG av <QrCode> (src/components/ui/qr-code.tsx).
 *
 * Följer standardens steg: dataström (läge, längd, data, avslut, utfyllnad), Reed-Solomon
 * per block (GF(256), polynom 0x11D), sammanflätning, funktionsmönster, sicksackplacering,
 * den mask (0–7) som ger lägst straff, format- och versionsinformation.
 */

export type QrLevel = "L" | "M" | "Q" | "H";

export interface QrMatrix {
  readonly version: number;
  readonly size: number;
  readonly mask: number;
  /** modules[y][x], true = mörk. */
  readonly modules: boolean[][];
}

/** [ec-kodord per block, block i grupp 1, dataord per block i grupp 1, block i grupp 2, dataord i grupp 2]. */
type BlockSpec = readonly [number, number, number, number, number];

const BLOCKS: Record<QrLevel, readonly BlockSpec[]> = {
  L: [
    [7, 1, 19, 0, 0],
    [10, 1, 34, 0, 0],
    [15, 1, 55, 0, 0],
    [20, 1, 80, 0, 0],
    [26, 1, 108, 0, 0],
    [18, 2, 68, 0, 0],
    [20, 2, 78, 0, 0],
    [24, 2, 97, 0, 0],
    [30, 2, 116, 0, 0],
    [18, 2, 68, 2, 69],
  ],
  M: [
    [10, 1, 16, 0, 0],
    [16, 1, 28, 0, 0],
    [26, 1, 44, 0, 0],
    [18, 2, 32, 0, 0],
    [24, 2, 43, 0, 0],
    [16, 4, 27, 0, 0],
    [18, 4, 31, 0, 0],
    [22, 2, 38, 2, 39],
    [22, 3, 36, 2, 37],
    [26, 4, 43, 1, 44],
  ],
  Q: [
    [13, 1, 13, 0, 0],
    [22, 1, 22, 0, 0],
    [18, 2, 17, 0, 0],
    [26, 2, 24, 0, 0],
    [18, 2, 15, 2, 16],
    [24, 4, 19, 0, 0],
    [18, 2, 14, 4, 15],
    [22, 4, 18, 2, 19],
    [20, 4, 16, 4, 17],
    [24, 6, 19, 2, 20],
  ],
  H: [
    [17, 1, 9, 0, 0],
    [28, 1, 16, 0, 0],
    [22, 2, 13, 0, 0],
    [16, 4, 9, 0, 0],
    [22, 2, 11, 2, 12],
    [28, 4, 15, 0, 0],
    [26, 4, 13, 1, 14],
    [26, 4, 14, 2, 15],
    [24, 4, 12, 4, 13],
    [28, 6, 15, 2, 16],
  ],
};

const ALIGNMENT: readonly (readonly number[])[] = [
  [],
  [6, 18],
  [6, 22],
  [6, 26],
  [6, 30],
  [6, 34],
  [6, 22, 38],
  [6, 24, 42],
  [6, 26, 46],
  [6, 28, 50],
];

const FORMAT_BITS: Record<QrLevel, number> = { L: 1, M: 0, Q: 3, H: 2 };

export const QR_MAX_VERSION = 10;

function dataCapacity(version: number, level: QrLevel): number {
  const [, b1, d1, b2, d2] = BLOCKS[level][version - 1]!;
  return b1 * d1 + b2 * d2;
}

/** Största antal byte som ryms i en version och nivå (byte-läge). */
export function qrByteCapacity(version: number, level: QrLevel): number {
  const countBits = version <= 9 ? 8 : 16;
  return Math.floor((dataCapacity(version, level) * 8 - 4 - countBits) / 8);
}

// --- GF(256) och Reed-Solomon ------------------------------------------------

function gfMul(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

function rsDivisor(degree: number): number[] {
  const result = new Array<number>(degree).fill(0);
  result[degree - 1] = 1;
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = gfMul(result[j]!, root);
      if (j + 1 < result.length) result[j]! ^= result[j + 1]!;
    }
    root = gfMul(root, 0x02);
  }
  return result;
}

function rsRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result = new Array<number>(divisor.length).fill(0);
  for (const b of data) {
    const factor = b ^ result.shift()!;
    result.push(0);
    divisor.forEach((coef, i) => {
      result[i]! ^= gfMul(coef, factor);
    });
  }
  return result;
}

// --- Dataström -----------------------------------------------------------------

function encodeData(bytes: Uint8Array, version: number, level: QrLevel): number[] {
  const bits: number[] = [];
  const push = (value: number, length: number) => {
    for (let i = length - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  const capacityBits = dataCapacity(version, level) * 8;
  push(0b0100, 4);
  push(bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) push(b, 8);
  push(0, Math.min(4, capacityBits - bits.length));
  push(0, (8 - (bits.length % 8)) % 8);
  for (let pad = 0xec; bits.length < capacityBits; pad ^= 0xec ^ 0x11) push(pad, 8);
  const out: number[] = [];
  for (let i = 0; i < bits.length; i += 8) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits[i + j]!;
    out.push(v);
  }
  return out;
}

function interleave(data: readonly number[], version: number, level: QrLevel): number[] {
  const [ec, b1, d1, b2, d2] = BLOCKS[level][version - 1]!;
  const divisor = rsDivisor(ec);
  const blocks: { data: number[]; ec: number[] }[] = [];
  let k = 0;
  for (let i = 0; i < b1 + b2; i++) {
    const len = i < b1 ? d1 : d2;
    const chunk = data.slice(k, k + len);
    k += len;
    blocks.push({ data: chunk, ec: rsRemainder(chunk, divisor) });
  }
  const out: number[] = [];
  const maxData = Math.max(d1, d2);
  for (let i = 0; i < maxData; i++) {
    for (const b of blocks) if (i < b.data.length) out.push(b.data[i]!);
  }
  for (let i = 0; i < ec; i++) for (const b of blocks) out.push(b.ec[i]!);
  return out;
}

// --- Matrisen ------------------------------------------------------------------

class Grid {
  readonly size: number;
  readonly modules: boolean[][];
  readonly fn: boolean[][];

  constructor(version: number) {
    this.size = version * 4 + 17;
    this.modules = Array.from({ length: this.size }, () =>
      new Array<boolean>(this.size).fill(false),
    );
    this.fn = Array.from({ length: this.size }, () => new Array<boolean>(this.size).fill(false));
  }

  set(x: number, y: number, dark: boolean): void {
    this.modules[y]![x] = dark;
    this.fn[y]![x] = true;
  }
}

function drawFinder(g: Grid, cx: number, cy: number): void {
  for (let dy = -4; dy <= 4; dy++) {
    for (let dx = -4; dx <= 4; dx++) {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= g.size || y >= g.size) continue;
      const d = Math.max(Math.abs(dx), Math.abs(dy));
      g.set(x, y, d !== 2 && d !== 4);
    }
  }
}

function drawAlignment(g: Grid, cx: number, cy: number): void {
  for (let dy = -2; dy <= 2; dy++) {
    for (let dx = -2; dx <= 2; dx++) {
      g.set(cx + dx, cy + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
    }
  }
}

function formatBits(level: QrLevel, mask: number): number {
  const data = (FORMAT_BITS[level] << 3) | mask;
  let rem = data;
  for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
  return ((data << 10) | rem) ^ 0x5412;
}

function drawFormat(g: Grid, level: QrLevel, mask: number): void {
  const bits = formatBits(level, mask);
  const bit = (i: number) => ((bits >>> i) & 1) === 1;
  const n = g.size;
  for (let i = 0; i <= 5; i++) g.set(8, i, bit(i));
  g.set(8, 7, bit(6));
  g.set(8, 8, bit(7));
  g.set(7, 8, bit(8));
  for (let i = 9; i < 15; i++) g.set(14 - i, 8, bit(i));
  for (let i = 0; i < 8; i++) g.set(n - 1 - i, 8, bit(i));
  for (let i = 8; i < 15; i++) g.set(8, n - 15 + i, bit(i));
  g.set(8, n - 8, true);
}

function drawVersion(g: Grid, version: number): void {
  if (version < 7) return;
  let rem = version;
  for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
  const bits = (version << 12) | rem;
  for (let i = 0; i < 18; i++) {
    const dark = ((bits >>> i) & 1) === 1;
    const a = g.size - 11 + (i % 3);
    const b = Math.floor(i / 3);
    g.set(a, b, dark);
    g.set(b, a, dark);
  }
}

function drawFunctionPatterns(g: Grid, version: number, level: QrLevel): void {
  const n = g.size;
  for (let i = 0; i < n; i++) {
    g.set(6, i, i % 2 === 0);
    g.set(i, 6, i % 2 === 0);
  }
  drawFinder(g, 3, 3);
  drawFinder(g, n - 4, 3);
  drawFinder(g, 3, n - 4);
  const pos = ALIGNMENT[version - 1]!;
  for (let i = 0; i < pos.length; i++) {
    for (let j = 0; j < pos.length; j++) {
      const corner =
        (i === 0 && j === 0) ||
        (i === 0 && j === pos.length - 1) ||
        (i === pos.length - 1 && j === 0);
      if (!corner) drawAlignment(g, pos[i]!, pos[j]!);
    }
  }
  drawFormat(g, level, 0);
  drawVersion(g, version);
}

function drawCodewords(g: Grid, data: readonly number[]): void {
  const n = g.size;
  let i = 0;
  for (let right = n - 1; right >= 1; right -= 2) {
    if (right === 6) right = 5;
    for (let vert = 0; vert < n; vert++) {
      for (let j = 0; j < 2; j++) {
        const x = right - j;
        const upward = ((right + 1) & 2) === 0;
        const y = upward ? n - 1 - vert : vert;
        if (!g.fn[y]![x] && i < data.length * 8) {
          g.modules[y]![x] = ((data[i >>> 3]! >>> (7 - (i & 7))) & 1) === 1;
          i++;
        }
      }
    }
  }
}

function maskHit(mask: number, x: number, y: number): boolean {
  switch (mask) {
    case 0:
      return (x + y) % 2 === 0;
    case 1:
      return y % 2 === 0;
    case 2:
      return x % 3 === 0;
    case 3:
      return (x + y) % 3 === 0;
    case 4:
      return (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
    case 5:
      return ((x * y) % 2) + ((x * y) % 3) === 0;
    case 6:
      return (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
    default:
      return (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
  }
}

function applyMask(g: Grid, mask: number): void {
  for (let y = 0; y < g.size; y++) {
    for (let x = 0; x < g.size; x++) {
      if (!g.fn[y]![x] && maskHit(mask, x, y)) g.modules[y]![x] = !g.modules[y]![x];
    }
  }
}

/** Straffpoäng enligt standarden (regel 1–4). Lägre är bättre. */
export function qrPenalty(m: readonly (readonly boolean[])[]): number {
  const n = m.length;
  let score = 0;
  const line = (get: (i: number) => boolean) => {
    let run = 1;
    for (let i = 1; i <= n; i++) {
      if (i < n && get(i) === get(i - 1)) {
        run++;
      } else {
        if (run >= 5) score += 3 + (run - 5);
        run = 1;
      }
    }
    // Regel 3: 1:1:3:1:1 med fyra ljusa på någon sida.
    const pattern = [true, false, true, true, true, false, true];
    for (let i = 0; i + 7 <= n; i++) {
      if (!pattern.every((p, k) => get(i + k) === p)) continue;
      const lightBefore = i >= 4 && [1, 2, 3, 4].every((k) => !get(i - k));
      const lightAfter = i + 11 <= n && [7, 8, 9, 10].every((k) => !get(i + k));
      if (lightBefore || lightAfter) score += 40;
    }
  };
  for (let y = 0; y < n; y++) line((x) => m[y]![x]!);
  for (let x = 0; x < n; x++) line((y) => m[y]![x]!);
  for (let y = 0; y + 1 < n; y++) {
    for (let x = 0; x + 1 < n; x++) {
      const c = m[y]![x]!;
      if (c === m[y]![x + 1] && c === m[y + 1]![x] && c === m[y + 1]![x + 1]) score += 3;
    }
  }
  let dark = 0;
  for (const row of m) for (const c of row) if (c) dark++;
  const total = n * n;
  const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
  score += Math.max(0, k) * 10;
  return score;
}

/**
 * QR-kod för texten (UTF-8). Minsta version som rymmer texten väljs (högst version 10).
 * `mask` tvingar en mask (för tester); annars väljs den med lägst straff.
 * Kastar RangeError om texten är för lång.
 */
export function encodeQr(
  text: string,
  options: { level?: QrLevel; mask?: number; minVersion?: number } = {},
): QrMatrix {
  const level = options.level ?? "M";
  const bytes = new TextEncoder().encode(text);
  let version = Math.max(1, options.minVersion ?? 1);
  while (version <= QR_MAX_VERSION && qrByteCapacity(version, level) < bytes.length) version++;
  if (version > QR_MAX_VERSION) {
    throw new RangeError(`Texten är för lång för en QR-kod (${bytes.length} byte).`);
  }
  const codewords = interleave(encodeData(bytes, version, level), version, level);

  const build = (mask: number): Grid => {
    const g = new Grid(version);
    drawFunctionPatterns(g, version, level);
    drawCodewords(g, codewords);
    applyMask(g, mask);
    drawFormat(g, level, mask);
    return g;
  };

  let best: { grid: Grid; mask: number; score: number } | null = null;
  const masks = options.mask === undefined ? [0, 1, 2, 3, 4, 5, 6, 7] : [options.mask];
  for (const mask of masks) {
    const grid = build(mask);
    const score = options.mask === undefined ? qrPenalty(grid.modules) : 0;
    if (!best || score < best.score) best = { grid, mask, score };
  }
  return { version, size: best!.grid.size, mask: best!.mask, modules: best!.grid.modules };
}

/** Matrisen som rader av "1" och "0" (för tester och felsökning). */
export function qrRows(m: QrMatrix): string[] {
  return m.modules.map((row) => row.map((c) => (c ? "1" : "0")).join(""));
}

/** SVG-sökväg ("M x y h1 v1 h-1 z" per mörk modul, ihopslagna per rad) med `margin` moduler. */
export function qrPath(m: QrMatrix, margin = 4): string {
  const parts: string[] = [];
  m.modules.forEach((row, y) => {
    let x = 0;
    while (x < row.length) {
      if (!row[x]) {
        x++;
        continue;
      }
      let w = 1;
      while (x + w < row.length && row[x + w]) w++;
      parts.push(`M${x + margin} ${y + margin}h${w}v1h${-w}z`);
      x += w;
    }
  });
  return parts.join("");
}
