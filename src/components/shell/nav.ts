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
  | "mystery"
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
  | "varde"
  | "assistent"
  | "datakallor"
  | "installningar"
  // V2 (docs/design/v2/byggplan.md, avsnitt 1.1): nya sidor.
  | "rutt"
  | "pengar"
  // Utbetalningar från Nayax: vem som ska ha vad (/pengar/utbetalningar).
  | "utbetalningar"
  | "mer";

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
    // V2 (G1): påfyllaren ser Hem utan belopp (servern tar bort dem, _hem/v2/today-data.ts).
    roles: ALL,
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
    id: "mystery",
    group: "hidden",
    href: "/vart-lager/mystery",
    label: "Mystery packs",
    icon: "inventory",
    section: "main",
    // Påfyllaren packar också (innehållet och saldot, inga belopp).
    roles: ALL,
    phase: 14,
    lead: "Innehåll och packning av egna mystery packs.",
    context: false,
    vmb: false,
  },
  {
    id: "automater",
    href: "/automater",
    label: "Automater",
    icon: "machine",
    section: "main",
    // V2: påfyllaren ser listan och facken utan belopp (servern tar bort dem). Automatens
    // sida, Svinn och Enhetsekonomi skickar påfyllaren hit (requireAutomaterEconomy).
    roles: ALL,
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
    lead: "Placeringar, avtal och utfall.",
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
    // Status, Besök, Påfyllning och Notiser räknar på i dag och veckan framåt (automatsidan
    // väljer dagar själv): skalets period och filter gäller inte här.
    context: false,
    vmb: false,
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
    id: "varde",
    group: "more",
    href: "/varde",
    label: "Värde",
    icon: "arrowUpRight",
    section: "main",
    // Ägare och admin: sidan räknar sparad tid och visar butikernas andel per butik.
    roles: OPERATORS,
    phase: 13,
    lead: "Vad Binderlab gett dig, månad för månad.",
    // Sidan väljer månad själv (?manad); skalets period och filter gäller inte här.
    context: false,
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
    lead: "Nya kortsläpp, priser och sortiment.",
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
    // Frågorna säger själva vilken period de gäller; förslagen gäller alltid 30 dagar.
    context: false,
    vmb: false,
  },
  // V2: Rutt, Pengar och Mer. De står i V2-menyn (v2Nav nedan), inte i de gamla grupperna.
  {
    id: "rutt",
    group: "hidden",
    href: "/rutt",
    label: "Rutt",
    icon: "machine",
    section: "main",
    roles: ALL,
    phase: 15,
    lead: "Dagens rutt: stopp, packlista och vägen dit.",
    context: false,
    vmb: false,
  },
  {
    id: "pengar",
    group: "hidden",
    href: "/pengar",
    label: "Pengar",
    icon: "margin",
    section: "main",
    roles: READERS,
    phase: 15,
    lead: "Resultat, vinst per automat och det som ska betalas.",
  },
  {
    id: "utbetalningar",
    group: "hidden",
    href: "/pengar/utbetalningar",
    label: "Utbetalningar",
    icon: "margin",
    section: "main",
    // Partnerns andel och vårt inköp syns här: bara ägare och admin.
    roles: OPERATORS,
    phase: 16,
    lead: "Pengarna från Nayax: vem som ska ha vad.",
    context: false,
    vmb: false,
  },
  {
    id: "mer",
    group: "hidden",
    href: "/mer",
    label: "Mer",
    icon: "more",
    section: "main",
    roles: ALL,
    phase: 15,
    lead: "Alla sidor, inställningar och kopplingar.",
    context: false,
    vmb: false,
  },
  {
    id: "datakallor",
    href: "/datakallor",
    label: "Datakällor",
    icon: "download",
    section: "system",
    roles: OPERATORS,
    phase: 2,
    lead: "Var siffrorna kommer ifrån (Awish).",
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
  /** Kortare namn på mobil (smal skärm), t.ex. "Lager" för "Lager i automaterna". */
  short?: string;
  route: RouteId;
  /** Sidans vy (?vy=…). Ges den räknas också /<rutt>/<vy>/… hit. */
  view?: string;
  /** Mindre använd: ligger under underfliken "Mer" när huvudfliken har många flikar. */
  more?: true;
  /**
   * false: vyn har inget periodval eller filter (kontextraden döljs), fast rutten har det.
   * Inköp räknar på lagret i dag och en prognos framåt, Bokföring på hela månader och
   * Butiksportal på förra månaden.
   */
  context?: false;
  /** Bara de här rollerna ser fliken (utöver ruttens roller), t.ex. Svinn under Automater. */
  roles?: ReadonlyArray<Role>;
};

type TabOptions = Pick<SubTab, "short" | "more" | "context" | "roles">;

export type NavSection = {
  id: SectionId;
  label: string;
  /** Kortare ord i mobilens bottenrad på smala skärmar (under 360 px), t.ex. "Automat". */
  short?: string;
  icon: IconName;
  tabs: ReadonlyArray<SubTab>;
};

const tab = (route: RouteId, label: string, view?: string, options: TabOptions = {}): SubTab => ({
  key: view ? `${route}:${view}` : route,
  label,
  route,
  view,
  ...options,
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
    short: "Automat",
    icon: "machine",
    tabs: [
      tab("automater", "Automater"),
      tab("drift", "Drift"),
      tab("lager", "Lager i automaterna", undefined, { short: "Lager" }),
      tab("order", "Order"),
      // Mindre använda: under "Mer", så att de fyra viktigaste får plats på mobilen.
      tab("automater", "Svinn", "svinn", { more: true, roles: READERS }),
      tab("inkorg", "Inkorg", undefined, { more: true }),
      tab("kampanjer", "Kampanjer", undefined, { more: true }),
      tab("kampanjer", "Gratis-pack", "gratis-pack", { more: true }),
    ],
  },
  {
    id: "vart-lager",
    label: "Vårt lager",
    short: "Lager",
    icon: "inventory",
    tabs: [
      tab("vart-lager", "Vårt lager"),
      tab("mystery", "Mystery packs", undefined, { short: "Mystery" }),
      tab("prognos", "Inköp", undefined, { context: false }),
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
      // Bolagen som äger butikerna (?vy=agare); perioden och filtret gäller inte här.
      tab("butiker", "Butiksägare", "agare", { short: "Ägare", context: false }),
      tab("avtal", "Kontrakt"),
      tab("expansion", "Expansion"),
      tab("butiker", "Utbetalning", "utbetalning", { context: false }),
    ],
  },
  {
    id: "pengar",
    label: "Pengar",
    icon: "margin",
    tabs: [
      tab("lonsamhet", "Lönsamhet"),
      tab("ekonomi", "Ekonomi"),
      tab("utbetalningar", "Utbetalningar"),
      tab("ekonomi", "Bokföring", "bokforing", { context: false }),
      tab("rapporter", "Rapporter"),
      tab("varde", "Värde"),
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
    .map((s) => ({
      ...s,
      tabs: s.tabs.filter(
        (t) => routeById(t.route).roles.includes(role) && (!t.roles || t.roles.includes(role)),
      ),
    }))
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

/**
 * Visar skalet periodval och filter (kontextraden) på sidan? Nej för rutter med
 * context: false och för underflikar med context: false (Inköp, Bokföring, Butiksportal),
 * där perioden inte ändrar något på sidan.
 */
export function showsContext(pathname: string | null | undefined, view?: string | null): boolean {
  const id = activeRouteId(pathname);
  if (id && routeById(id).context === false) return false;
  return activeSubTab(pathname, view)?.tab.context !== false;
}

/** Flikar som får plats i raden innan de mindre använda läggs under "Mer". */
export const SUB_TAB_INLINE_MAX = 5;

/**
 * Underflikarna i raden och under "Mer". Med fler än SUB_TAB_INLINE_MAX flikar läggs de
 * mindre använda (more: true) under "Mer"; annars står alla i raden (påfyllaren har tre).
 */
export function splitSubTabs(tabs: ReadonlyArray<SubTab>): {
  inline: SubTab[];
  more: SubTab[];
} {
  if (tabs.length <= SUB_TAB_INLINE_MAX) return { inline: [...tabs], more: [] };
  const inline = tabs.filter((t) => !t.more);
  const more = tabs.filter((t) => t.more);
  // En ensam flik under "Mer" är ett klick för mycket: då står den i raden.
  return more.length < 2 ? { inline: [...tabs], more: [] } : { inline, more };
}

/* ------------------------------------------------------------------ */
/* V2-menyn (docs/design/v2/byggplan.md, avsnitt 1.1)                  */
/* ------------------------------------------------------------------ */

/** V2:s nya sidor. De står bara i V2-menyn, inte under de gamla huvudflikarna (underflikarna). */
export const V2_ONLY_ROUTES: ReadonlySet<RouteId> = new Set<RouteId>(["rutt", "pengar", "mer"]);

/** De sju posterna i V2:s sidomeny. Mobilens bottenrad har fem (mobile: true). */
export type V2NavId = "hem" | "automater" | "rutt" | "vart-lager" | "butiker" | "pengar" | "mer";

/** Ikonerna i V2-menyn (src/components/v2/shell/nav-icon.tsx), ritade som i prototypen. */
export type V2NavIcon = V2NavId | "meny";

export type V2NavItem = {
  readonly id: V2NavId;
  readonly label: string;
  /** Namnet i mobilens bottenrad ("Lager"). */
  readonly short?: string;
  /**
   * Rutterna posten kan leda till, i ordning: posten länkar till den första som rollen får
   * se (påfyllaren får Att göra under Hem tills Hem är byggt för påfyllaren). Ingen = dold.
   */
  readonly routes: ReadonlyArray<RouteId>;
  /** Med i mobilens bottenrad. Butiker och Pengar ligger överst på Mer på mobilen. */
  readonly mobile: boolean;
  /** Ikonen i mobilens bottenrad (Mer ritas som tre streck där). */
  readonly mobileIcon?: V2NavIcon;
  /** Räknaren vid posten. */
  readonly counter?: "todo" | "rutt";
};

export const v2Nav: ReadonlyArray<V2NavItem> = [
  { id: "hem", label: "Hem", routes: ["hem", "att-gora"], mobile: true, counter: "todo" },
  { id: "automater", label: "Automater", routes: ["automater", "drift"], mobile: true },
  { id: "rutt", label: "Rutt", routes: ["rutt"], mobile: true, counter: "rutt" },
  {
    id: "vart-lager",
    label: "Vårt lager",
    short: "Lager",
    routes: ["vart-lager", "mystery"],
    mobile: true,
  },
  { id: "butiker", label: "Butiker", routes: ["butiker"], mobile: false },
  { id: "pengar", label: "Pengar", routes: ["pengar"], mobile: false },
  { id: "mer", label: "Mer", routes: ["mer"], mobile: true, mobileIcon: "meny" },
];

/** En post i V2-menyn som rollen ser, med adress. */
export type V2NavLink = V2NavItem & { readonly href: string };

/** V2-menyns poster för rollen (sidomenyn), med adress till första rutten rollen får se. */
export function v2NavForRole(role: Role): V2NavLink[] {
  return v2Nav.flatMap((item) => {
    const route = item.routes.map(routeById).find((r) => r.roles.includes(role));
    return route ? [{ ...item, href: route.href }] : [];
  });
}

/** Mobilens bottenrad för rollen (högst fem). */
export function v2MobileNavForRole(role: Role): V2NavLink[] {
  return v2NavForRole(role).filter((i) => i.mobile);
}

/**
 * V2-posten som är aktiv på en sökväg. De gamla sidorna hör till sin gamla huvudflik
 * (Drift → Automater, Lönsamhet → Pengar, Inställningar → Mer); besöksplanen hör till Rutt.
 */
export function activeV2NavId(pathname: string | null | undefined): V2NavId | null {
  if (!pathname) return null;
  const path = pathname.length > 1 ? pathname.replace(/\/+$/, "") : pathname;
  if (path === "/drift/besok" || path.startsWith("/drift/besok/")) return "rutt";
  const id = activeRouteId(path);
  if (!id) return null;
  if (id === "rutt" || id === "pengar" || id === "mer") return id;
  const section = sectionOfRoute(id)?.id ?? null;
  // Sidor som inte står under någon gammal flik (Assistent m.fl.) hör till Mer.
  return section ?? "mer";
}
