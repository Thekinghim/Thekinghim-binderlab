import type { IconName } from "@/components/ui/icon";

/**
 * Navigationsmodellen för skalet. Ren data och rena funktioner, så att
 * samma regler gäller i sidomenyn, mobilens bottenrad, "Mer"-arket och
 * kommandopaletten, och kan användas på servern (t.ex. för behörighet).
 */

export type Role = "owner" | "admin" | "refiller" | "viewer";

export const roleLabel: Record<Role, string> = {
  owner: "Ägare",
  admin: "Administratör",
  refiller: "Påfyllare",
  viewer: "Läsare",
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
  },
  {
    id: "lonsamhet",
    href: "/lonsamhet",
    label: "Lönsamhet",
    icon: "margin",
    section: "main",
    roles: READERS,
    mobileRank: 3,
  },
  {
    id: "order",
    href: "/order",
    label: "Order",
    icon: "sales",
    section: "main",
    roles: READERS,
    mobileRank: 6,
  },
  {
    id: "lager",
    href: "/lager",
    label: "Lager",
    icon: "inventory",
    section: "main",
    roles: ALL,
    mobileRank: 4,
  },
  {
    id: "automater",
    href: "/automater",
    label: "Automater",
    icon: "machine",
    section: "main",
    roles: READERS,
    mobileRank: 5,
  },
  {
    id: "butiker",
    href: "/butiker",
    label: "Butiker",
    icon: "columns",
    section: "main",
    roles: READERS,
  },
  {
    id: "inkopspriser",
    href: "/inkopspriser",
    label: "Inköpspriser",
    icon: "filter",
    section: "main",
    roles: READERS,
  },
  {
    id: "rapporter",
    href: "/rapporter",
    label: "Rapporter",
    icon: "report",
    section: "main",
    roles: READERS,
    mobileRank: 7,
  },
  {
    id: "datakallor",
    href: "/datakallor",
    label: "Datakällor",
    icon: "download",
    section: "system",
    roles: OPERATORS,
  },
  {
    id: "installningar",
    href: "/installningar",
    label: "Inställningar",
    icon: "settings",
    section: "system",
    roles: OPERATORS,
  },
];

/** Rutterna en roll ser, i menyordning. */
export function routesForRole(role: Role): ShellRoute[] {
  return shellRoutes.filter((r) => r.roles.includes(role));
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
