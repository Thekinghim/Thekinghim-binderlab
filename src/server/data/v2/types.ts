/**
 * Typer för V2:s gemensamma laddare (docs/design/v2/byggplan.md avsnitt 3.1–3.2). Hem,
 * Automater, Rutt och menyns räknare läser samma flottläge, så att alla visar samma status och
 * samma tal. Belopp (öre) finns bara i `economy`, som är null för roller som inte ser ekonomi
 * (påfyllaren): servern skickar dem aldrig.
 */

import type { FleetStatus, FleetStatusTone, MachineFill } from "@/analytics/fleet-status";
import type { GeoPoint } from "@/analytics/visits";
import type { Substitute, VisitDay, VisitStop } from "@/analytics/visits";
import type { IsoDate } from "@/domain";

/** Butiken automaten står i (aktuell placering). Kontaktuppgifter syns för alla roller. */
export interface FleetStore {
  readonly id: string;
  readonly name: string;
  readonly city: string | null;
  readonly address: string | null;
  readonly phone: string | null;
  readonly contactName: string | null;
  readonly location: GeoPoint | null;
  /** Strömtider ("21:00"–"08:00"), null = alltid på. */
  readonly power: { readonly off: string; readonly on: string } | null;
}

/** Bara för ägare, admin och läsare (ctx.canSeeEconomy). */
export interface FleetEconomy {
  /** Vinst per aktiv dag, 30 d (rangordningen). null = för få dagar/ingen försäljning. */
  readonly profitPerDayOre: number | null;
  /** Mot medianen (öre per dag). null utan median. */
  readonly vsMedianOre: number | null;
  /** Rangordningens omdöme ("weak" = tjänar dåligt, högst 50 % av medianen). */
  readonly verdict: string | null;
  /** Ungefär så mycket vinst per dag går förlorad tills någon gör något (3.6). */
  readonly lossProfitPerDayOre: number | null;
}

export interface FleetMachine {
  readonly id: string;
  readonly code: string;
  readonly name: string;
  readonly store: FleetStore | null;
  readonly status: FleetStatus;
  /** "Offline", "Tom", "Fyll på i dag", "Startklar", "Ström av", "Tom om 2 d", "I drift". */
  readonly statusLabel: string;
  readonly tone: FleetStatusTone;
  /** Fyllnaden enligt Awish (null = inte läst från Awish). */
  readonly fill: MachineFill | null;
  /** Pack i automaten: Awish-läsningen, annars lagret i appen. */
  readonly units: number | null;
  /** Sålda pack per dag (14 hela dagar t.o.m. i går), i tusendelar. */
  readonly unitsPerDayMilli: number;
  /** Hela dagar till tom (0 = tom). null = säljer inte. */
  readonly daysLeft: number | null;
  /** Senaste påfyllning (refill/transfer_in på automatens plats), ISO. */
  readonly lastRefillAt: string | null;
  /** Sålda pack per dag de senaste 30 dagarna (äldst först), för den lilla linjen. */
  readonly sales30: readonly number[];
  /** Strömmen är av just nu enligt butikens tider. */
  readonly powerOffNow: boolean;
  /** Maskinhälsan: sedan när automaten är offline (ISO), annars null. */
  readonly offlineSince: string | null;
  /** Titlar med tomma fack (titel-id). */
  readonly emptyTitleIds: readonly string[];
  readonly economy: FleetEconomy | null;
}

export interface FleetState {
  readonly today: IsoDate;
  /** Tidpunkten läget gäller (ISO). */
  readonly now: string;
  readonly timeZone: string;
  /** Aktiva automater, i listordning (status, dagar till tom, kod). */
  readonly machines: readonly FleetMachine[];
  readonly counts: Readonly<Record<FleetStatus, number>>;
  /** Ekonomin finns (ägare, admin, läsare). */
  readonly economy: boolean;
  /** Medianens vinst per dag (öre). Finns bara med ekonomi (fältet saknas annars). */
  readonly medianProfitPerDayOre?: number | null;
}

/* ------------------------------------------------------------------ */
/* Dagens rutt (3.2). F0 levererar typen och en första version som     */
/* bara mappar besöksplanens dag; G3 bygger vidare (route_day_changes, */
/* km/tid, kommande dagar, ersättare).                                 */
/* ------------------------------------------------------------------ */

export interface RouteStop {
  readonly machineId: string;
  readonly code: string;
  readonly name: string;
  /** 1, 2, 3 … i körordning. */
  readonly sequence: number;
  readonly store: FleetStore | null;
  readonly status: FleetStatus | null;
  /** Flottans statustext ("Fyll på i dag", "Tom om 2 d"). */
  readonly statusLabel: string | null;
  /** Pack att ta med. */
  readonly packs: number;
  readonly lines: VisitStop["packs"];
  readonly reasons: readonly string[];
  /** Påfyllt i dag (stock_events refill/transfer_in på automatens plats i dag). */
  readonly done: boolean;
  /** Bara ekonomiroller: förlorad vinst per dag (3.6). */
  readonly lossProfitPerDayOre: number | null;
  /** fill = fyll på; check = offline, kolla på plats (checklista). */
  readonly kind: "fill" | "check";
  /** Fack som väntas vara tomma vid besöket. */
  readonly emptySlots: number;
  /** Hela dagar till tom (flottans läge). */
  readonly daysLeft: number | null;
  /** Besöket görs efter senaste dag. */
  readonly late: boolean;
  /** Lagd i rutten för hand (eller flyttad från i går). */
  readonly added: boolean;
  /** "Strömmen av 21:00–08:00: fyll före 21:00", null = alltid på. */
  readonly power: string | null;
}

/** En gällande ändring i dagens rutt (route_day_changes). */
export interface RouteDayChangeRow {
  readonly id: string;
  readonly day: IsoDate;
  readonly machineId: string;
  readonly change: "skip" | "add" | "later";
}

/** En ändring som visas med Ångra. */
export interface RouteChange {
  readonly id: string;
  readonly machineId: string;
  readonly name: string;
  readonly change: "skip" | "add" | "later";
}

export interface RouteUpcomingDay {
  readonly date: IsoDate;
  readonly cities: readonly string[];
  readonly packs: number;
  readonly stops: readonly {
    readonly machineId: string;
    readonly name: string;
    readonly city: string | null;
    readonly daysLeft: number | null;
  }[];
}

export interface DayRoute {
  readonly date: IsoDate;
  readonly stops: readonly RouteStop[];
  /** Städerna i stoppordning ("Borås → Trollhättan"). */
  readonly cities: readonly string[];
  /** Stopp i följd i samma stad. */
  readonly groups: readonly {
    readonly city: string | null;
    readonly machineIds: readonly string[];
    readonly packs: number;
  }[];
  readonly totalPacks: number;
  /** Total sträcka (meter, fågelväg) med återresa, null utan koordinater. */
  readonly totalMeters: number | null;
  /** Vägsträckan "ca" i hela km (× 1,25), null utan koordinater. */
  readonly km: number | null;
  /** Tiden "ca" i minuter (körning + stopp), null utan km. */
  readonly minutes: number | null;
  readonly routeMethod: VisitDay["routeMethod"];
  /** Allt som ska lastas, per titel, med vårt lager och brist (brist först). */
  readonly load: readonly {
    readonly titleId: string;
    readonly titleName: string;
    readonly quantity: number;
    readonly shortBy: number;
    /** Vårt lager (alla egna lager), null = okänt. */
    readonly home: number | null;
  }[];
  /** Titlar där lagret inte räcker (Σ PackLine.shortBy). */
  readonly short: readonly {
    readonly titleId: string;
    readonly titleName: string;
    readonly shortBy: number;
  }[];
  /** Förslag på ersättare för fack som annars blir tomma. */
  readonly substitutes: readonly Substitute[];
  /** Bara ekonomiroller: vinst per dag som räddas av stoppen som inte är klara. */
  readonly savesProfitPerDayOre: number | null;
  /** Hoppade över / till i morgon i dag (för Ångra). */
  readonly removed: readonly RouteChange[];
  /** Lagda i rutten i dag (för Ångra). */
  readonly added: readonly RouteChange[];
  /** Planens kommande dagar. */
  readonly upcoming: readonly RouteUpcomingDay[];
  /** Ruttens start (standardlagret). */
  readonly depot: {
    readonly name: string;
    readonly address: string | null;
    readonly location: GeoPoint | null;
  } | null;
  /** Dagens gräns (inställningarna, route_settings). */
  readonly limits: RouteLimits;
  /** I dag är en ruttdag (route_weekdays). */
  readonly routeDay: boolean;
  /** Nästa ruttdag efter i dag, eller null. */
  readonly nextRouteDay: IsoDate | null;
  /** Automater med "Tom" eller "Fyll på i dag" i flottan. */
  readonly needing: number;
  /** Automater som inte ryms i veckans rutter med dagens gräns. */
  readonly overflow: readonly { readonly machineId: string; readonly name: string }[];
}

export interface RouteLimits {
  readonly maxStops: number;
  readonly maxPacks: number;
  /** 1 = måndag … 7 = söndag. */
  readonly weekdays: readonly number[];
}
