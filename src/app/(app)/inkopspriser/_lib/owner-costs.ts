/**
 * Ägarens inköpskostnader (scripts/db/data/owner-costs-*.json): tolkning och plan.
 *
 * Ren logik utan databas. scripts/db/import-owner-costs-lib.ts läser titlar och priser,
 * kör planOwnerCosts och skriver bara raderna med kind "insert".
 *
 * Regler:
 * - Titlar matchas på namn och alias med samma normalisering som
 *   title_aliases.alias_normalized (NFKC, ett mellanslag, gemener). Inga titlar skapas.
 * - Samma pris som redan gäller från datumet hoppas över ("unchanged").
 * - Ett annat pris samma datum är en konflikt. Då skrivs ingenting alls.
 * - Rader som behöver bekräftas skrivs bara med confirmFlagged.
 * - En saknad kostnad är aldrig noll.
 */

import { z } from "zod";

import { isIsoDate, type IsoDate } from "@/domain";

import { MAX_UNIT_COST_ORE } from "./model";

const entrySchema = z.object({
  name: z.string().trim().min(1).max(200),
  aliases: z.array(z.string().trim().min(1).max(500)).default([]),
  unitCostOre: z.number().int().min(0).max(MAX_UNIT_COST_ORE).nullable(),
  status: z.enum(["ok", "missing"]),
  needsConfirmation: z.boolean().optional(),
  note: z.string().trim().min(1).max(200).optional(),
});

const fileSchema = z.object({
  validFrom: z.string().refine(isIsoDate, "validFrom måste vara ÅÅÅÅ-MM-DD."),
  vat: z.literal("exkl"),
  source: z.string().trim().min(1).max(300),
  entries: z.array(entrySchema).min(1),
  questions: z.array(z.string().trim().min(1)).default([]),
});

export type OwnerCostEntry = z.infer<typeof entrySchema>;
export type OwnerCostFile = Omit<z.infer<typeof fileSchema>, "validFrom"> & {
  validFrom: IsoDate;
};

/** Tolkar och kontrollerar datafilen. Kastar med en svensk förklaring. */
export function parseOwnerCostFile(input: unknown): OwnerCostFile {
  const parsed = fileSchema.safeParse(input);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new Error(`Ogiltig kostnadsfil: ${first?.path.join(".") ?? ""} ${first?.message ?? ""}`);
  }
  const file = parsed.data;
  for (const entry of file.entries) {
    if (entry.status === "missing" && entry.unitCostOre !== null) {
      throw new Error(`Ogiltig kostnadsfil: ${entry.name} är "missing" men har en kostnad.`);
    }
    if (entry.status === "ok" && entry.unitCostOre === null) {
      throw new Error(`Ogiltig kostnadsfil: ${entry.name} saknar kostnad.`);
    }
  }
  const seen = new Map<string, string>();
  for (const entry of file.entries) {
    for (const key of candidateKeys(entry)) {
      const other = seen.get(key);
      if (other !== undefined && other !== entry.name) {
        throw new Error(`Ogiltig kostnadsfil: ${entry.name} och ${other} delar alias.`);
      }
      seen.set(key, entry.name);
    }
  }
  return { ...file, validFrom: file.validFrom as IsoDate };
}

/** Samma regel som title_aliases.alias_normalized i databasen. */
export function normalizeTitleKey(value: string): string {
  return value.normalize("NFKC").replace(/\s+/g, " ").trim().toLowerCase();
}

function candidateKeys(entry: OwnerCostEntry): string[] {
  return [...new Set([entry.name, ...entry.aliases].map(normalizeTitleKey))];
}

export interface KnownTitle {
  readonly titleId: string;
  readonly titleName: string;
  /** Normaliserade nycklar: titelns namn och alla dess alias. */
  readonly keys: readonly string[];
}

export interface KnownPrice {
  readonly titleId: string;
  readonly validFrom: IsoDate;
  readonly unitCostOre: number;
}

export type PlanRow =
  | {
      kind: "insert";
      entry: string;
      titleId: string;
      titleName: string;
      unitCostOre: number;
      note: string;
      /** Pris som gällde dagen före, eller null. */
      previousOre: number | null;
      /** Ett senare pris tar över från detta datum. */
      laterFrom: IsoDate | null;
    }
  | { kind: "unchanged"; entry: string; titleName: string; unitCostOre: number }
  | {
      kind: "conflict";
      entry: string;
      titleName: string;
      unitCostOre: number;
      existingOre: number;
    }
  | { kind: "flagged"; entry: string; titleName: string; unitCostOre: number }
  | { kind: "missing"; entry: string; titleName: string | null }
  | { kind: "unmatched"; entry: string }
  | { kind: "ambiguous"; entry: string; titleNames: string[] };

export interface OwnerCostPlan {
  readonly validFrom: IsoDate;
  readonly rows: PlanRow[];
  /** Aktiva titlar som varken finns i filen eller har något inköpspris. */
  readonly uncoveredTitles: string[];
  /** Sant om något hindrar att planen skrivs (konflikt). */
  readonly blocked: boolean;
}

/** Notering som sparas på priset (visas i prishistoriken). */
export function ownerCostNote(entry: OwnerCostEntry): string {
  return ["Ägarens kostnad exkl. moms", entry.note].filter(Boolean).join(" · ");
}

export function planOwnerCosts(
  file: OwnerCostFile,
  titles: readonly KnownTitle[],
  prices: readonly KnownPrice[],
  options: { confirmFlagged?: boolean } = {},
): OwnerCostPlan {
  const byKey = new Map<string, KnownTitle[]>();
  for (const title of titles) {
    for (const key of new Set(title.keys)) {
      const list = byKey.get(key) ?? [];
      list.push(title);
      byKey.set(key, list);
    }
  }
  const covered = new Set<string>();
  const rows: PlanRow[] = [];

  for (const entry of file.entries) {
    const matched = new Map<string, KnownTitle>();
    for (const key of candidateKeys(entry)) {
      for (const title of byKey.get(key) ?? []) matched.set(title.titleId, title);
    }
    const hits = [...matched.values()];
    if (hits.length > 1) {
      rows.push({
        kind: "ambiguous",
        entry: entry.name,
        titleNames: hits.map((t) => t.titleName).sort(),
      });
      continue;
    }
    const title = hits[0];
    if (title) covered.add(title.titleId);
    if (entry.unitCostOre === null) {
      rows.push({ kind: "missing", entry: entry.name, titleName: title?.titleName ?? null });
      continue;
    }
    if (!title) {
      rows.push({ kind: "unmatched", entry: entry.name });
      continue;
    }
    const own = prices
      .filter((p) => p.titleId === title.titleId)
      .sort((a, b) => a.validFrom.localeCompare(b.validFrom));
    const sameDay = own.find((p) => p.validFrom === file.validFrom);
    const base = { entry: entry.name, titleName: title.titleName, unitCostOre: entry.unitCostOre };
    if (sameDay) {
      rows.push(
        sameDay.unitCostOre === entry.unitCostOre
          ? { kind: "unchanged", ...base }
          : { kind: "conflict", ...base, existingOre: sameDay.unitCostOre },
      );
      continue;
    }
    const previous = own.filter((p) => p.validFrom < file.validFrom).at(-1) ?? null;
    if (previous?.unitCostOre === entry.unitCostOre) {
      rows.push({ kind: "unchanged", ...base });
      continue;
    }
    if (entry.needsConfirmation && !options.confirmFlagged) {
      rows.push({ kind: "flagged", ...base });
      continue;
    }
    rows.push({
      kind: "insert",
      ...base,
      titleId: title.titleId,
      note: ownerCostNote(entry),
      previousOre: previous?.unitCostOre ?? null,
      laterFrom: own.find((p) => p.validFrom > file.validFrom)?.validFrom ?? null,
    });
  }

  const priced = new Set(prices.map((p) => p.titleId));
  const uncoveredTitles = titles
    .filter((t) => !covered.has(t.titleId) && !priced.has(t.titleId))
    .map((t) => t.titleName)
    .sort((a, b) => a.localeCompare(b, "sv"));

  return {
    validFrom: file.validFrom,
    rows,
    uncoveredTitles,
    blocked: rows.some((r) => r.kind === "conflict"),
  };
}

function kr(ore: number): string {
  const sign = ore < 0 ? "-" : "";
  const abs = Math.abs(ore);
  return `${sign}${Math.floor(abs / 100).toLocaleString("sv-SE")},${String(abs % 100).padStart(2, "0")} kr`;
}

/** Rapporten som skriptet skriver ut. En rad per post, svenska. */
export function formatOwnerCostReport(
  plan: OwnerCostPlan,
  file: OwnerCostFile,
  mode: { applied: boolean },
): string[] {
  const out: string[] = [];
  const of = <K extends PlanRow["kind"]>(kind: K) =>
    plan.rows.filter((r): r is Extract<PlanRow, { kind: K }> => r.kind === kind);

  out.push(`Inköpspriser exkl. moms från ${plan.validFrom}.`);
  const inserts = of("insert");
  if (inserts.length > 0) {
    out.push(mode.applied ? "Skrivna:" : "Skrivs med --apply:");
    for (const r of inserts) {
      const was = r.previousOre === null ? "saknades" : `var ${kr(r.previousOre)}`;
      const later = r.laterFrom ? ` (gäller t.o.m. dagen före ${r.laterFrom})` : "";
      out.push(`  ${r.titleName}: ${kr(r.unitCostOre)}, ${was}${later}`);
    }
  }
  const section = (heading: string, lines: string[]) => {
    if (lines.length === 0) return;
    out.push(heading);
    for (const line of lines) out.push(`  ${line}`);
  };
  section(
    "Konflikt (inget skrivs):",
    of("conflict").map(
      (r) => `${r.titleName}: filen ${kr(r.unitCostOre)}, databasen ${kr(r.existingOre)}`,
    ),
  );
  section(
    "Bekräftas först (--confirm-flagged):",
    of("flagged").map((r) => `${r.titleName}: ${kr(r.unitCostOre)}`),
  );
  section(
    "Oförändrade:",
    of("unchanged").map((r) => `${r.titleName}: ${kr(r.unitCostOre)}`),
  );
  section(
    "Kostnad saknas:",
    of("missing").map((r) => r.titleName ?? `${r.entry} (ingen titel)`),
  );
  section(
    "Ingen titel i databasen:",
    of("unmatched").map((r) => r.entry),
  );
  section(
    "Flera titlar matchar:",
    of("ambiguous").map((r) => `${r.entry}: ${r.titleNames.join(", ")}`),
  );
  section("Titlar utan inköpspris:", plan.uncoveredTitles);
  section(
    "Frågor till ägaren:",
    file.questions.map((q, i) => `${i + 1}. ${q}`),
  );
  if (!mode.applied) {
    out.push(plan.blocked ? "Torrkörning. Lös konflikten först." : "Torrkörning. Inget skrevs.");
  }
  return out;
}
