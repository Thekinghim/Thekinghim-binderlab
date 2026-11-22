/**
 * Rapporten: fynden ihopslagna per sida (samma typ, detalj och element på flera roller och
 * skärmar blir ett fynd med antal), en gissning på källfilen (texten och klasserna sökta i
 * src) och JSON + Markdown.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { PageAudit } from "./audit";
import type { FindingType } from "./probe";

export const FINDING_TYPES: readonly FindingType[] = [
  "font",
  "uppercase-spaced",
  "legacy-class",
  "legacy-variable",
  "overflow-x",
  "truncated",
  "blank-area",
  "pack-image-small",
  "console-error",
  "http-error",
];

export const TYPE_TEXT: Record<FindingType, string> = {
  font: "Fel typsnitt (inte Google Sans)",
  "uppercase-spaced": "VERSALER med spärrning (gammal etikett)",
  "legacy-class": "Klass ur gamla designen",
  "legacy-variable": "Gammal CSS-variabel i style",
  "overflow-x": "Sidledes scroll på telefon",
  truncated: "Avklippt text utan title",
  "blank-area": "Stor tom yta",
  "pack-image-small": "Packbild under 32 px",
  "console-error": "Konsolfel",
  "http-error": "HTTP-fel",
};

export interface Finding {
  type: FindingType;
  detail: string;
  text: string;
  selector: string;
  className: string;
  /** Antal element (alla roller och skärmar). */
  count: number;
  /** "agare-demo@desktop" … */
  where: string[];
  source: string | null;
}

export interface RouteReport {
  pattern: string;
  file: string;
  urls: string[];
  audited: string[];
  redirected: string[];
  failed: string[];
  unresolved: boolean;
  v2Shell: boolean;
  textElements: number;
  shots: string[];
  findings: Finding[];
  countsByType: Partial<Record<FindingType, number>>;
}

// ---------------------------------------------------------------------------
// Källfil
// ---------------------------------------------------------------------------

export class SourceIndex {
  private files: Array<{ file: string; text: string }> = [];

  constructor(root: string, dir = "src") {
    const walk = (d: string) => {
      for (const name of readdirSync(d)) {
        const full = path.join(d, name);
        // Seedens data (namn på butiker och titlar) är ingen komponent.
        if (statSync(full).isDirectory()) {
          if (name !== "seed" && name !== "testing") walk(full);
        } else if (/\.(tsx|ts)$/.test(name) && !/\.test\.tsx?$/.test(name)) {
          this.files.push({ file: path.relative(root, full), text: readFileSync(full, "utf8") });
        }
      }
    };
    walk(path.join(root, dir));
  }

  /**
   * Filen som troligast ritar elementet: texten (eller dess längsta ord) och klasserna i
   * källan; sidans egen mapp går före.
   */
  guess(text: string, className: string, pageFile: string): string | null {
    const pageDir = path.dirname(pageFile).replace(/\/\([^)]+\)$/, "");
    const candidates = searchTerms(text);
    const classes = className
      .split(/\s+/)
      .filter((c) => c.length > 2 && !c.startsWith("v2-enter"))
      .slice(0, 6);
    let best: { file: string; score: number } | null = null;
    for (const f of this.files) {
      let score = 0;
      for (const [i, term] of candidates.entries()) {
        if (f.text.includes(term)) {
          score += 10 - i * 2;
          break;
        }
      }
      const attr = classes.join(" ");
      if (attr && f.text.includes(attr)) score += 6;
      else score += classes.filter((c) => f.text.includes(c)).length * 0.3;
      if (score < 4) continue;
      if (f.file.startsWith(pageDir)) score += 3;
      if (!best || score > best.score) best = { file: f.file, score };
    }
    return best?.file ?? null;
  }
}

/** Söktermer ur en text: hela texten, sedan långa bitar utan siffror. */
export function searchTerms(text: string): string[] {
  const t = text.replace(/…$/, "").trim();
  const out: string[] = [];
  if (t.length >= 3 && t.length <= 60) out.push(t);
  const words = t
    .split(/[^A-Za-zÅÄÖåäöÉéÜü ]+/)
    .map((w) => w.trim())
    .filter((w) => w.length >= 5)
    .sort((a, b) => b.length - a.length);
  for (const w of words.slice(0, 3)) if (!out.includes(w)) out.push(w);
  return out;
}

// ---------------------------------------------------------------------------
// Sammanslagning
// ---------------------------------------------------------------------------

export function buildRouteReports(audits: readonly PageAudit[], index: SourceIndex): RouteReport[] {
  const byPattern = new Map<string, PageAudit[]>();
  for (const a of audits) {
    const list = byPattern.get(a.pattern) ?? [];
    list.push(a);
    byPattern.set(a.pattern, list);
  }
  const out: RouteReport[] = [];
  for (const [pattern, list] of byPattern) {
    const findings = new Map<string, Finding>();
    for (const a of list) {
      const where = `${a.role}@${a.viewport}`;
      for (const f of a.findings) {
        // Samma fynd på dator och telefon och för flera roller blir ett.
        const key = f.key.replace(/\|\d+$/, "");
        const existing = findings.get(key);
        if (existing) {
          existing.count += 1;
          if (!existing.where.includes(where)) existing.where.push(where);
          if (!existing.text && f.text) existing.text = f.text;
          if (!existing.selector && f.selector) existing.selector = f.selector;
        } else {
          findings.set(key, {
            type: f.type,
            detail: f.detail,
            text: f.text,
            selector: f.selector,
            className: f.className,
            count: 1,
            where: [where],
            source: null,
          });
        }
      }
    }
    const file = list[0]!.file;
    const sorted = [...findings.values()].sort(
      (a, b) => FINDING_TYPES.indexOf(a.type) - FINDING_TYPES.indexOf(b.type) || b.count - a.count,
    );
    for (const f of sorted) {
      if (f.type === "console-error" || f.type === "http-error" || f.type === "blank-area") {
        continue;
      }
      f.source = index.guess(f.text, f.className, file);
    }
    const countsByType: Partial<Record<FindingType, number>> = {};
    for (const f of sorted) countsByType[f.type] = (countsByType[f.type] ?? 0) + 1;
    const audited = list.filter((a) => a.status === "audited");
    out.push({
      pattern,
      file,
      urls: Array.from(new Set(list.map((a) => a.url).filter((u): u is string => !!u))),
      audited: audited.map((a) => `${a.role}@${a.viewport}`),
      redirected: list
        .filter((a) => a.status === "redirected")
        .map((a) => `${a.role} ${a.note ?? ""}`.trim()),
      failed: list
        .filter((a) => a.status === "failed")
        .map((a) => `${a.role}@${a.viewport}: ${a.note ?? ""}`),
      unresolved: list.every((a) => a.status === "unresolved"),
      v2Shell: audited.some((a) => a.isV2Shell),
      textElements: Math.max(0, ...audited.map((a) => a.textElements ?? 0)),
      shots: Array.from(new Set(list.map((a) => a.shot).filter((s): s is string => !!s))),
      findings: sorted,
      countsByType,
    });
  }
  return out.sort((a, b) => a.pattern.localeCompare(b.pattern));
}

export interface Totals {
  routesTotal: number;
  routesChecked: number;
  routesWithFindings: number;
  pagesAudited: number;
  findingsByType: Record<FindingType, number>;
  elementsByType: Record<FindingType, number>;
}

export function totals(routes: readonly RouteReport[], pagesAudited: number): Totals {
  const findingsByType = Object.fromEntries(FINDING_TYPES.map((t) => [t, 0])) as Record<
    FindingType,
    number
  >;
  const elementsByType = { ...findingsByType };
  for (const r of routes) {
    for (const f of r.findings) {
      findingsByType[f.type] += 1;
      elementsByType[f.type] += f.count;
    }
  }
  const checked = routes.filter((r) => r.audited.length > 0);
  return {
    routesTotal: routes.length,
    routesChecked: checked.length,
    routesWithFindings: checked.filter((r) => r.findings.length > 0).length,
    pagesAudited,
    findingsByType,
    elementsByType,
  };
}

// ---------------------------------------------------------------------------
// Markdown
// ---------------------------------------------------------------------------

const cell = (s: string) => s.replace(/\|/g, "\\|").replace(/\n/g, " ");

export function renderMarkdown(
  routes: readonly RouteReport[],
  t: Totals,
  meta: { baseUrl: string; commit: string; startedAt: string; roles: string[] },
  maxPerRoute = 60,
): string {
  const lines: string[] = [];
  lines.push("# Designgranskning (V2)", "");
  lines.push(
    `Incheckning ${meta.commit} · ${meta.startedAt} · ${meta.baseUrl} · roller: ${meta.roles.join(", ")}`,
    "",
  );
  lines.push(
    `**${t.routesChecked}** av ${t.routesTotal} sidor granskade (${t.pagesAudited} sidvisningar), **${t.routesWithFindings}** med fynd.`,
    "",
  );
  lines.push("| Typ | Fynd | Element |", "| --- | ---: | ---: |");
  for (const type of FINDING_TYPES) {
    lines.push(
      `| ${TYPE_TEXT[type]} (\`${type}\`) | ${t.findingsByType[type]} | ${t.elementsByType[type]} |`,
    );
  }
  lines.push("");
  lines.push(
    "Ett fynd är ett slags element (samma typ, detalj och klasser) på en sida; Element är hur många gånger det förekom över roller och skärmar.",
    "",
  );

  const ranked = [...routes]
    .filter((r) => r.findings.length > 0)
    .sort((a, b) => b.findings.length - a.findings.length);
  lines.push(
    "## Flest fynd",
    "",
    "| Sida | Fynd | V2-skal | Typer |",
    "| --- | ---: | :---: | --- |",
  );
  for (const r of ranked.slice(0, 20)) {
    const types = FINDING_TYPES.filter((ty) => r.countsByType[ty])
      .map((ty) => `${ty} ${r.countsByType[ty]}`)
      .join(", ");
    lines.push(
      `| \`${r.pattern}\` | ${r.findings.length} | ${r.v2Shell ? "ja" : "nej"} | ${types} |`,
    );
  }
  lines.push("");

  const unchecked = routes.filter((r) => r.audited.length === 0);
  if (unchecked.length > 0) {
    lines.push("## Inte granskade", "");
    for (const r of unchecked) {
      const why = r.unresolved
        ? "inget id i databasen"
        : [...r.redirected, ...r.failed].join("; ") || "okänt";
      lines.push(`- \`${r.pattern}\`: ${cell(why)}`);
    }
    lines.push("");
  }

  lines.push("## Per sida", "");
  for (const r of routes) {
    if (r.audited.length === 0) continue;
    lines.push(`### \`${r.pattern}\``, "");
    lines.push(
      `${r.file} · ${r.urls.map((u) => `\`${u}\``).join(", ")} · V2-skal: ${r.v2Shell ? "ja" : "nej"} · granskad som ${r.audited.join(", ")}`,
      "",
    );
    if (r.failed.length) lines.push(`Misslyckades: ${cell(r.failed.join("; "))}`, "");
    for (const s of r.shots) lines.push(`![${r.pattern}](${s})`);
    if (r.shots.length) lines.push("");
    if (r.findings.length === 0) {
      lines.push("Inga fynd.", "");
      continue;
    }
    lines.push(
      "| Typ | Detalj | Text | Selektor | Källa | Antal |",
      "| --- | --- | --- | --- | --- | ---: |",
    );
    for (const f of r.findings.slice(0, maxPerRoute)) {
      lines.push(
        `| ${f.type} | ${cell(f.detail)} | ${cell(f.text)} | \`${cell(f.selector || "-")}\` | ${f.source ?? "-"} | ${f.count} |`,
      );
    }
    if (r.findings.length > maxPerRoute) {
      lines.push("", `… och ${r.findings.length - maxPerRoute} till (se report.json).`);
    }
    lines.push("");
  }
  return lines.join("\n");
}
