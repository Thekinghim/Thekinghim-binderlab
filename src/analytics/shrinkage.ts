/**
 * Svinnkontroll: påfyllt (vårt lager → automat) mot sålt (Awish) mot automatens saldo
 * (Awish) per automat och titel för en period. Rena funktioner utan I/O; summorna per
 * automat och titel räknas i databasen (src/server/data/shrinkage.ts).
 *
 *   väntat saldo = förra räkningen + påfyllt − sålt − kasserat ± justering
 *   avvikelse    = Σ (räknat saldo − väntat saldo) över periodens räkningar
 *
 * En räkning är en inventering i automaten (i dag Awish-synken, källa 'awish', annars en
 * räkning i appen). Den första räkningen någonsin på en plats är startsaldot och jämförs
 * inte. Avvikelsen summeras över perioden, så att en påfyllning som registreras efter att
 * Awish redan sett den (+n, sedan −n) tar ut sig själv.
 *
 * Negativ avvikelse = pack saknas (svinn). Den flaggas när den är minst SHRINKAGE_MIN_PACKS
 * och minst SHRINKAGE_MIN_SHARE_BP av flödet (påfyllt + sålt). Positiv avvikelse = fler pack
 * än väntat (oftast en påfyllning som inte registrerats) och flaggas inte.
 */

import { formatInt, formatSek, NBSP } from "@/lib/format";

/** Minsta antal saknade pack som flaggas. */
export const SHRINKAGE_MIN_PACKS = 3;
/** Och minst så stor andel av flödet (påfyllt + sålt), i bp (500 = 5 %). */
export const SHRINKAGE_MIN_SHARE_BP = 500;

/** Summorna för en automat och titel i perioden (från databasen). */
export interface ShrinkageAggregate {
  readonly machineId: string;
  readonly titleId: string;
  /** Påfyllt i perioden (refill, transfer_in), pack. */
  readonly refilled: number;
  /** Sålt i perioden, pack. */
  readonly sold: number;
  /** Kasserat eller flyttat ut (waste, transfer_out), pack. */
  readonly removed: number;
  /** Justeringar (+/−), pack. */
  readonly adjusted: number;
  /** Σ (räknat − väntat) över periodens räkningar, eller null om ingen räkning kan jämföras. */
  readonly deviation: number | null;
  /** Antal räkningar i perioden som jämförts. */
  readonly compared: number;
  /** Saldo vid periodens början (efter förra räkningen), eller null om okänt. */
  readonly opening: number | null;
  /** Saldo i dag enligt senaste räkningen och händelserna efter, eller null. */
  readonly closing: number | null;
  /** Inköpspris per pack vid periodens slut, i öre, eller null. */
  readonly unitCostOre: number | null;
}

export interface ShrinkageNames {
  readonly machines: ReadonlyArray<{
    id: string;
    code: string;
    name: string;
    storeId: string | null;
  }>;
  readonly stores: ReadonlyArray<{ id: string; name: string }>;
  readonly titles: ReadonlyArray<{ id: string; name: string }>;
}

export type ShrinkageState = "missing" | "extra" | "ok" | "unknown";

export interface ShrinkageLine {
  readonly titleId: string;
  readonly titleName: string;
  readonly refilled: number;
  readonly sold: number;
  /** Pack som saknas (> 0) eller är för många (< 0); 0 när det stämmer, null om okänt. */
  readonly missing: number | null;
  /** Värde av det som saknas till inköpspris, i öre, eller null. */
  readonly valueOre: number | null;
  readonly closing: number | null;
  readonly state: ShrinkageState;
  /** Saknas över tröskeln. */
  readonly flagged: boolean;
}

export interface ShrinkageMachine {
  readonly machineId: string;
  readonly code: string;
  readonly name: string;
  readonly storeName: string | null;
  /** Saknade pack i de flaggade raderna. */
  readonly missing: number;
  readonly valueOre: number | null;
  readonly flagged: number;
  readonly refilled: number;
  readonly sold: number;
  /** Flaggade först (flest saknade), sedan resten efter namn. */
  readonly lines: ShrinkageLine[];
}

export interface ShrinkageReport {
  /** Automater med minst en flaggad titel, flest saknade först. */
  readonly flagged: ShrinkageMachine[];
  /** Övriga automater med rörelse i perioden. */
  readonly ok: ShrinkageMachine[];
  /** Saknade pack totalt (flaggade rader). */
  readonly missing: number;
  /** Värdet av dem, eller null om något saknar inköpspris. */
  readonly valueOre: number | null;
  /** Antal flaggade titlar. */
  readonly flaggedLines: number;
  /** Rader där inget kunde jämföras (ingen räkning i perioden). */
  readonly unknownLines: number;
  readonly headline: { readonly title: string; readonly aside: string };
}

/** Saknade pack som ska flaggas för en rad. */
export function isFlagged(
  missing: number,
  flow: number,
  minPacks = SHRINKAGE_MIN_PACKS,
  minShareBp = SHRINKAGE_MIN_SHARE_BP,
): boolean {
  if (missing < minPacks) return false;
  return missing * 10_000 >= Math.max(0, flow) * minShareBp;
}

function lineOf(a: ShrinkageAggregate, titleName: string): ShrinkageLine {
  const missing = a.deviation === null || a.compared === 0 ? null : -a.deviation;
  const state: ShrinkageState =
    missing === null ? "unknown" : missing > 0 ? "missing" : missing < 0 ? "extra" : "ok";
  const flagged = missing !== null && isFlagged(missing, a.refilled + a.sold);
  return {
    titleId: a.titleId,
    titleName,
    refilled: a.refilled,
    sold: a.sold,
    missing,
    valueOre:
      missing !== null && missing > 0 && a.unitCostOre !== null ? missing * a.unitCostOre : null,
    closing: a.closing,
    state,
    flagged,
  };
}

function plural(n: number, one: string, many: string): string {
  return `${formatInt(n)}${NBSP}${n === 1 ? one : many}`;
}

/** "240 kr" eller null. */
export function shrinkageValueText(ore: number | null): string | null {
  return ore === null ? null : formatSek(ore / 100);
}

/** Raden när ingen påfyllning är registrerad (i perioden eller för en automat). */
export const NO_REFILL_TEXT = "Ingen påfyllning registrerad än.";

/** Rubriken: hur många pack som saknas och var, eller att allt stämmer. */
export function shrinkageHeadline(args: {
  missing: number;
  machines: number;
  valueOre: number | null;
  compared: boolean;
  /** Minst en påfyllning registrerad i perioden. Utelämnad = ja (som förut). */
  refilled?: boolean;
}): { title: string; aside: string } {
  if (args.refilled === false) {
    // Utan registrerade påfyllningar ser varje sålt pack ut som svinn eller överskott.
    return {
      title: args.compared ? "Inget att jämföra mot." : "Inget att jämföra än.",
      aside: NO_REFILL_TEXT,
    };
  }
  if (!args.compared) {
    return { title: "Inget att jämföra än.", aside: "Jämförelsen börjar efter nästa räkning." };
  }
  if (args.missing === 0) {
    return { title: "Inget saknas.", aside: "Påfyllt, sålt och saldo stämmer." };
  }
  const value = shrinkageValueText(args.valueOre);
  return {
    title: `${plural(args.missing, "pack", "pack")} saknas.`,
    aside: `I ${plural(args.machines, "automat", "automater")}${value ? ` · ${value}` : ""}.`,
  };
}

/**
 * Raderna per automat med tröskeln, flaggade automater först. Rader utan rörelse och utan
 * avvikelse tas inte med.
 */
export function buildShrinkage(
  aggregates: readonly ShrinkageAggregate[],
  names: ShrinkageNames,
): ShrinkageReport {
  const machine = new Map(names.machines.map((m) => [m.id, m]));
  const store = new Map(names.stores.map((s) => [s.id, s.name]));
  const title = new Map(names.titles.map((t) => [t.id, t.name]));
  const byMachine = new Map<string, ShrinkageLine[]>();
  let unknownLines = 0;
  for (const a of aggregates) {
    const line = lineOf(a, title.get(a.titleId) ?? "Okänd titel");
    if (line.state === "unknown") unknownLines += 1;
    const list = byMachine.get(a.machineId) ?? [];
    list.push(line);
    byMachine.set(a.machineId, list);
  }

  const machines: ShrinkageMachine[] = [...byMachine.entries()].map(([id, lines]) => {
    const m = machine.get(id);
    const flaggedLines = lines.filter((l) => l.flagged);
    const missing = flaggedLines.reduce((n, l) => n + (l.missing ?? 0), 0);
    const priced = flaggedLines.every((l) => l.valueOre !== null);
    lines.sort(
      (a, b) =>
        Number(b.flagged) - Number(a.flagged) ||
        (b.missing ?? 0) - (a.missing ?? 0) ||
        a.titleName.localeCompare(b.titleName, "sv"),
    );
    return {
      machineId: id,
      code: m?.code ?? "",
      name: m?.name ?? "Okänd automat",
      storeName: m?.storeId ? (store.get(m.storeId) ?? null) : null,
      missing,
      valueOre: priced ? flaggedLines.reduce((n, l) => n + (l.valueOre ?? 0), 0) : null,
      flagged: flaggedLines.length,
      refilled: lines.reduce((n, l) => n + l.refilled, 0),
      sold: lines.reduce((n, l) => n + l.sold, 0),
      lines,
    };
  });

  const byCode = (a: ShrinkageMachine, b: ShrinkageMachine) =>
    a.code.localeCompare(b.code, "sv", { numeric: true });
  const flagged = machines
    .filter((m) => m.flagged > 0)
    .sort((a, b) => b.missing - a.missing || byCode(a, b));
  const ok = machines.filter((m) => m.flagged === 0).sort(byCode);
  const missing = flagged.reduce((n, m) => n + m.missing, 0);
  const valueOre = flagged.every((m) => m.valueOre !== null)
    ? flagged.reduce((n, m) => n + (m.valueOre ?? 0), 0)
    : null;
  const flaggedLines = flagged.reduce((n, m) => n + m.flagged, 0);
  const compared = aggregates.some((a) => a.compared > 0);
  return {
    flagged,
    ok,
    missing,
    valueOre,
    flaggedLines,
    unknownLines,
    headline: shrinkageHeadline({
      missing,
      machines: flagged.length,
      valueOre,
      compared,
      refilled: aggregates.length === 0 || aggregates.some((a) => a.refilled > 0),
    }),
  };
}

/**
 * En rad för Hem: "4 pack borta ur BL-002 (svinn)." eller null när inget avviker. "Borta",
 * inte "saknas": på Besök betyder "pack saknas i vårt lager" att lagret inte räcker.
 */
export function shrinkageHomeLine(report: ShrinkageReport): string | null {
  if (report.missing === 0) return null;
  const where =
    report.flagged.length === 1
      ? (report.flagged[0]?.code ?? "en automat")
      : plural(report.flagged.length, "automat", "automater");
  return `${plural(report.missing, "pack", "pack")} borta ur ${where} (svinn).`;
}
