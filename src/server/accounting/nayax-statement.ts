/**
 * Nayax månadsrapport ("Reimbursement Statement", PDF) till en utbetalning. Ren modul utan
 * databas: tar raderna ur ./pdf-text.ts och ger siffrorna i öre, eller kastar ett svenskt
 * fel. Ingenting gissas:
 *
 * - Perioden, Gross Amount, Processing Fee och Total To Transfer måste finnas.
 * - Summan måste gå ihop: det Nayax ersätter − avgifter − justeringar (och moms, saldo,
 *   Nayax Capital, med rapportens egna tecken) = Total To Transfer, på en krona när.
 *
 * Belopp står på engelskt vis ("kr 76,245.00", parentes = minus) och datum som dd/mm/åååå.
 *
 * Tabellerna (avgifter, justeringar, automater) läses om de går att läsa säkert, det vill
 * säga när raderna summerar till rapportens egen summa. Annars utelämnas de: då är hela
 * avgiften en kortavgift, justeringen saknar orsak och automaterna visas inte.
 */

import { createHash } from "node:crypto";

import type { PdfCell, PdfLine } from "./pdf-text";

export class NayaxStatementError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NayaxStatementError";
  }
}

/** Det Nayax drog utöver kortavgiften, en rad per sak. Positivt belopp = draget. */
export interface StatementDeduction {
  readonly kind: "bank_fee" | "other_fee" | "adjustment" | "vat" | "rolling" | "capital";
  /** Nayax egen text (t.ex. "Onboarding fee"), om det finns någon. */
  readonly reason: string | null;
  readonly amountOre: number;
}

/** En automat i rapporten. */
export interface StatementDevice {
  readonly name: string;
  readonly serial: string | null;
  readonly transactions: number;
  readonly amountOre: number;
  readonly feeOre: number;
}

/** Det som sparas på utbetalningen (payouts.statement). */
export interface PayoutStatement {
  readonly v: 1;
  readonly provider: "nayax";
  /** All försäljning i rapporten (Gross Amount). */
  readonly grossOre: number;
  /** Det Nayax betalar ut för (Reimburse by Nayax), före avdrag. */
  readonly reimbursedOre: number;
  /** Alla avgifter (Processing Fee). */
  readonly feesOre: number;
  /** Kortavgiften av dem; null när tabellen över avgifter inte gick att läsa. */
  readonly cardFeeOre: number | null;
  /** Det som kommer in på kontot (Total To Transfer). */
  readonly totalOre: number;
  /** Sista dag för utbetalningen (Payout Until Date). */
  readonly payoutUntil: string | null;
  readonly transactions: number | null;
  readonly deductions: readonly StatementDeduction[];
  readonly devices: readonly StatementDevice[];
}

export interface ParsedNayaxStatement {
  readonly period: { readonly start: string; readonly end: string };
  readonly statement: PayoutStatement;
}

const NOT_NAYAX =
  "Det här är inte en utbetalningsrapport från Nayax. Ladda upp PDF-filen som heter Reimbursement Statement.";

/** "kr 76,245.00" → 7624500, "(kr 824.72)" → −82472. Annat → null. */
export function parseNayaxMoney(text: string): number | null {
  const m = /^(\()?\s*(-)?\s*kr\s*(-)?\s*(\d{1,3}(?:,\d{3})+|\d+)\.(\d{2})\s*(\))?$/i.exec(
    text.trim(),
  );
  if (!m || Boolean(m[1]) !== Boolean(m[6])) return null;
  const kr = Number(m[4]!.replace(/,/g, ""));
  if (!Number.isSafeInteger(kr) || kr > 1_000_000_000) return null;
  const ore = kr * 100 + Number(m[5]);
  return m[1] || m[2] || m[3] ? -ore : ore;
}

/** "31/10/2026" → "2026-10-31". Annat → null. */
export function parseNayaxDate(text: string): string | null {
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec(text.trim());
  if (!m) return null;
  const [d, mo, y] = [Number(m[1]), Number(m[2]), Number(m[3])];
  if (y < 2000 || y > 2100 || mo < 1 || mo > 12) return null;
  if (d < 1 || d > new Date(Date.UTC(y, mo, 0)).getUTCDate()) return null;
  return `${m[3]}-${m[2]}-${m[1]}`;
}

const label = (text: string) => text.replace(/\s+/g, " ").trim().toLowerCase();

/** Cellen närmast till höger om etiketten, på samma rad. */
function valueAfter(lines: readonly PdfLine[], name: string): string | null {
  for (const line of lines) {
    const i = line.cells.findIndex((c) => label(c.text) === `${name}:`);
    if (i >= 0) return line.cells[i + 1]?.text ?? null;
  }
  return null;
}

interface Column {
  readonly key: string;
  readonly center: number;
}

const center = (c: PdfCell) => (c.x + c.xEnd) / 2;

/** Rubrikcellerna runt en rad (en rubrik kan stå på två rader), ihopslagna per kolumn. */
function headerColumns(lines: readonly PdfLine[], at: PdfLine): PdfCell[] {
  const near = lines.filter((l) => l.page === at.page && Math.abs(l.y - at.y) <= 10);
  const merged: { x: number; xEnd: number; text: string }[] = [];
  for (const line of near) {
    for (const c of line.cells) {
      const hit = merged.find((m) => c.x < m.xEnd && c.xEnd > m.x);
      if (hit) {
        hit.text = `${hit.text} ${c.text}`;
        hit.x = Math.min(hit.x, c.x);
        hit.xEnd = Math.max(hit.xEnd, c.xEnd);
      } else merged.push({ x: c.x, xEnd: c.xEnd, text: c.text });
    }
  }
  return merged.sort((a, b) => a.x - b.x);
}

/**
 * Tabellrader: raderna i `body` klumpas ihop (en cell kan vara bruten på flera rader, tätt
 * ihop) och varje cell hamnar i kolumnen vars rubrik ligger närmast i sidled.
 */
function tableRows(
  body: readonly PdfLine[],
  columns: readonly Column[],
  range: { readonly min: number; readonly max: number },
): Record<string, string>[] {
  const rows: PdfLine[][] = [];
  let last: number | null = null;
  for (const line of body) {
    if (last !== null && line.y - last <= 7) rows[rows.length - 1]!.push(line);
    else rows.push([line]);
    last = line.y;
  }
  return rows.map((group) => {
    const out: Record<string, string> = {};
    for (const line of group) {
      for (const c of line.cells) {
        if (c.x < range.min || c.x > range.max) continue;
        const col = columns.reduce((a, b) =>
          Math.abs(center(c) - b.center) < Math.abs(center(c) - a.center) ? b : a,
        );
        out[col.key] = out[col.key] ? `${out[col.key]} ${c.text}` : c.text;
      }
    }
    return out;
  });
}

function between(lines: readonly PdfLine[], from: PdfLine, to: PdfLine | undefined): PdfLine[] {
  return lines.filter(
    (l) => l.page === from.page && l.y > from.y + 10 && (to === undefined || l.y < to.y - 2),
  );
}

function column(cells: readonly PdfCell[], test: RegExp, key: string): Column | null {
  const c = cells.find((x) => test.test(label(x.text)));
  return c ? { key, center: center(c) } : null;
}

/** Tabellen "Fees": kortavgiften och övriga avgifter, om raderna summerar till `feesOre`. */
function readFees(
  lines: readonly PdfLine[],
  feesOre: number,
): { cardFeeOre: number; others: StatementDeduction[] } | null {
  const head = lines.find(
    (l) =>
      l.cells.some((c) => label(c.text) === "fee") && l.cells.some((c) => label(c.text) === "type"),
  );
  if (!head) return null;
  const cells = headerColumns(lines, head);
  const typeAt = cells.findIndex((c) => label(c.text) === "type");
  const mine = cells.slice(Math.max(0, typeAt - 1), typeAt + 4);
  const cols = [
    column(mine, /^fee$/, "name"),
    column(mine, /^type$/, "type"),
    column(mine, /^transactions$/, "count"),
    column(mine, /^amount$/, "amount"),
    column(mine, /^amount with/, "withVat"),
  ];
  if (cols.some((c) => c === null)) return null;
  const right = mine[mine.length - 1]!.xEnd + 12;
  const left = mine[0]!.x - 60;
  const total = lines.find(
    (l) =>
      l.page === head.page &&
      l.y > head.y &&
      l.cells.some((c) => label(c.text) === "total:" && c.x >= left && c.x < right),
  );
  if (!total) return null;
  const rows = tableRows(between(lines, head, total), cols as Column[], { min: left, max: right })
    .filter((r) => r.name)
    .map((r) => ({
      name: r.name!,
      amount: parseNayaxMoney(r.amount ?? ""),
      withVat: parseNayaxMoney(r.withVat ?? ""),
    }));
  if (rows.length === 0) return null;
  const pick = (["withVat", "amount"] as const).find(
    (k) =>
      rows.every((r) => r[k] !== null && r[k]! >= 0) &&
      rows.reduce((s, r) => s + r[k]!, 0) === feesOre,
  );
  if (!pick) return null;
  const card = rows.filter((r) => /credit card|debit card|\bcard\b/i.test(r.name));
  if (card.length !== 1) return null;
  return {
    cardFeeOre: card[0]![pick]!,
    others: rows
      .filter((r) => r !== card[0] && r[pick]! > 0)
      .map((r) => ({
        kind: /bank wire/i.test(r.name) ? ("bank_fee" as const) : ("other_fee" as const),
        reason: r.name,
        amountOre: r[pick]!,
      })),
  };
}

/** Tabellen "Adjustments": en rad per justering, om de summerar till `deductedOre`. */
function readAdjustments(lines: readonly PdfLine[], deductedOre: number): StatementDeduction[] {
  const fallback: StatementDeduction[] =
    deductedOre === 0 ? [] : [{ kind: "adjustment", reason: null, amountOre: deductedOre }];
  const head = lines.find((l) => l.cells.some((c) => label(c.text) === "adjustment reason"));
  if (!head) return fallback;
  const at = head.cells.findIndex((c) => label(c.text) === "adjustment reason");
  const reasonCell = head.cells[at]!;
  const before = head.cells[at - 1];
  const min = before ? (before.xEnd + reasonCell.x) / 2 : reasonCell.x - 40;
  const mine = head.cells.slice(at);
  const cols = [
    column(mine, /^adjustment reason$/, "reason"),
    column(mine, /^comment$/, "comment"),
    column(mine, /^amount$/, "amount"),
  ];
  if (cols.some((c) => c === null)) return fallback;
  const total = lines.find(
    (l) =>
      l.page === head.page &&
      l.y > head.y &&
      l.cells.some((c) => label(c.text) === "total:" && c.x >= min),
  );
  if (!total) return fallback;
  const rows = tableRows(between(lines, head, total), cols as Column[], { min, max: Infinity })
    .filter((r) => r.amount !== undefined)
    .map((r) => ({ reason: r.reason ?? null, amount: parseNayaxMoney(r.amount!) }));
  if (rows.length === 0 || rows.some((r) => r.amount === null)) return fallback;
  const sum = rows.reduce((s, r) => s + r.amount!, 0);
  // Tabellen skriver avdragen utan minustecken; summeringen överst har dem i parentes.
  const sign = sum === deductedOre ? 1 : sum === -deductedOre ? -1 : 0;
  if (sign === 0) return fallback;
  return rows
    .filter((r) => r.amount !== 0)
    .map((r) => ({
      kind: "adjustment" as const,
      reason: r.reason ? r.reason.slice(0, 200) : null,
      amountOre: sign * r.amount!,
    }));
}

/** Tabellen över automater, om beloppen summerar till `grossOre`. */
function readDevices(lines: readonly PdfLine[], grossOre: number): StatementDevice[] {
  const head = lines.find((l) => l.cells.some((c) => c.text.trim() === "#"));
  if (!head) return [];
  const cells = headerColumns(lines, head);
  const cols = [
    column(cells, /^#$/, "no"),
    column(cells, /^machine type$/, "type"),
    column(cells, /^vertical product$/, "product"),
    column(cells, /^hw serial$/, "serial"),
    column(cells, /^machine number$/, "number"),
    column(cells, /^location$/, "name"),
    column(cells, /^payment method$/, "payment"),
    column(cells, /^recognition method$/, "recognition"),
    column(cells, /^trans count$/, "count"),
    column(cells, /^trans amount$/, "amount"),
    column(cells, /^service fee$/, "service"),
    column(cells, /^processing fee$/, "fee"),
  ];
  if (cols.some((c) => c === null)) return [];
  const body = lines.filter((l) => l.page >= head.page && (l.page > head.page || l.y > head.y + 10));
  // Tabellen kan fortsätta på nästa sida: raderna klumpas per sida.
  const pages = [...new Set(body.map((l) => l.page))];
  const rows = pages.flatMap((p) =>
    tableRows(
      body.filter((l) => l.page === p),
      cols as Column[],
      { min: -Infinity, max: Infinity },
    ),
  );
  const devices: StatementDevice[] = [];
  for (const r of rows) {
    if (!/^\d+$/.test(r.no ?? "")) continue;
    const amount = parseNayaxMoney(r.amount ?? "");
    const fee = parseNayaxMoney(r.fee ?? "");
    const count = /^\d+$/.test(r.count ?? "") ? Number(r.count) : null;
    if (amount === null || fee === null || count === null) return [];
    const name = (r.name ?? r.number ?? r.serial ?? "").slice(0, 100);
    if (!name) return [];
    devices.push({
      name,
      serial: r.serial && /^\w+$/.test(r.serial) ? r.serial.slice(0, 40) : null,
      transactions: count,
      amountOre: amount,
      feeOre: Math.abs(fee),
    });
  }
  // En automat kan ha flera rader (ett betalsätt per rad): de läggs ihop per namn.
  const byName = new Map<string, StatementDevice>();
  for (const d of devices) {
    const prior = byName.get(d.name);
    byName.set(
      d.name,
      prior
        ? {
            ...prior,
            transactions: prior.transactions + d.transactions,
            amountOre: prior.amountOre + d.amountOre,
            feeOre: prior.feeOre + d.feeOre,
          }
        : d,
    );
  }
  const merged = [...byName.values()];
  return merged.reduce((s, d) => s + d.amountOre, 0) === grossOre
    ? merged.sort((a, b) => b.amountOre - a.amountOre)
    : [];
}

/**
 * Tolkar rapporten. Kastar `NayaxStatementError` med ett meddelande till ägaren när filen
 * inte är en Nayax-rapport, när en siffra saknas eller när summan inte går ihop.
 */
export function parseNayaxStatement(lines: readonly PdfLine[]): ParsedNayaxStatement {
  const all = lines.flatMap((l) => l.cells.map((c) => c.text)).join("\n");
  if (!/reimbursement statement/i.test(all) || !/total to transfer:/i.test(all)) {
    throw new NayaxStatementError(NOT_NAYAX);
  }
  const missing = (what: string) =>
    new NayaxStatementError(
      `Rapporten gick inte att läsa: ${what} saknas. Inget är sparat. Skriv in beloppet för hand i stället.`,
    );

  const periodText = valueAfter(lines, "reimbursement period");
  const pm = /^(\d{2}\/\d{2}\/\d{4})\s*-\s*(\d{2}\/\d{2}\/\d{4})$/.exec(periodText ?? "");
  const start = pm ? parseNayaxDate(pm[1]!) : null;
  const end = pm ? parseNayaxDate(pm[2]!) : null;
  if (!start || !end || end < start) throw missing("perioden (Reimbursement Period)");

  const money = (name: string, shown: string, required: boolean): number | null => {
    const text = valueAfter(lines, name);
    if (text === null) {
      if (required) throw missing(`beloppet ${shown}`);
      return null;
    }
    const ore = parseNayaxMoney(text);
    if (ore === null) throw missing(`beloppet ${shown}`);
    return ore;
  };
  const grossOre = money("gross amount", "Gross Amount", true)!;
  const reimbursedOre = money("reimburse by nayax", "Reimburse by Nayax", false) ?? grossOre;
  const feeSigned = money("processing fee", "Processing Fee", true)!;
  const totalOre = money("total to transfer", "Total To Transfer", true)!;
  const vatSigned = money("vat", "VAT", false) ?? 0;
  const adjustmentSigned = money("adjustment", "Adjustment", false) ?? 0;
  const rollingSigned = money("rolling balance", "Rolling Balance", false) ?? 0;
  const capitalSigned = money("nayax capital", "Nayax Capital", false) ?? 0;

  if (grossOre < 0 || reimbursedOre < 0 || reimbursedOre > grossOre) {
    throw missing("en rimlig försäljning (Gross Amount)");
  }
  // Avgiften står i parentes (minus). Står den utan är det ändå ett avdrag.
  const feesOre = Math.abs(feeSigned);
  const sum =
    reimbursedOre - feesOre + vatSigned + adjustmentSigned + rollingSigned + capitalSigned;
  if (Math.abs(sum - totalOre) > 100) {
    throw new NayaxStatementError(
      "Rapportens summa går inte ihop: försäljning minus avgifter och justeringar blir inte beloppet som Nayax betalar ut. Inget är sparat. Skriv in beloppet för hand i stället.",
    );
  }

  const until = /payout until date:\s*(\d{2}\/\d{2}\/\d{4})/i.exec(all);
  const payoutUntil = until ? parseNayaxDate(until[1]!) : null;

  const fees = readFees(lines, feesOre);
  const deductions: StatementDeduction[] = [
    ...(fees?.others ?? []),
    ...readAdjustments(lines, -adjustmentSigned),
    ...(vatSigned !== 0 ? [{ kind: "vat" as const, reason: null, amountOre: -vatSigned }] : []),
    ...(rollingSigned !== 0
      ? [{ kind: "rolling" as const, reason: null, amountOre: -rollingSigned }]
      : []),
    ...(capitalSigned !== 0
      ? [{ kind: "capital" as const, reason: null, amountOre: -capitalSigned }]
      : []),
  ];

  // Antal köp: raden Total under "Reimburse by Nayax" (första Total-raden på första sidan).
  const totalLine = lines.find(
    (l) => label(l.cells[0]?.text ?? "") === "total:" && /^\d+$/.test(l.cells[1]?.text ?? ""),
  );
  const devices = readDevices(lines, grossOre);
  const deviceCount = devices.reduce((s, d) => s + d.transactions, 0);
  const transactions = totalLine
    ? Number(totalLine.cells[1]!.text)
    : devices.length > 0
      ? deviceCount
      : null;

  return {
    period: { start, end },
    statement: {
      v: 1,
      provider: "nayax",
      grossOre,
      reimbursedOre,
      feesOre,
      cardFeeOre: fees?.cardFeeOre ?? null,
      totalOre,
      payoutUntil,
      transactions,
      deductions,
      devices,
    },
  };
}

/** Kortavgiften i baspunkter av försäljningen (400 = 4,0 %), eller null när den är okänd. */
export function statementCardFeeBp(s: PayoutStatement): number | null {
  if (s.cardFeeOre === null || s.reimbursedOre <= 0) return null;
  return Math.round((s.cardFeeOre * 10_000) / s.reimbursedOre);
}

/**
 * Utbetalningen som avstämningen ska se den: bara kortavgiften är en avgift, och det Nayax
 * drog utöver den (bankavgift, engångsavgift) är kända avdrag. Då jämförs Nayax försäljning
 * och kortavgift med appens, och engångsavgiften visas som en egen rad i stället för som en
 * avvikelse.
 */
export function statementForReconciliation(s: PayoutStatement): {
  amountOre: number;
  feesOre: number;
  deductionsOre: number;
} {
  return {
    amountOre: s.totalOre,
    feesOre: s.cardFeeOre ?? s.feesOre,
    deductionsOre: s.deductions.reduce((sum, d) => sum + d.amountOre, 0),
  };
}

/** Det Nayax drog utöver avgifterna i `payouts.fees_ore` (justeringar, moms, saldo). */
export function statementExtraOre(s: PayoutStatement): number {
  return s.deductions
    .filter((d) => d.kind !== "bank_fee" && d.kind !== "other_fee")
    .reduce((sum, d) => sum + d.amountOre, 0);
}

/** Referensen: "Nayax 2026-10" för en hel månad, annars "Nayax 2026-10-01 till 2026-10-14". */
export function nayaxReference(period: { start: string; end: string }): string {
  const [y, m] = period.start.split("-").map(Number) as [number, number];
  const lastDay = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const month = period.start.slice(0, 7);
  return period.start === `${month}-01` && period.end === `${month}-${String(lastDay)}`
    ? `Nayax ${month}`
    : `Nayax ${period.start} till ${period.end}`;
}

/** Fingeravtryck av det tolkade innehållet: samma rapport igen ger samma värde. */
export function nayaxSourceHash(parsed: ParsedNayaxStatement): string {
  const s = parsed.statement;
  return createHash("sha256")
    .update(
      [
        "nayax1",
        parsed.period.start,
        parsed.period.end,
        s.grossOre,
        s.reimbursedOre,
        s.feesOre,
        s.cardFeeOre ?? "",
        s.totalOre,
        s.payoutUntil ?? "",
        ...s.deductions.map((d) => `${d.kind}:${d.reason ?? ""}:${d.amountOre}`),
      ].join("\u001f"),
    )
    .digest("hex");
}

/** Läser en sparad payouts.statement. Okänd form → null (raden räknas då som en vanlig). */
export function readPayoutStatement(value: unknown): PayoutStatement | null {
  if (typeof value !== "object" || value === null) return null;
  const s = value as Partial<PayoutStatement>;
  const int = (x: unknown) => typeof x === "number" && Number.isSafeInteger(x);
  if (s.v !== 1 || s.provider !== "nayax") return null;
  if (!int(s.grossOre) || !int(s.reimbursedOre) || !int(s.feesOre) || !int(s.totalOre)) return null;
  if (s.cardFeeOre !== null && !int(s.cardFeeOre)) return null;
  if (!Array.isArray(s.deductions) || !Array.isArray(s.devices)) return null;
  if (!s.deductions.every((d) => d && int(d.amountOre) && typeof d.kind === "string")) return null;
  if (!s.devices.every((d) => d && int(d.amountOre) && typeof d.name === "string")) return null;
  return s as PayoutStatement;
}
