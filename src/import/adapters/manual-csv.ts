/**
 * manual_csv: försäljning från en automat av ett annat märke än Awish, uppladdad som
 * CSV (en rad per försäljning). Gör att en operatör med en annan plattform kan använda
 * Binderlab utan någon integration: exportera försäljningen ur sin egen plattform (eller
 * skriv den i ett kalkylblad) och ladda upp filen under Datakällor.
 *
 * Kolumner (rubrikerna hittas på samma synonymer som Awish-importen, okänsligt för
 * skiftläge; svenska och engelska namn går bra):
 *   Datum        obligatorisk. ÅÅÅÅ-MM-DD (även med klockslag) eller DD.MM.ÅÅÅÅ/DD/MM/ÅÅÅÅ.
 *   Automat      obligatorisk. Automatens namn eller kod; kopplas under Datakällor.
 *   Produkt      obligatorisk. Titeln som den heter i automaten.
 *   Belopp       obligatorisk. Radens belopp i kronor ("79", "79,00", "79 kr").
 *   Tid          valfri. Klockslag (TT:MM) om Datum saknar det. Saknas båda: kl. 12.00.
 *   Antal        valfri. Antal pack på raden (standard 1). Beloppet delas lika per pack.
 *   Ordernummer  valfri. Källans id. Saknas det räknas ett id fram ur raden, så att
 *                samma fil (eller samma dagar i en ny fil) blir dubbletter, inte nya order.
 *   Betalstatus  valfri. Saknas den räknas varje rad som betald.
 *
 * Allt efter tolkningen (titlar, automater, dubbletter, lager) är samma pipeline som
 * för Awish (src/import/pipeline.ts).
 */

import { ZodError } from "zod";

import {
  normalizeText,
  type AdapterInput,
  type FetchResult,
  type RawMachine,
  type RawOrder,
  type RawRowError,
  type SourceAdapter,
} from "../adapter";
import { parseAmountOre } from "../amount";
import { parseCsvTable } from "../csv-table";
import { ImportValidationError } from "../errors";
import { sha256Hex } from "../hash";
import { autoMap, isPaidValue, normalizeHeader, type MappingOverride } from "../mapping";
import { formatInZone, parseSourceDateTime, zonedToUtc } from "../zoned";

export const MANUAL_CSV_PARSER_VERSION = "manual_csv/1";

/** Högst så många pack på en rad (en större siffra är nästan säkert fel kolumn). */
export const MAX_QUANTITY_PER_ROW = 1000;

/** Klockslaget som används när filen bara har datum. Mitt på dagen: rätt affärsdag. */
export const DEFAULT_TIME = "12:00";

/** Mallen som går att ladda ner under Datakällor (semikolon, som svensk Excel). */
export const MANUAL_CSV_TEMPLATE =
  "Datum;Tid;Automat;Produkt;Belopp;Antal\r\n" +
  "2026-11-03;14:05;Butik Centrum;Pokémon Scarlet & Violet Booster;79;1\r\n" +
  "2026-11-03;16:40;Butik Centrum;Pokémon 151 Booster;178;2\r\n";

const TIME_HEADERS = new Set(["tid", "time", "klockslag", "kl", "klocka", "tidpunkt"]);
const QUANTITY_HEADERS = new Set(["antal", "quantity", "qty", "st", "styck", "count", "pcs"]);

export interface ManualCsvInput extends AdapterInput {
  file: { name: string; content: string | Uint8Array };
  /** Avgränsare, om den inte ska gissas. Kolumnerna hittas alltid automatiskt. */
  mapping?: Pick<MappingOverride, "delimiter">;
}

interface Columns {
  date: number;
  time: number;
  machine: number;
  title: number;
  amount: number;
  quantity: number;
  externalId: number;
  isPaid: number;
}

function collapse(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function resolve(headers: readonly string[]): Columns {
  const auto = autoMap(headers);
  const at = (header: string | null): number => (header === null ? -1 : headers.indexOf(header));
  const find = (names: ReadonlySet<string>): number =>
    headers.findIndex((h) => names.has(normalizeHeader(h)));
  return {
    // "Datum" hittas som orderDate, "Betaltid"/"Payment Time" som paidAt.
    date: at(auto.paidAt) >= 0 ? at(auto.paidAt) : at(auto.orderDate),
    time: find(TIME_HEADERS),
    machine: at(auto.machine),
    title: at(auto.title),
    amount: at(auto.amount),
    quantity: find(QUANTITY_HEADERS),
    externalId: at(auto.externalId),
    isPaid: at(auto.isPaid),
  };
}

function knownCount(c: Columns): number {
  return [c.date, c.machine, c.title, c.amount].filter((i) => i >= 0).length;
}

/** "05.11.2026", "5/11/2026 14:05" (dag först, europeiskt) → "2026-11-05 …". Annars oförändrat. */
export function isoDateText(text: string): string {
  const m = /^(\d{1,2})[./-](\d{1,2})[./-](\d{4})(.*)$/.exec(text.trim());
  if (!m) return text.trim();
  const [, d, mo, y, rest] = m;
  return `${y}-${mo!.padStart(2, "0")}-${d!.padStart(2, "0")}${rest ?? ""}`;
}

/** Datum och klockslag till en tid som parseSourceDateTime förstår. */
function dateTimeText(dateCell: string, timeCell: string): { text: string; defaulted: boolean } {
  const date = isoDateText(dateCell);
  const hasTime = /\d{1,2}:\d{2}/.test(date);
  if (hasTime) return { text: date, defaulted: false };
  const time = timeCell.trim().replace(/^(\d{1,2})[.](\d{2})/, "$1:$2");
  if (time !== "") return { text: `${date} ${time}`, defaulted: false };
  return { text: `${date} ${DEFAULT_TIME}`, defaulted: true };
}

function parseQuantity(cell: string): { ok: true; n: number } | { ok: false; message: string } {
  const text = cell.trim();
  if (text === "") return { ok: true, n: 1 };
  if (!/^\d+$/.test(text)) return { ok: false, message: `Antalet "${text}" är inte ett heltal.` };
  const n = Number(text);
  if (n < 1 || n > MAX_QUANTITY_PER_ROW) {
    return { ok: false, message: `Antalet ${n} ska vara mellan 1 och ${MAX_QUANTITY_PER_ROW}.` };
  }
  return { ok: true, n };
}

export function parseManualCsv(input: ManualCsvInput): FetchResult {
  const table = parseCsvTable(input.file.content, { delimiter: input.mapping?.delimiter });
  if (table.records.length === 0) {
    throw new ImportValidationError("Filen är tom.");
  }

  // Rubrikraden: första raden (bland de tio första) med alla fyra obligatoriska kolumner.
  let headerIndex = -1;
  let columns: Columns | null = null;
  let best: { cols: Columns; count: number } | null = null;
  for (let i = 0; i < Math.min(10, table.records.length); i += 1) {
    const cells = (table.records[i]?.cells ?? []).map((c) => c.trim());
    const cols = resolve(cells);
    const count = knownCount(cols);
    if (count === 4) {
      headerIndex = i;
      columns = cols;
      break;
    }
    if (!best || count > best.count) best = { cols, count };
  }
  if (!columns || headerIndex < 0) {
    const missing = best
      ? [
          best.cols.date < 0 ? "Datum" : null,
          best.cols.machine < 0 ? "Automat" : null,
          best.cols.title < 0 ? "Produkt" : null,
          best.cols.amount < 0 ? "Belopp" : null,
        ].filter((x): x is string => x !== null)
      : ["Datum", "Automat", "Produkt", "Belopp"];
    throw new ImportValidationError(
      `Filen saknar kolumner: ${missing.join(", ")}. Första raden ska vara rubriker: ` +
        "Datum, Automat, Produkt och Belopp (Tid, Antal och Ordernummer är valfria). " +
        "Ladda ner mallen under Datakällor.",
    );
  }
  const headerRecord = table.records[headerIndex]!;
  const headers = headerRecord.cells.map((c, i) =>
    c.trim() === "" ? `Kolumn ${i + 1}` : c.trim(),
  );
  const tz = input.context.sourceTimezone;
  const headerAt = (i: number): string | null => (i < 0 ? null : (headers[i] ?? null));

  const rows: RawOrder[] = [];
  const errors: RawRowError[] = [];
  const machines = new Map<string, RawMachine>();
  const occurrences = new Map<string, number>();
  let defaultedTimes = 0;
  const extraPacks: RawOrder[] = [];

  for (const record of table.records.slice(headerIndex + 1)) {
    const cell = (i: number): string => (i < 0 ? "" : (record.cells[i] ?? ""));
    if (record.cells.every((c) => c.trim() === "")) continue;
    const raw: Record<string, string> = {};
    headers.forEach((h, i) => {
      raw[h] = record.cells[i] ?? "";
    });

    const problems: string[] = [];
    if (record.error) problems.push(record.error);
    if (record.cells.slice(headers.length).some((v) => v.trim() !== "")) {
      problems.push("Raden har fler kolumner än rubrikraden.");
    }
    const rawTitle = collapse(normalizeText(cell(columns.title)));
    if (rawTitle === "") problems.push("Produkt saknas.");
    else if (rawTitle.length > 500) problems.push("Produktnamnet är längre än 500 tecken.");
    const machineName = collapse(normalizeText(cell(columns.machine)));
    if (machineName === "") problems.push("Automat saknas.");
    else if (machineName.length > 200) problems.push("Automatens namn är längre än 200 tecken.");
    const amount = parseAmountOre(cell(columns.amount));
    if (!amount.ok) problems.push(amount.message);
    const quantity = parseQuantity(cell(columns.quantity));
    if (!quantity.ok) problems.push(quantity.message);
    let perPack = 0;
    if (amount.ok && quantity.ok) {
      if (amount.ore % quantity.n !== 0) {
        problems.push(
          `Beloppet ${cell(columns.amount).trim()} går inte att dela lika på ${quantity.n} pack.`,
        );
      } else {
        perPack = amount.ore / quantity.n;
      }
    }
    const givenId = normalizeText(cell(columns.externalId)).trim();
    if (givenId.length > 180) problems.push("Ordernumret är längre än 180 tecken.");

    const when = dateTimeText(cell(columns.date), cell(columns.time));
    let paidAtUtc: Date | null = null;
    let localText = when.text;
    const notes: string[] = [];
    if (cell(columns.date).trim() === "") {
      problems.push("Datum saknas.");
    } else {
      const time = parseSourceDateTime(when.text);
      if (!time.ok) {
        problems.push(time.message.replace("ÅÅÅÅ-MM-DD TT:MM:SS", "ÅÅÅÅ-MM-DD eller DD.MM.ÅÅÅÅ"));
      } else if (time.kind === "absolute") {
        paidAtUtc = time.utc;
        localText = formatInZone(time.utc, tz);
      } else {
        const resolved = zonedToUtc(time.local, tz);
        paidAtUtc = resolved.utc;
        localText = formatInZone(resolved.utc, tz);
        if (resolved.resolution === "ambiguous") {
          notes.push(
            `Tiden ${when.text} finns två gånger i ${tz} (sommartid slutar). Den tidigaste valdes.`,
          );
        } else if (resolved.resolution === "gap") {
          notes.push(
            `Tiden ${when.text} finns inte i ${tz} (sommartid börjar). Den flyttades fram till ${localText}.`,
          );
        }
      }
    }
    const isPaid = columns.isPaid < 0 ? true : isPaidValue(cell(columns.isPaid));

    if (problems.length > 0 || paidAtUtc === null || !quantity.ok) {
      errors.push({
        sourceRowNumber: record.lineNumber,
        raw,
        message: problems.join(" "),
        externalId: givenId === "" ? undefined : givenId,
        isPaid: record.error ? null : isPaid,
      });
      continue;
    }
    if (when.defaulted) defaultedTimes += 1;

    // Id: källans ordernummer, annars ett som räknas fram ur raden. Samma rad i en ny
    // fil får samma id (dubblett); två likadana försäljningar i samma minut får löpnummer.
    const base =
      givenId !== ""
        ? givenId
        : `m${sha256Hex(
            [
              normalizeText(machineName).toLowerCase(),
              rawTitle.toLowerCase(),
              localText,
              perPack,
            ].join("|"),
          ).slice(0, 24)}`;
    for (let k = 1; k <= quantity.n; k += 1) {
      let externalId: string;
      if (givenId !== "") {
        externalId = quantity.n === 1 ? givenId : `${givenId}#${k}`;
      } else {
        const n = (occurrences.get(base) ?? 0) + 1;
        occurrences.set(base, n);
        externalId = `${base}-${n}`;
      }
      const order: RawOrder = {
        externalId,
        rawTitle,
        sourceMachineName: machineName,
        paymentMethod: null,
        amountOre: perPack,
        paidAtUtc,
        isPaid,
        sourceRowNumber: record.lineNumber,
        raw,
        notes: notes.length > 0 ? notes : undefined,
      };
      if (k === 1) {
        rows.push(order);
      } else {
        // Importloggen har ett radnummer per order: pack 2, 3 … på samma rad får nummer
        // efter filens sista rad, med en anteckning om varifrån de kommer.
        extraPacks.push({
          ...order,
          notes: [...notes, `Pack ${k} av ${quantity.n} på rad ${record.lineNumber} i filen.`],
        });
      }
    }
    const machineKey = normalizeText(machineName);
    if (isPaid && !machines.has(machineKey)) {
      machines.set(machineKey, { externalId: machineKey, externalName: machineName });
    }
  }

  let nextRow = table.records.reduce((max, r) => Math.max(max, r.lineNumber), 0) + 1;
  for (const order of extraPacks) {
    rows.push({ ...order, sourceRowNumber: nextRow });
    nextRow += 1;
  }

  return {
    rows,
    machines: [...machines.values()],
    errors,
    // Plattformen har ingen betalmetod: fältet jämförs inte mot sparade order.
    absentFields: ["paymentMethod"],
    parserVersion: MANUAL_CSV_PARSER_VERSION,
    mapping: {
      version: 1,
      kind: "manual_csv",
      headers,
      headerRowNumber: headerRecord.lineNumber,
      delimiter: table.delimiter,
      encoding: table.encoding,
      // Samma fältnamn som Awish-importen (importloggen visar raderna med dem).
      columns: {
        externalId: headerAt(columns.externalId),
        title: headerAt(columns.title),
        machine: headerAt(columns.machine),
        amount: headerAt(columns.amount),
        isPaid: headerAt(columns.isPaid),
        paidAt: headerAt(columns.date),
        paymentMethod: null,
        rowId: null,
        orderDate: null,
      },
      timeColumn: headerAt(columns.time),
      quantityColumn: headerAt(columns.quantity),
      defaultTime: defaultedTimes > 0 ? DEFAULT_TIME : null,
    },
  };
}

export const manualCsvAdapter: SourceAdapter<ManualCsvInput> = {
  provider: "manual_csv",
  async fetch(input) {
    try {
      return parseManualCsv(input);
    } catch (error) {
      if (error instanceof ZodError) {
        throw new ImportValidationError("Filen kunde inte tolkas.");
      }
      throw error;
    }
  },
};
