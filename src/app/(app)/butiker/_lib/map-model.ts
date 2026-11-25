/**
 * Butikskartan (Butiker, visuellt/06): rena funktioner. Ingen karttjänst: butikerna ritas som
 * prickar på en enkel SVG-karta (rak projektion med cos(lat) i x), gränserna räknas ur
 * butikernas lägen. Hav och de största sjöarna är grova former i längd/bredd, så att kartan
 * känns som rätt trakt utan att vara exakt.
 *
 * Läge: butikens egna koordinater (stores.latitude/longitude). Saknas de används stadens
 * mittpunkt ur en liten ortlista (CITY_POINTS); utan känd stad hamnar butiken inte på kartan.
 */

export type LngLat = readonly [lng: number, lat: number];

/** Orternas mittpunkter [lng, lat]. Nycklar i gemener. */
export const CITY_POINTS: Readonly<Record<string, LngLat>> = {
  // Västra Götaland, Bohuslän och Halland
  göteborg: [11.975, 57.709],
  alingsås: [12.533, 57.93],
  lerum: [12.269, 57.77],
  floda: [12.36, 57.809],
  partille: [12.106, 57.74],
  mölndal: [12.014, 57.655],
  kungälv: [11.981, 57.871],
  ale: [12.059, 57.896],
  nödinge: [12.059, 57.896],
  stenungsund: [11.818, 58.07],
  uddevalla: [11.938, 58.35],
  trollhättan: [12.289, 58.284],
  vänersborg: [12.323, 58.381],
  lysekil: [11.436, 58.274],
  strömstad: [11.171, 58.94],
  kungsbacka: [12.076, 57.487],
  borås: [12.94, 57.721],
  vårgårda: [12.809, 58.034],
  varberg: [12.251, 57.106],
  halmstad: [12.858, 56.674],
  lidköping: [13.158, 58.505],
  skövde: [13.846, 58.39],
  mariestad: [13.824, 58.71],
  karlstad: [13.512, 59.402],
  jönköping: [14.162, 57.783],
  // Mälardalen (demo)
  stockholm: [18.069, 59.329],
  uppsala: [17.639, 59.859],
  västerås: [16.545, 59.61],
  eskilstuna: [16.51, 59.371],
  örebro: [15.213, 59.275],
  arboga: [15.839, 59.394],
  köping: [15.993, 59.514],
  enköping: [17.078, 59.636],
  sala: [16.607, 59.92],
  strängnäs: [17.031, 59.377],
  hallstahammar: [16.23, 59.614],
  kungsör: [16.096, 59.422],
  // Övrigt
  malmö: [13.004, 55.605],
  linköping: [15.621, 58.411],
  norrköping: [16.192, 58.588],
};

export function cityPoint(city: string | null | undefined): LngLat | null {
  const key = city?.trim().toLocaleLowerCase("sv-SE");
  return key ? (CITY_POINTS[key] ?? null) : null;
}

/**
 * Vatten [lng, lat] som slutna former: havet väster om västkusten, Vänern, Mälaren och
 * Hjälmaren. Grovt: kartan ska kännas igen, inte mätas på.
 */
export const WATER: readonly (readonly LngLat[])[] = [
  // Havet (Skagerrak/Kattegatt), kusten norrifrån
  [
    [11.05, 59.3],
    [11.12, 59.1],
    [11.17, 58.93],
    [11.22, 58.78],
    [11.2, 58.64],
    [11.28, 58.48],
    [11.4, 58.34],
    [11.5, 58.26],
    [11.62, 58.1],
    [11.72, 58.0],
    [11.78, 57.88],
    [11.8, 57.76],
    [11.87, 57.69],
    [11.92, 57.6],
    [12.0, 57.47],
    [12.06, 57.35],
    [12.15, 57.22],
    [12.25, 57.1],
    [12.4, 56.92],
    [12.56, 56.8],
    [12.75, 56.62],
    [12.85, 56.45],
    [10.2, 56.45],
    [10.2, 59.3],
  ],
  // Vänern (södra delen räcker)
  [
    [12.3, 58.4],
    [12.45, 58.37],
    [12.7, 58.45],
    [13.0, 58.48],
    [13.2, 58.55],
    [13.55, 58.62],
    [13.85, 58.75],
    [13.95, 58.95],
    [14.15, 59.2],
    [14.05, 59.32],
    [13.7, 59.38],
    [13.4, 59.36],
    [13.1, 59.25],
    [12.75, 59.07],
    [12.55, 58.85],
    [12.4, 58.62],
    [12.3, 58.5],
  ],
  // Mjörn (vid Alingsås)
  [
    [12.36, 57.88],
    [12.42, 57.86],
    [12.47, 57.92],
    [12.44, 58.0],
    [12.38, 57.98],
  ],
  // Mälaren
  [
    [15.98, 59.5],
    [16.3, 59.565],
    [16.56, 59.6],
    [16.82, 59.565],
    [17.07, 59.605],
    [17.36, 59.585],
    [17.76, 59.45],
    [18.05, 59.33],
    [17.7, 59.3],
    [17.3, 59.31],
    [16.95, 59.415],
    [16.55, 59.43],
    [16.15, 59.43],
  ],
  // Hjälmaren
  [
    [15.33, 59.26],
    [15.7, 59.28],
    [16.1, 59.3],
    [16.4, 59.28],
    [16.0, 59.17],
    [15.55, 59.18],
  ],
];

export interface MapView {
  /** Mittpunkt [lng, lat]. */
  readonly center: LngLat;
  /** Grader latitud från överkant till nederkant. */
  readonly spanLat: number;
}

/** Minsta utsnitt i grader latitud (en enda stad blir inte ett frimärke). */
export const MIN_SPAN_LAT = 0.28;

/**
 * Utsnittet som rymmer alla punkter i en ruta w×h med `pad` (andel av rutan) runt om.
 * x skalas med cos(lat) så att avstånden blir ungefär rätt.
 */
export function fitView(points: readonly LngLat[], w: number, h: number, pad = 0.16): MapView {
  if (points.length === 0 || w <= 0 || h <= 0) return { center: [12.2, 57.85], spanLat: 1.2 };
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const [lng, lat] of points) {
    minLng = Math.min(minLng, lng);
    maxLng = Math.max(maxLng, lng);
    minLat = Math.min(minLat, lat);
    maxLat = Math.max(maxLat, lat);
  }
  const center: LngLat = [(minLng + maxLng) / 2, (minLat + maxLat) / 2];
  const k = Math.cos((center[1] * Math.PI) / 180);
  const inner = Math.max(0.2, 1 - 2 * pad);
  // Spannet i lat som behövs för höjden och (omräknat) för bredden.
  const needLat = (maxLat - minLat) / inner;
  const needLatFromLng = ((maxLng - minLng) * k * (h / w)) / inner;
  return { center, spanLat: Math.max(MIN_SPAN_LAT, needLat, needLatFromLng) };
}

/** Projektion [lng, lat] → [x, y] i rutan w×h för utsnittet. */
export function projector(view: MapView, w: number, h: number): (p: LngLat) => [number, number] {
  const k = Math.cos((view.center[1] * Math.PI) / 180);
  const s = h / view.spanLat;
  return ([lng, lat]) => [
    w / 2 + (lng - view.center[0]) * k * s,
    h / 2 - (lat - view.center[1]) * s,
  ];
}

/** Zooma utsnittet med faktorn (2 = dubbelt så nära), mot en punkt. */
export function zoomView(view: MapView, factor: number, toward?: LngLat | null): MapView {
  const spanLat = Math.max(0.04, view.spanLat / factor);
  if (!toward || factor <= 1) return { center: view.center, spanLat };
  // Flytta mitten en bit mot punkten (så att den hamnar närmare mitten).
  const t = 1 - 1 / factor;
  return {
    center: [
      view.center[0] + (toward[0] - view.center[0]) * t,
      view.center[1] + (toward[1] - view.center[1]) * t,
    ],
    spanLat,
  };
}

/**
 * Prickens radie efter vinsten (ytan proportionell mot vinsten), `max` = största vinsten.
 * Utan vinst (eller utan vinstsiffror, `max` 0) en liten prick.
 */
export function dotRadius(profitOre: number, maxOre: number, phone = false): number {
  const min = phone ? 5 : 6;
  const span = phone ? 9 : 12;
  if (maxOre <= 0 || profitOre <= 0) return phone ? 4.5 : 5.5;
  return min + Math.sqrt(Math.min(1, profitOre / maxOre)) * span;
}

/**
 * Butiker på exakt samma punkt (samma stad utan egna koordinater) läggs i en liten ring runt
 * punkten så att alla syns. Returnerar en förskjutning i px per index.
 */
export function spreadOffsets(n: number, radius = 14): [number, number][] {
  if (n <= 1) return [[0, 0]];
  return Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return [Math.cos(a) * radius, Math.sin(a) * radius] as [number, number];
  });
}

/** Mjuk kurva genom punkterna (Catmull-Rom → Bézier), sluten. */
export function smoothPath(pts: readonly (readonly [number, number])[]): string {
  const n = pts.length;
  if (n < 3) return "";
  const g = (i: number) => pts[(i + n) % n]!;
  const f = (v: number) => v.toFixed(1);
  let d = `M${f(g(0)[0])},${f(g(0)[1])}`;
  for (let i = 0; i < n; i++) {
    const p0 = g(i - 1);
    const p1 = g(i);
    const p2 = g(i + 1);
    const p3 = g(i + 2);
    const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
    const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
    d += `C${f(c1[0]!)},${f(c1[1]!)} ${f(c2[0]!)},${f(c2[1]!)} ${f(p2[0])},${f(p2[1])}`;
  }
  return `${d}Z`;
}

export interface LabelBox {
  readonly x: number;
  readonly y: number;
  readonly w: number;
  readonly h: number;
}

function overlaps(a: LabelBox, b: LabelBox): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

/**
 * Vilka etiketter får plats: i ordning (viktigast först), en etikett som krockar med en redan
 * vald (eller med en prick i `blocked`) hoppas över. Returnerar indexen som visas.
 */
export function placeLabels(
  boxes: readonly LabelBox[],
  blocked: readonly LabelBox[] = [],
  bounds?: { w: number; h: number },
): Set<number> {
  const taken: LabelBox[] = [...blocked];
  const shown = new Set<number>();
  boxes.forEach((b, i) => {
    if (bounds && (b.x < 2 || b.y < 2 || b.x + b.w > bounds.w - 2 || b.y + b.h > bounds.h - 2)) {
      return;
    }
    if (taken.some((t) => overlaps(b, t))) return;
    taken.push(b);
    shown.add(i);
  });
  return shown;
}

export type LabelSide = "right" | "left" | "above" | "below";

/** Etikettens ruta på en sida om pricken (x, y = prickens mitt, r = radie, tw = textbredd). */
export function labelBox(x: number, y: number, r: number, tw: number, side: LabelSide): LabelBox {
  switch (side) {
    case "right":
      return { x: x + r + 6, y: y - 8, w: tw, h: 16 };
    case "left":
      return { x: x - r - 6 - tw, y: y - 8, w: tw, h: 16 };
    case "above":
      return { x: x - tw / 2, y: y - r - 20, w: tw, h: 16 };
    case "below":
      return { x: x - tw / 2, y: y + r + 4, w: tw, h: 16 };
  }
}

/**
 * Som placeLabels men med flera lägen per etikett (i önskad ordning): varje etikett får det
 * första läget som inte krockar. Returnerar index → valt läge (index i kandidatlistan).
 */
/**
 * Vilka etiketter som får visas när flera har samma text (två butiker i Örebro på telefonen,
 * där etiketten är orten): bara den första av varje text, utan hänsyn till stora bokstäver.
 */
export function firstOfEachText(texts: readonly string[]): boolean[] {
  const seen = new Set<string>();
  return texts.map((text) => {
    const key = text.trim().toLocaleLowerCase("sv-SE");
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export function placeLabelsAround(
  candidates: readonly (readonly LabelBox[])[],
  blocked: readonly LabelBox[] = [],
  bounds?: { w: number; h: number },
): Map<number, number> {
  const taken: LabelBox[] = [...blocked];
  const out = new Map<number, number>();
  candidates.forEach((list, i) => {
    for (let k = 0; k < list.length; k++) {
      const b = list[k]!;
      if (bounds && (b.x < 2 || b.y < 2 || b.x + b.w > bounds.w - 2 || b.y + b.h > bounds.h - 2)) {
        continue;
      }
      if (taken.some((t) => overlaps(b, t))) continue;
      taken.push(b);
      out.set(i, k);
      return;
    }
  });
  return out;
}
