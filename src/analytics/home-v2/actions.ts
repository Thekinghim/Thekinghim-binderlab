/**
 * "Kräver åtgärd" och dagens rad på Hem (V2, byggplanen 2.2 och 3.6). Ren funktion.
 *
 * Raderna är automater med status offline, tom, fyll på i dag eller startklar (flottans
 * läge) plus prisråd som går med förlust (pris under inköp + avgifter). Störst förlorad vinst
 * per dag först (compareByLoss: sedan kortast tid till tom, sedan kod).
 *
 * Utan ekonomi (påfyllaren) kommer inga belopp in och inga ut: ordningen är brådska
 * (statusens rang, sedan dagar till tom, sedan kod) och prisraderna finns inte.
 */

import {
  ACTION_STATUSES,
  compareByLoss,
  FLEET_STATUS_RANK,
  showsLoss,
  type FleetStatus,
} from "@/analytics/fleet-status";

/** Det Hem behöver av en automat i flottans läge (FleetMachine). */
export interface ActionMachineInput {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly status: FleetStatus;
  readonly statusLabel: string;
  readonly fill: {
    readonly units: number;
    readonly capacity: number;
    readonly fillBp: number | null;
    readonly emptyChannels: number;
  } | null;
  readonly daysLeft: number | null;
  readonly offlineSince: string | null;
  readonly powerOffNow: boolean;
  readonly store: {
    readonly name: string;
    readonly city: string | null;
    readonly phone: string | null;
    readonly contactName: string | null;
    readonly power: { readonly off: string; readonly on: string } | null;
  } | null;
  readonly economy: { readonly lossProfitPerDayOre: number | null } | null;
}

/** Ett prisråd med förlust (bara ekonomiroller). */
export interface ActionPriceInput {
  readonly titleId: string;
  readonly name: string;
  readonly salePriceOre: number;
  readonly unitCostOre: number;
  /** Vinst per pack nu (före butikens andel, efter moms och kortavgift). */
  readonly profitOre: number;
  readonly suggestedPriceOre: number | null;
  /** Förlorad vinst per dag om priset inte höjs (priceLossPerDayOre). */
  readonly lossOre: number;
}

export type HemActionKind = "offline" | "tom" | "fyll-pa" | "startklar" | "pris";

export interface HemAction {
  readonly key: string;
  readonly kind: HemActionKind;
  /** Automatens id (null för pris). */
  readonly machineId: string | null;
  readonly code: string | null;
  /** "Butiken" (automatens namn) eller "Black Bolt går med förlust". */
  readonly title: string;
  /** "Butiksnamn · BL-014" eller "Säljs för 180 kr, inköp 180 kr". */
  readonly sub: string;
  readonly badge: string;
  readonly tone: "critical" | "warning" | "info";
  /** Fyllnaden (bp) när den är läst från Awish, annars null. */
  readonly fillBp: number | null;
  /** Pack att ta med (fyll på, tom, startklar), annars null. */
  readonly packs: number | null;
  /** Hela dagar till tom, för ordningen. */
  readonly daysLeft: number | null;
  readonly offlineSince: string | null;
  /** Kontakt för Ring (alla roller ser butikens kontakt, som på Drift). */
  readonly phone: string | null;
  readonly contactName: string | null;
  /** Bara ekonomiroller: förlorad vinst per dag (öre), när den visas (från 5 kr). */
  readonly lossOre?: number;
  /** Prisrådet (bara pris). */
  readonly price?: {
    readonly salePriceOre: number;
    readonly unitCostOre: number;
    readonly suggestedPriceOre: number | null;
    readonly profitOre: number;
  };
}

export interface HemActionsResult {
  readonly rows: HemAction[];
  /** Dagens rad: behöver påfyllning (tom + fyll på), offline, startklar, prisråd med förlust. */
  readonly counts: {
    readonly refill: number;
    readonly offline: number;
    readonly startklar: number;
    readonly badPricing: number;
  };
  /** Lugna raden: i drift (inkl. tom snart) och ström av, med tidigaste "på igen". */
  readonly calm: {
    readonly running: number;
    readonly powerOff: number;
    readonly powerOnAt: string | null;
    readonly powerWindow: string | null;
  };
  readonly total: number;
}

const TONE: Record<Exclude<HemActionKind, "pris">, HemAction["tone"]> = {
  offline: "critical",
  tom: "critical",
  "fyll-pa": "warning",
  startklar: "info",
};

/** Pack som får plats: kapacitet − pack i automaten (Awish), annars dagens rutt. */
function packsFor(m: ActionMachineInput, routePacks: ReadonlyMap<string, number>): number | null {
  const fromRoute = routePacks.get(m.id);
  if (fromRoute !== undefined && fromRoute > 0) return fromRoute;
  if (m.fill && m.fill.capacity > 0) return Math.max(0, m.fill.capacity - m.fill.units);
  return null;
}

export function hemActions(args: {
  readonly machines: readonly ActionMachineInput[];
  /** Prisråd med förlust; null eller tom utan ekonomi. */
  readonly prices?: readonly ActionPriceInput[] | null;
  /** Rollen ser belopp. Utan: inga kronor och inga prisrader. */
  readonly economy: boolean;
  /** Pack per automat i dagens rutt (besöksplanen). */
  readonly routePacks?: ReadonlyMap<string, number>;
}): HemActionsResult {
  const routePacks = args.routePacks ?? new Map<string, number>();
  const machineRows = args.machines
    .filter((m) => ACTION_STATUSES.has(m.status))
    .map((m) => {
      const kind = m.status as Exclude<HemActionKind, "pris">;
      const loss = args.economy ? (m.economy?.lossProfitPerDayOre ?? null) : null;
      const row: HemAction = {
        key: `m:${m.id}`,
        kind,
        machineId: m.id,
        code: m.code,
        title: m.name,
        sub: [m.store?.name, m.code].filter(Boolean).join(" · "),
        badge: m.statusLabel,
        tone: TONE[kind],
        fillBp: m.fill?.fillBp ?? null,
        packs: kind === "offline" ? null : packsFor(m, routePacks),
        daysLeft: m.daysLeft,
        offlineSince: m.offlineSince,
        phone: m.store?.phone ?? null,
        contactName: m.store?.contactName ?? null,
        ...(args.economy && showsLoss(loss) ? { lossOre: loss } : {}),
      };
      return { row, loss, rank: FLEET_STATUS_RANK[m.status] };
    });

  const priceRows = (args.economy ? (args.prices ?? []) : []).map((p) => ({
    row: {
      key: `p:${p.titleId}`,
      kind: "pris" as const,
      machineId: null,
      code: null,
      title: `${p.name} går med förlust`,
      sub: "",
      badge: "Pris",
      tone: "critical" as const,
      fillBp: null,
      packs: null,
      daysLeft: null,
      offlineSince: null,
      phone: null,
      contactName: null,
      ...(showsLoss(p.lossOre) ? { lossOre: p.lossOre } : {}),
      price: {
        salePriceOre: p.salePriceOre,
        unitCostOre: p.unitCostOre,
        suggestedPriceOre: p.suggestedPriceOre,
        profitOre: p.profitOre,
      },
    } satisfies HemAction,
    loss: p.lossOre as number | null,
    rank: -1,
  }));

  const all = [...machineRows, ...priceRows];
  const rows = args.economy
    ? all
        .sort((a, b) =>
          compareByLoss(
            { lossOre: a.loss, daysLeft: a.row.daysLeft, code: a.row.code ?? a.row.title },
            { lossOre: b.loss, daysLeft: b.row.daysLeft, code: b.row.code ?? b.row.title },
          ),
        )
        .map((x) => x.row)
    : all
        .sort(
          (a, b) =>
            a.rank - b.rank ||
            (a.row.daysLeft ?? 9_999) - (b.row.daysLeft ?? 9_999) ||
            (a.row.code ?? "").localeCompare(b.row.code ?? "", "sv"),
        )
        .map((x) => x.row);

  const count = (s: FleetStatus) => args.machines.filter((m) => m.status === s).length;
  const off = args.machines.filter((m) => m.status === "strom-av");
  const ons = off
    .map((m) => m.store?.power ?? null)
    .filter((p): p is { off: string; on: string } => p !== null)
    .sort((a, b) => a.on.localeCompare(b.on));
  const first = ons[0] ?? null;
  return {
    rows,
    counts: {
      refill: count("tom") + count("fyll-pa"),
      offline: count("offline"),
      startklar: count("startklar"),
      badPricing: priceRows.length,
    },
    calm: {
      running: count("i-drift") + count("tom-snart"),
      powerOff: off.length,
      powerOnAt: first?.on ?? null,
      powerWindow: first ? `${first.off}–${first.on}` : null,
    },
    total: rows.length,
  };
}
