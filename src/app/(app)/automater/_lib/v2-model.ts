/**
 * Automater i V2 (byggplanen 2.3): listan med sök, filter, gruppering och sortering, och den
 * valda automatens fack. Rena funktioner; datan kommer från flottans läge (src/server/data/v2)
 * och ./v2-data.ts. Belopp finns bara i `economy` (null för påfyllaren: servern skickar dem aldrig).
 */

import {
  NEEDS_FILL_STATUSES,
  FLEET_STATUS_RANK,
  type FleetStatus,
  type FleetStatusTone,
} from "@/analytics/fleet-status";

/** Ett fack per titel (Awish samlar fack med samma vara). */
export interface AutoSlot {
  readonly titleId: string;
  readonly name: string;
  /** "A1", "A2" (Awish-kanalerna), tom lista utan läsning. */
  readonly channels: readonly string[];
  readonly units: number;
  /** null = okänd (inte läst från Awish). */
  readonly capacity: number | null;
  /** Antal fack (kanaler) för titeln. */
  readonly slots: number;
  /** Tomma fack. */
  readonly empty: number;
}

export interface AutoEconomy {
  readonly profitPerDayOre: number | null;
  readonly vsMedianOre: number | null;
  readonly verdict: string | null;
  readonly lossProfitPerDayOre: number | null;
  /** Periodens intäkt och vinst (Automaters vanliga uträkning). null = ingen rad. */
  readonly revenueOre: number | null;
  readonly profitOre: number | null;
}

export interface AutoMachine {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly storeId: string | null;
  readonly storeName: string | null;
  readonly city: string | null;
  readonly address: string | null;
  readonly phone: string | null;
  readonly contactName: string | null;
  readonly lat: number | null;
  readonly lng: number | null;
  readonly power: { readonly off: string; readonly on: string } | null;
  readonly status: FleetStatus;
  readonly statusLabel: string;
  readonly tone: FleetStatusTone;
  /** Fyllnad i bp, null = inte läst från Awish. */
  readonly fillBp: number | null;
  readonly units: number | null;
  readonly capacity: number | null;
  readonly emptyChannels: number;
  readonly daysLeft: number | null;
  readonly perDayMilli: number;
  readonly lastRefillAt: string | null;
  readonly sales30: readonly number[];
  readonly powerOffNow: boolean;
  readonly offlineSince: string | null;
  readonly slots: readonly AutoSlot[];
  readonly economy: AutoEconomy | null;
}

export type AutoFilter = "alla" | "behover" | "ny" | "offline" | "av" | "under";
export type AutoGroup = "stad" | "butik" | "ingen";
export type AutoSortKey = "n" | "s" | "f" | "d" | "l" | "p" | "x";
export interface AutoSort {
  readonly key: AutoSortKey;
  readonly dir: 1 | -1;
}

export const AUTO_FILTERS: readonly AutoFilter[] = [
  "alla",
  "behover",
  "ny",
  "offline",
  "av",
  "under",
];

export const AUTO_FILTER_LABEL: Readonly<Record<AutoFilter, string>> = {
  alla: "Alla",
  behover: "Behöver påfyllning",
  ny: "Startklar",
  offline: "Offline",
  av: "Ström av nu",
  under: "Underpresterar",
};

/** Filtret ur adressen (?f=offline). Okänt eller pengafilter utan ekonomi: Alla. */
export function filterOf(value: string | null | undefined, economy: boolean): AutoFilter {
  const f = (AUTO_FILTERS as readonly string[]).includes(value ?? "")
    ? (value as AutoFilter)
    : "alla";
  return f === "under" && !economy ? "alla" : f;
}

export function needsFill(m: Pick<AutoMachine, "status">): boolean {
  return NEEDS_FILL_STATUSES.has(m.status);
}

export function matchesFilter(m: AutoMachine, f: AutoFilter): boolean {
  switch (f) {
    case "alla":
      return true;
    case "behover":
      return needsFill(m);
    case "ny":
      return m.status === "startklar";
    case "offline":
      return m.status === "offline";
    case "av":
      return m.powerOffNow;
    case "under":
      return m.economy?.verdict === "weak";
  }
}

/** Antal per filter (chipsen). "under" bara med ekonomi. */
export function filterCounts(
  machines: readonly AutoMachine[],
  economy: boolean,
): Partial<Record<AutoFilter, number>> {
  const out: Partial<Record<AutoFilter, number>> = {};
  for (const f of AUTO_FILTERS) {
    if (f === "under" && !economy) continue;
    out[f] = machines.filter((m) => matchesFilter(m, f)).length;
  }
  return out;
}

const fold = (s: string) => s.normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Sök i automat, kod, butik, stad och titlarna i facken. */
export function matchesSearch(m: AutoMachine, q: string): boolean {
  const words = fold(q).trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const hay = fold(
    [m.name, m.code, m.storeName, m.city, ...m.slots.map((s) => s.name)].filter(Boolean).join(" "),
  );
  return words.every((w) => hay.includes(w));
}

const NONE = Number.POSITIVE_INFINITY;

function sortValue(m: AutoMachine, key: AutoSortKey, now: number): number | string {
  switch (key) {
    case "n":
      return m.name;
    case "s":
      return FLEET_STATUS_RANK[m.status];
    case "f":
      return m.fillBp ?? NONE;
    case "d":
      return m.daysLeft ?? NONE;
    case "l":
      return m.lastRefillAt ? now - Date.parse(m.lastRefillAt) : NONE;
    case "p":
      return m.economy?.profitPerDayOre ?? NONE;
    case "x":
      return m.economy?.vsMedianOre ?? NONE;
  }
}

/** Sorterar (okända värden sist i båda riktningarna); lika värden i statusordningen. */
export function sortMachines(
  machines: readonly AutoMachine[],
  sort: AutoSort,
  now: number,
): AutoMachine[] {
  const tie = (a: AutoMachine, b: AutoMachine) =>
    FLEET_STATUS_RANK[a.status] - FLEET_STATUS_RANK[b.status] ||
    (a.daysLeft ?? 9_999) - (b.daysLeft ?? 9_999) ||
    a.code.localeCompare(b.code, "sv", { numeric: true });
  return [...machines].sort((a, b) => {
    const va = sortValue(a, sort.key, now);
    const vb = sortValue(b, sort.key, now);
    if (va === vb) return tie(a, b);
    if (va === NONE) return 1;
    if (vb === NONE) return -1;
    const c =
      typeof va === "string" && typeof vb === "string"
        ? va.localeCompare(vb, "sv", { numeric: true })
        : (va as number) - (vb as number);
    return c * sort.dir || tie(a, b);
  });
}

export interface AutoGroupRow {
  readonly key: string;
  readonly label: string;
  readonly machines: readonly AutoMachine[];
  readonly needFill: number;
  readonly offline: number;
  /** Σ vinst per dag (öre), bara med ekonomi. */
  readonly profitPerDayOre: number | null;
}

/**
 * Grupper i listan. Stad: i körordning från lagret när koordinaterna finns (`cityOrder`),
 * annars bokstavsordning; automater utan stad sist under "Utan stad". Butik: bokstavsordning.
 */
export function groupMachines(
  machines: readonly AutoMachine[],
  group: AutoGroup,
  cityOrder: readonly string[] = [],
): AutoGroupRow[] {
  if (group === "ingen") {
    return [summary("alla", "Alla", machines)];
  }
  const by = new Map<string, AutoMachine[]>();
  for (const m of machines) {
    const k = (group === "stad" ? m.city : m.storeName)?.trim() || "";
    const list = by.get(k) ?? [];
    list.push(m);
    by.set(k, list);
  }
  const rank = new Map(cityOrder.map((c, i) => [c, i]));
  const keys = [...by.keys()].sort((a, b) => {
    if (a === "") return 1;
    if (b === "") return -1;
    if (group === "stad") {
      const ra = rank.get(a) ?? NONE;
      const rb = rank.get(b) ?? NONE;
      if (ra !== rb) return ra - rb;
    }
    return a.localeCompare(b, "sv");
  });
  return keys.map((k) =>
    summary(k || "-", k || (group === "stad" ? "Utan stad" : "Utan butik"), by.get(k)!),
  );
}

function summary(key: string, label: string, machines: readonly AutoMachine[]): AutoGroupRow {
  const withEconomy = machines.filter((m) => m.economy?.profitPerDayOre != null);
  return {
    key,
    label,
    machines,
    needFill: machines.filter(needsFill).length,
    offline: machines.filter((m) => m.status === "offline").length,
    profitPerDayOre:
      withEconomy.length > 0
        ? withEconomy.reduce((n, m) => n + (m.economy!.profitPerDayOre ?? 0), 0)
        : null,
  };
}

/** Städerna i körordning från lagret (närmast först), bara de med koordinater. */
export function cityOrderFrom(
  machines: readonly AutoMachine[],
  origin: { readonly lat: number; readonly lng: number } | null,
): string[] {
  if (!origin) return [];
  const best = new Map<string, number>();
  for (const m of machines) {
    if (!m.city || m.lat === null || m.lng === null) continue;
    const d =
      (m.lat - origin.lat) ** 2 +
      ((m.lng - origin.lng) * Math.cos((origin.lat * Math.PI) / 180)) ** 2;
    best.set(m.city, Math.min(best.get(m.city) ?? NONE, d));
  }
  return [...best.entries()].sort((a, b) => a[1] - b[1]).map(([c]) => c);
}

/** "16 d sen", "i dag", "i går", "–". */
export function sinceText(iso: string | null, now: number, timeZone: string): string {
  if (!iso) return "–";
  const day = (ms: number) =>
    new Intl.DateTimeFormat("sv-SE", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(ms);
  const a = Date.parse(`${day(Date.parse(iso))}T00:00:00Z`);
  const b = Date.parse(`${day(now)}T00:00:00Z`);
  const days = Math.round((b - a) / 86_400_000);
  if (days <= 0) return "i dag";
  if (days === 1) return "i går";
  return `${days} d sen`;
}

/** Pack som får plats (kapacitet − pack). null utan läsning. */
export function roomFor(m: Pick<AutoMachine, "units" | "capacity">): number | null {
  if (m.capacity === null || m.units === null) return null;
  return Math.max(0, m.capacity - m.units);
}

/** Fackens ordning: kanalordning (A1, A2, B10), sedan titel. */
export function orderSlots(slots: readonly AutoSlot[]): AutoSlot[] {
  return [...slots].sort((a, b) => {
    const ca = a.channels[0];
    const cb = b.channels[0];
    if (ca === undefined || cb === undefined) {
      if (ca !== cb) return ca === undefined ? 1 : -1;
      return a.name.localeCompare(b.name, "sv");
    }
    return (
      ca.localeCompare(cb, "sv", { numeric: true, sensitivity: "base" }) ||
      a.name.localeCompare(b.name, "sv")
    );
  });
}
