import { navSections, routesForRole, type Role, type RouteId } from "@/components/shell/nav";

/** En rad i en grupp på Mer: sidan, med flikens namn ("Lager i automaterna"). */
export type MoreLink = { id: RouteId; href: string; label: string; lead: string };
export type MoreGroup = { id: string; title: string; links: MoreLink[] };

/** Gruppnamnen på Mer (huvudflikens namn, och "Mer" blir "Övrigt"). */
const TITLE: Record<string, string> = { mer: "Övrigt" };

/**
 * Sidorna på Mer, grupperade efter huvudflik (Hem, Automater, Vårt lager, Butiker, Pengar,
 * Övrigt), varje sida en gång. `exclude` är sidorna som redan står på Mer eller i bottenraden
 * (Automater, Rutt, Inställningar under Driften …). Vyer på en sida (?vy=) får ingen egen rad.
 * Sidor som rollen ser men som inte står under någon flik hamnar under Övrigt.
 */
export function moreGroups(role: Role, exclude: ReadonlySet<RouteId>): MoreGroup[] {
  const allowed = new Map(routesForRole(role).map((r) => [r.id, r]));
  const seen = new Set<RouteId>(exclude);
  const groups: MoreGroup[] = [];
  const add = (id: string, title: string, links: MoreLink[]) => {
    if (links.length > 0) groups.push({ id, title, links });
  };
  for (const section of navSections) {
    const links: MoreLink[] = [];
    for (const t of section.tabs) {
      const r = allowed.get(t.route);
      if (!r || t.view !== undefined || seen.has(t.route)) continue;
      if (t.roles && !t.roles.includes(role)) continue;
      seen.add(t.route);
      links.push({ id: r.id, href: r.href, label: t.label, lead: r.lead });
    }
    if (section.id === "mer") {
      // Sidor utan flik (t.ex. Assistent) står under Övrigt.
      for (const r of allowed.values()) {
        if (seen.has(r.id) || r.group === "hidden") continue;
        seen.add(r.id);
        links.push({ id: r.id, href: r.href, label: r.label, lead: r.lead });
      }
    }
    add(section.id, TITLE[section.id] ?? section.label, links);
  }
  return groups;
}
