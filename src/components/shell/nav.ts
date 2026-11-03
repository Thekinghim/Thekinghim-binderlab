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
  | "vart-lager"
  | "automater"
  | "kampanjer"
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
  /**
   * more: under den hopfällbara gruppen "Mer" i sidomenyn.
   * hidden: inte i sidomenyn (nås via länkar på andra sidor, ⌘K och mobilens ark).
   */
  group?: "more" | "hidden";
  /** false: aldrig i sidomenyn eller mobilens ark (nås via toppraden och ⌘K). */
  menu?: false;
  roles: ReadonlyArray<Role>;
  /** Lägre tal = viktigare på mobil. Saknas = aldrig i bottenraden. */
  mobileRank?: number;
  /** Rutten bär en räknare för sådant som kräver åtgärd. */
  counter?: "todo";
  /** false: sidan har inget periodval eller filter (kontextraden döljs). */
  context?: false;
  /** false: sidan visar ingen vinst som vyknappen "Med VMB" ändrar (knappen döljs). */
  vmb?: false;
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
    id: "vart-lager",
    href: "/vart-lager",
    label: "Vårt lager",
    icon: "inventory",
    section: "main",
    // Samma roller som Prognos & inköp (sidan visar värdet till inköpspris).
    roles: READERS,
    phase: 6,
    lead: "Pack i lager, per titel.",
    context: false,
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
    id: "kampanjer",
    group: "hidden",
    href: "/kampanjer",
    label: "Kampanjer",
    icon: "sales",
    section: "main",
    roles: READERS,
    phase: 12,
    lead: "Kampanjer på skärmen och gratis-pack.",
    context: false,
    vmb: false,
  },
  {
    id: "butiker",
    group: "more",
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
    group: "more",
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
    group: "more",
    href: "/prognos",
    label: "Inköp",
    icon: "sales",
    section: "main",
    roles: READERS,
    phase: 6,
    lead: "Vad som säljer de kommande fyra veckorna och vad som ska beställas.",
  },
  {
    id: "expansion",
    group: "more",
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
    group: "more",
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
    group: "more",
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
    group: "more",
    href: "/ekonomi",
    label: "Ekonomi",
    icon: "margin",
    section: "main",
    roles: READERS,
    phase: 9,
    lead: "Avstämning, bokföring och kassaflöde.",
    vmb: false,
  },
  {
    id: "avtal",
    group: "hidden",
    href: "/avtal",
    // Sidan heter Kontrakt (/kontrakt pekar hit); "avtal" finns kvar som sökord i ⌘K.
    label: "Kontrakt",
    icon: "report",
    section: "main",
    roles: READERS,
    phase: 9,
    lead: "Kontrakt och avtal med butikerna.",
    // Sidan har inget periodval: Intäkt-fliken gäller alltid 12 månader.
    context: false,
    vmb: false,
  },
  {
    id: "marknad",
    group: "more",
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
    group: "hidden",
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
    menu: false,
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

/** Rutterna som syns i menyerna (sidomenyn och mobilens ark). */
export function menuRoutesForRole(role: Role): ShellRoute[] {
  return routesForRole(role).filter((r) => r.menu !== false);
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

/* ------------------------------------------------------------------ */
/* Huvudflikar och underflikar                                          */
/* ------------------------------------------------------------------ */

/** De sex huvudflikarna i sidomenyn och mobilens bottenrad. */
export type SectionId = "hem" | "automater" | "vart-lager" | "butiker" | "pengar" | "mer";

/** En underflik: en rutt (som ger behörigheten) och eventuellt en vy på sidan (?vy=). */
export type SubTab = {
  /** Unik nyckel (rutt-id, eller rutt-id och vy). */
  key: string;
  label: string;
  route: RouteId;
  /** Sidans vy (?vy=…). Ges den räknas också /<rutt>/<vy>/… hit. */
  view?: string;
};

export type NavSection = {
  id: SectionId;
  label: string;
  icon: IconName;
  tabs: ReadonlyArray<SubTab>;
};

const tab = (route: RouteId, label: string, view?: string): SubTab => ({
  key: view ? `${route}:${view}` : route,
  label,
  route,
  view,
});

export const navSections: ReadonlyArray<NavSection> = [
  {
    id: "hem",
    label: "Hem",
    icon: "overview",
    tabs: [tab("hem", "Översikt"), tab("att-gora", "Att göra")],
  },
  {
    id: "automater",
    label: "Automater",
    icon: "machine",
    tabs: [
      tab("automater", "Automater"),
      tab("drift", "Drift"),
      tab("lager", "Lager i automaterna"),
      tab("order", "Order"),
      tab("automater", "Svinn", "svinn"),
      tab("inkorg", "Inkorg"),
      tab("kampanjer", "Kampanjer"),
      tab("kampanjer", "Gratis-pack", "gratis-pack"),
    ],
  },
  {
    id: "vart-lager",
    label: "Vårt lager",
    icon: "inventory",
    tabs: [
      tab("vart-lager", "Vårt lager"),
      tab("prognos", "Inköp"),
      tab("prognos", "Prognos", "prognos"),
      tab("inkopspriser", "Inköpspriser"),
    ],
  },
  {
    id: "butiker",
    label: "Butiker",
    icon: "columns",
    tabs: [
      tab("butiker", "Butiker"),
      tab("avtal", "Kontrakt"),
      tab("expansion", "Expansion"),
      tab("butiker", "Butiksportal", "portal"),
    ],
  },
  {
    id: "pengar",
    label: "Pengar",
    icon: "margin",
    tabs: [
      tab("lonsamhet", "Lönsamhet"),
      tab("ekonomi", "Ekonomi"),
      tab("ekonomi", "Bokföring", "bokforing"),
      tab("rapporter", "Rapporter"),
    ],
  },
  {
    id: "mer",
    label: "Mer",
    icon: "more",
    tabs: [
      tab("installningar", "Inställningar"),
      tab("datakallor", "Datakällor"),
      tab("assistent", "Assistent"),
      tab("marknad", "Marknad"),
      tab("effekt", "Effekt"),
    ],
  },
];

/** Underflikens adress (utan period och filter). */
export function subTabHref(t: SubTab): string {
  const href = routeById(t.route).href;
  return t.view ? `${href}?vy=${encodeURIComponent(t.view)}` : href;
}

/** Huvudflikarna en roll ser, med bara de underflikar rollen får se. Tomma flikar döljs. */
export function sectionsForRole(role: Role): NavSection[] {
  return navSections
    .map((s) => ({ ...s, tabs: s.tabs.filter((t) => routeById(t.route).roles.includes(role)) }))
    .filter((s) => s.tabs.length > 0);
}

/** Huvudflikens adress: första underfliken rollen får se. */
export function sectionHref(section: NavSection): string {
  const first = section.tabs[0];
  return first ? subTabHref(first) : "/";
}

/** Huvudfliken som innehåller rutten. */
export function sectionOfRoute(id: RouteId): NavSection | null {
  return navSections.find((s) => s.tabs.some((t) => t.route === id)) ?? null;
}

/** Huvudflik för en sökväg (även undersidor, t.ex. /drift/pafyllning → Automater). */
export function activeSectionId(pathname: string | null | undefined): SectionId | null {
  const id = activeRouteId(pathname);
  return id ? (sectionOfRoute(id)?.id ?? null) : null;
}

/**
 * Aktiv underflik för en sökväg och vy (?vy=). Flera flikar på samma rutt (Ekonomi och
 * Bokföring) skiljs åt av vyn: fliken med vyn vinner när vyn eller /<rutt>/<vy>/… matchar.
 */
export function activeSubTab(
  pathname: string | null | undefined,
  view?: string | null,
): { section: NavSection; tab: SubTab } | null {
  const id = activeRouteId(pathname);
  if (!id) return null;
  const section = sectionOfRoute(id);
  if (!section) return null;
  const candidates = section.tabs.filter((t) => t.route === id);
  const base = routeById(id).href;
  const path = pathname ?? "";
  const viewed = candidates.find(
    (t) =>
      t.view !== undefined &&
      (t.view === view || path === `${base}/${t.view}` || path.startsWith(`${base}/${t.view}/`)),
  );
  const tab = viewed ?? candidates.find((t) => t.view === undefined) ?? candidates[0];
  return tab ? { section, tab } : null;
}
