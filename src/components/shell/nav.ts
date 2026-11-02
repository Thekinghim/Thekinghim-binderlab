import type { IconName } from "@/components/ui/icon";

/**
 * Navigationsmodellen för skalet. Ren data och rena funktioner, så att
 * samma regler gäller i sidomenyn, mobilens bottenrad, "Mer"-arket och
 * kommandopaletten, och kan användas på servern (t.ex. för behörighet).
 */

/**
 * Roller i skalet. "store" är butiksportalens roll: den ser inga appmenyer (ingen rutt
 * nämner den) och skickas till /portal, som har ett eget skal (src/app/portal).
 */
export type Role = "owner" | "admin" | "refiller" | "viewer" | "store";

/** Butiksportalens startsida. */
export const PORTAL_HREF = "/portal";

export const roleLabel: Record<Role, string> = {
  owner: "Ägare",
  admin: "Administratör",
  refiller: "Påfyllare",
  viewer: "Läsare",
  store: "Butik",
};

export type RouteId =
  | "hem"
  | "att-gora"
  | "lonsamhet"
  | "order"
  | "lager"
  | "automater"
  | "butiker"
  | "inkopspriser"
  | "rapporter"
  | "prognos"
  | "expansion"
  | "drift"
  | "inkorg"
  | "ekonomi"
  | "avtal"
  | "marknad"
  | "effekt"
  | "assistent"
  | "datakallor"
  | "installningar";

export type ShellRoute = {
  id: RouteId;
  href: string;
  label: string;
  /** Används bara i mobilens bottenrad och i kommandopaletten, aldrig i sidomenyn. */
  icon: IconName;
  /** main: huvudlistan. system: längst ner i sidomenyn. */
  section: "main" | "system";
  roles: ReadonlyArray<Role>;
  /** Lägre tal = viktigare på mobil. Saknas = aldrig i bottenraden. */
  mobileRank?: number;
  /** Rutten bär en räknare för sådant som kräver åtgärd. */
  counter?: "todo";
  /** false: sidan har inget periodval eller filter (kontextraden döljs). */
  context?: false;
  /** Fasen då sidan byggs (platshållarna visar den). */
  phase: number;
  /** Andra delen av rubriken på platshållaren. */
  lead: string;
};

const ALL: ReadonlyArray<Role> = ["owner", "admin", "refiller", "viewer"];
const READERS: ReadonlyArray<Role> = ["owner", "admin", "viewer"];
const OPERATORS: ReadonlyArray<Role> = ["owner", "admin"];

export const shellRoutes: ReadonlyArray<ShellRoute> = [
  {
    id: "hem",
    href: "/",
    label: "Hem",
    icon: "overview",
    section: "main",
    roles: READERS,
    mobileRank: 1,
    phase: 3,
    lead: "Dagens läge i hela flottan.",
  },
  {
    id: "att-gora",
    href: "/att-gora",
    label: "Att göra",
    icon: "check",
    section: "main",
    roles: ["owner", "admin", "refiller"],
    mobileRank: 2,
    counter: "todo",
    phase: 3,
    lead: "Det som kräver åtgärd nu.",
    context: false,
  },
  {
    id: "lonsamhet",
    href: "/lonsamhet",
    label: "Lönsamhet",
    icon: "margin",
    section: "main",
    roles: READERS,
    mobileRank: 3,
    phase: 4,
    lead: "Per automat, butik och period.",
  },
  {
    id: "order",
    href: "/order",
    label: "Order",
    icon: "sales",
    section: "main",
    roles: READERS,
    mobileRank: 6,
    phase: 5,
    lead: "Varje order, sökbar och exporterbar.",
  },
  {
    id: "lager",
    href: "/lager",
    label: "Lager",
    icon: "inventory",
    section: "main",
    roles: ALL,
    mobileRank: 4,
    phase: 5,
    lead: "Per artikel och automat.",
  },
  {
    id: "automater",
    href: "/automater",
    label: "Automater",
    icon: "machine",
    section: "main",
    roles: READERS,
    mobileRank: 5,
    phase: 5,
    lead: "Status, försäljning och påfyllning.",
  },
  {
    id: "butiker",
    href: "/butiker",
    label: "Butiker",
    icon: "columns",
    section: "main",
    roles: READERS,
    phase: 5,
    lead: "Placeringar, hyra och utfall.",
  },
  {
    id: "inkopspriser",
    href: "/inkopspriser",
    label: "Inköpspriser",
    icon: "filter",
    section: "main",
    roles: READERS,
    phase: 4,
    lead: "Pris per artikel över tid.",
  },
  {
    id: "rapporter",
    href: "/rapporter",
    label: "Rapporter",
    icon: "report",
    section: "main",
    roles: READERS,
    mobileRank: 7,
    // Sidan väljer månad själv (?manad); skalets period och filter gäller inte här.
    context: false,
    phase: 6,
    lead: "Utskick och underlag.",
  },
  {
    id: "prognos",
    href: "/prognos",
    label: "Prognos & inköp",
    icon: "sales",
    section: "main",
    roles: READERS,
    phase: 6,
    lead: "Vad som säljer de kommande fyra veckorna och vad som ska beställas.",
  },
  {
    id: "expansion",
    href: "/expansion",
    label: "Expansion",
    icon: "arrowUpRight",
    section: "main",
    roles: READERS,
    phase: 6,
    lead: "Nya platser, scenarier och mål.",
  },
  {
    id: "drift",
    href: "/drift",
    label: "Drift",
    icon: "machine",
    section: "main",
    roles: ALL,
    phase: 8,
    lead: "Maskinhälsa, larm och besöksplan.",
  },
  {
    id: "inkorg",
    href: "/inkorg",
    label: "Inkorg",
    icon: "info",
    section: "main",
    roles: ALL,
    phase: 8,
    lead: "Kundärenden och återbetalningar.",
  },
  {
    id: "ekonomi",
    href: "/ekonomi",
    label: "Ekonomi",
    icon: "margin",
    section: "main",
    roles: READERS,
    phase: 9,
    lead: "Avstämning, bokföring och kassaflöde.",
  },
  {
    id: "avtal",
    href: "/avtal",
    label: "Avtal",
    icon: "report",
    section: "main",
    roles: READERS,
    phase: 9,
    lead: "Butiksavtal, villkor och förfallodatum.",
  },
  {
    id: "marknad",
    href: "/marknad",
    label: "Marknad",
    icon: "overview",
    section: "main",
    roles: READERS,
    phase: 11,
    lead: "Releaser, priser och sortiment.",
  },
  {
    id: "effekt",
    href: "/effekt",
    label: "Effekt",
    icon: "check",
    section: "main",
    roles: READERS,
    phase: 10,
    lead: "Förbättringen mot läget före Binderlab.",
  },
  {
    id: "assistent",
    href: "/assistent",
    label: "Assistent",
    icon: "search",
    section: "main",
    roles: ["owner", "admin", "refiller", "viewer"],
    phase: 6,
    lead: "Fråga om er data på svenska.",
  },
  {
    id: "datakallor",
    href: "/datakallor",
    label: "Datakällor",
    icon: "download",
    section: "system",
    roles: OPERATORS,
    phase: 2,
    lead: "Import och synk.",
    context: false,
  },
  {
    id: "installningar",
    href: "/installningar",
    label: "Inställningar",
    icon: "settings",
    section: "system",
    roles: OPERATORS,
    phase: 2,
    lead: "Organisation, användare och roller.",
    context: false,
  },
];

/** Rutterna en roll ser, i menyordning. */
export function routesForRole(role: Role): ShellRoute[] {
  return shellRoutes.filter((r) => r.roles.includes(role));
}

/** Rollens startsida: första rutten den får se (Hem, eller Att göra för påfyllare). */
export function homeHref(role: Role): string {
  if (role === "store") return PORTAL_HREF;
  return routesForRole(role)[0]?.href ?? "/";
}

/** Sökparametern som säger vilken sida användaren skickades bort från (requireRoute). */
export const DENIED_PARAM = "nekad";

/**
 * Dit requireRoute skickar den som saknar behörighet: rollens startsida med
 * `?nekad=<rutt>`, så att startsidan kan förklara varför (DeniedNotice i skalet).
 */
export function deniedHref(role: Role, id: RouteId): string {
  return `${homeHref(role)}?${DENIED_PARAM}=${encodeURIComponent(id)}`;
}

/** "ägare och administratör", "ägare, administratör och läsare". */
function rolesText(roles: ReadonlyArray<Role>): string {
  const names = roles.map((r) => roleLabel[r].toLowerCase());
  return names.length <= 1
    ? (names[0] ?? "")
    : `${names.slice(0, -1).join(", ")} och ${names[names.length - 1]}`;
}

/**
 * Förklaringen på startsidan efter en nekad sida, eller null för ett okänt eller
 * tillåtet värde (en manipulerad länk visar ingenting).
 */
export function deniedNotice(
  role: Role,
  value: string | null | undefined,
): { title: string; description: string } | null {
  const route = shellRoutes.find((r) => r.id === value);
  if (!route || route.roles.includes(role)) return null;
  const home = routesForRole(role)[0];
  return {
    title: `Du har inte tillgång till ${route.label}.`,
    description:
      `Sidan är för ${rolesText(route.roles)}. Du är inloggad som ${roleLabel[role].toLowerCase()}` +
      (home ? ` och kom till ${home.label} i stället.` : "."),
  };
}

/** Rutten med ett visst id. */
export function routeById(id: RouteId): ShellRoute {
  const r = shellRoutes.find((x) => x.id === id);
  if (!r) throw new Error(`Okänd rutt: ${id}`);
  return r;
}

/** Högst `max` rutter till mobilens bottenrad (resten nås via "Mer"). */
export function primaryMobileRoutes(role: Role, max = 4): ShellRoute[] {
  return routesForRole(role)
    .filter((r) => r.mobileRank !== undefined)
    .sort((a, b) => (a.mobileRank ?? 0) - (b.mobileRank ?? 0))
    .slice(0, max);
}

/**
 * Aktiv rutt för en sökväg: exakt träff, annars längsta prefix
 * (/automater/bl-006 → Automater). "/" matchar bara sig själv.
 */
export function activeRouteId(pathname: string | null | undefined): RouteId | null {
  if (!pathname) return null;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  let best: ShellRoute | null = null;
  for (const r of shellRoutes) {
    const hit = r.href === "/" ? path === "/" : path === r.href || path.startsWith(`${r.href}/`);
    if (hit && (!best || r.href.length > best.href.length)) best = r;
  }
  return best?.id ?? null;
}
