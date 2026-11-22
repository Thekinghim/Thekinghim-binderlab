/**
 * Sidorna i src/app: varje page.tsx blir ett mönster (/automater/[automat]). Ruttgrupper
 * "(app)", privata mappar "_x" och parallella "@x" påverkar inte adressen. api, /plattform,
 * /datamodell och /design granskas inte.
 */

import { readdirSync, statSync } from "node:fs";
import path from "node:path";

export const EXCLUDED_PREFIXES = ["/api", "/plattform", "/datamodell", "/design"] as const;

export interface RoutePattern {
  /** "/automater/[automat]" */
  pattern: string;
  /** Filen, relativt projektet. */
  file: string;
  /** Namnen på de dynamiska delarna, i ordning. */
  params: string[];
}

/** "(app)/automater/(oversikt)/page.tsx" → "/automater", eller null om filen inte är en sida. */
export function fileToRoute(relative: string): string | null {
  const parts = relative.split(/[\\/]/);
  if (parts.pop() !== "page.tsx") return null;
  const out: string[] = [];
  for (const part of parts) {
    if (part.startsWith("_")) return null;
    if (part.startsWith("(") && part.endsWith(")")) {
      if (part.startsWith("(.")) return null; // avlyssnande rutt
      continue;
    }
    if (part.startsWith("@")) continue;
    out.push(part);
  }
  return `/${out.join("/")}`;
}

export function isExcluded(route: string): boolean {
  return EXCLUDED_PREFIXES.some((p) => route === p || route.startsWith(`${p}/`));
}

export function routeParams(pattern: string): string[] {
  return Array.from(pattern.matchAll(/\[\[?(?:\.\.\.)?([^\]]+)\]\]?/g), (m) => m[1]!);
}

/** Matchar en adress mot ett mönster ("/automater/bl-001" mot "/automater/[automat]"). */
export function matchesPattern(pathname: string, pattern: string): boolean {
  const re = pattern
    .split("/")
    .map((seg) => {
      if (/^\[\[\.\.\.[^\]]+\]\]$/.test(seg)) return "(?:/.*)?";
      if (/^\[\.\.\.[^\]]+\]$/.test(seg)) return "/.+";
      if (/^\[[^\]]+\]$/.test(seg)) return "/[^/]+";
      return seg ? `/${seg.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}` : "";
    })
    .join("");
  return new RegExp(`^${re || "/"}/?$`).test(pathname);
}

/** Det mest specifika mönstret som en adress hör till (statiska delar före dynamiska). */
export function patternFor(pathname: string, patterns: readonly string[]): string | null {
  const hits = patterns.filter((p) => matchesPattern(pathname, p));
  if (hits.length === 0) return null;
  const score = (p: string) => p.split("/").filter((s) => s && !s.startsWith("[")).length;
  return hits.sort((a, b) => score(b) - score(a) || b.length - a.length)[0]!;
}

/** Sätter in värden: "/automater/[automat]" + {automat: "x"} → "/automater/x". */
export function fillPattern(pattern: string, values: Record<string, string>): string | null {
  let missing = false;
  const out = pattern.replace(/\[\[?(?:\.\.\.)?([^\]]+)\]\]?/g, (_m, name: string) => {
    const v = values[name];
    if (v === undefined) {
      missing = true;
      return "";
    }
    return encodeURIComponent(v);
  });
  return missing ? null : out;
}

/** Alla sidor under appDir, sorterade, utan de undantagna. */
export function discoverRoutes(root: string, appDir = "src/app"): RoutePattern[] {
  const base = path.join(root, appDir);
  const found: RoutePattern[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      if (statSync(full).isDirectory()) {
        walk(full);
      } else if (name === "page.tsx") {
        const rel = path.relative(base, full);
        const route = fileToRoute(rel);
        if (route && !isExcluded(route)) {
          found.push({
            pattern: route,
            file: path.join(appDir, rel),
            params: routeParams(route),
          });
        }
      }
    }
  };
  walk(base);
  return found.sort((a, b) => a.pattern.localeCompare(b.pattern));
}

/** --routes: kommaseparerade mönster eller delar ("lonsamhet,/automater*"). */
export function routeFilter(spec: string | undefined): (pattern: string) => boolean {
  if (!spec) return () => true;
  const parts = spec
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return (pattern) =>
    parts.some((p) => {
      if (p.endsWith("*")) return pattern.startsWith(p.slice(0, -1));
      if (p.startsWith("/")) return pattern === p;
      return pattern.includes(p);
    });
}
