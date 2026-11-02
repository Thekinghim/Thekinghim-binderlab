/**
 * Den gemensamma delen av importen, oberoende av adapter: klassning av rader
 * (new, duplicate, conflict, error, not_paid), koppling av titlar via alias
 * och av automater via source_machines, och skrivningen.
 *
 * Allt körs i anroparens transaktion (under användarens RLS, se
 * run-import.ts). Inget här kringgår RLS.
 *
 * Regler (docs/datamodell.md, avsnitt 4):
 * - En order ändras aldrig. Finns ordernumret redan och källraden avviker
 *   (något av fälten belopp, tid, titel, automat, betalmetod) blir raden
 *   `conflict` i loggen; ordern lämnas orörd. Fälten jämförs efter
 *   NFKC-normalisering, och ett fält som källan inte har med (t.ex. en export
 *   utan Payment Method) jämförs inte.
 * - En rad jämförs först mot den sparade ordern och bara om ordern inte finns
 *   mot samma ordernummer längre upp i filen.
 * - En ej betald rad vars ordernummer redan finns (sparad, eller betald längre
 *   upp i filen) är en `conflict`: källan visar en betald order som obetald.
 * - Bara betalda order importeras. Ej betalda räknas men loggas inte rad för rad.
 * - Dubbletter räknas bara (inga import_rows).
 * - Okänd titel → ny titel + alias. Okänd automat → source_machines-rad utan
 *   automat (kön), och ordern sparas utan automat.
 */

import { sql, type SQL } from "drizzle-orm";

import type { Tx } from "@/db/client";

import {
  comparableText,
  machineKeyOf,
  normalizeText,
  type FetchResult,
  type OptionalField,
  type RawOrder,
  type RawRowError,
} from "./adapter";
import { sourceHash } from "./hash";
import { businessDateOf, formatInZone } from "./zoned";

export type RowStatus = "new" | "duplicate" | "conflict" | "error" | "not_paid";

export interface ImportRowResult {
  rowNumber: number;
  status: RowStatus;
  externalId: string | null;
  rawTitle: string | null;
  /** Titeln raden kopplas till (null = ny titel skapas vid import, eller fel). */
  titleId: string | null;
  titleKnown: boolean;
  machineName: string | null;
  /** Automaten är känd i source_machines och kopplad till en av våra automater. */
  machineMapped: boolean;
  amountOre: number | null;
  paymentMethod: string | null;
  /** ISO 8601 i UTC. */
  orderedAt: string | null;
  /** Tolkad tid i organisationens tidszon, "YYYY-MM-DD HH:mm:ss". */
  orderedAtLocal: string | null;
  businessDate: string | null;
  /** Affärsdatumet ligger i en stängd månad (sparas, men flaggas). */
  lateInClosedPeriod: boolean;
  /** Ordern (ny, eller den befintliga vid dubblett/konflikt). Bara efter import. */
  orderId: string | null;
  message: string | null;
  notes: string[];
}

export interface ImportSummary {
  total: number;
  new: number;
  duplicate: number;
  conflict: number;
  error: number;
  notPaid: number;
  lateInClosedPeriod: number;
}

export interface NewTitle {
  /** Normaliserat namn (samma regel som title_aliases.alias_normalized). */
  normalized: string;
  name: string;
  rows: number;
  /** Efter import: titeln som skapades eller som aliaset kopplades till. */
  titleId?: string;
  /** Efter import: false om en aktiv titel med samma namn redan fanns. */
  createdTitle?: boolean;
}

export interface UnknownMachine {
  externalId: string;
  name: string | null;
  rows: number;
  /** Raden finns redan i source_machines men är inte kopplad till en automat. */
  queued: boolean;
  sourceMachineId?: string;
}

export interface PipelineContext {
  organizationId: string;
  dataSourceId: string;
  organizationTimezone: string;
}

interface Candidate {
  order: RawOrder;
  hash: string;
  normalizedTitle: string;
  result: ImportRowResult;
}

interface StoredOrder {
  id: string;
  externalId: string;
  sourceHash: string;
  amountOre: number;
  orderedAt: Date;
  rawTitle: string;
  paymentMethod: string | null;
  machineKey: string | null;
}

export interface Classification {
  rows: ImportRowResult[];
  summary: ImportSummary;
  newTitles: NewTitle[];
  unknownMachines: UnknownMachine[];
  /** Internt: kandidater för insert och rader som pekar på en annan rad i filen. */
  candidates: Candidate[];
  inFileRefs: Array<{ result: ImportRowResult; externalId: string }>;
  titleByNormalized: Map<string, string>;
  rawByResult: Map<ImportRowResult, Record<string, string>>;
  /** Valfria fält som källan saknar (jämförs inte). */
  absent: ReadonlySet<OptionalField>;
}

const CHUNK = 1000;

type Row = Record<string, unknown>;

async function query<T extends Row>(tx: Tx, q: SQL): Promise<T[]> {
  return Array.from(await tx.execute(q)) as T[];
}

function chunks<T>(items: readonly T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(items.slice(i, i + size));
  }
  return out;
}

function toDate(value: unknown): Date {
  return value instanceof Date ? value : new Date(String(value));
}

function toInt(value: unknown, what: string): number {
  const n = typeof value === "number" ? value : Number(String(value));
  if (!Number.isSafeInteger(n)) {
    throw new RangeError(`${what}: ${String(value)} är inte ett säkert heltal`);
  }
  return n;
}

/** Öre → "1 234,50 kr" utan flyttal. */
export function formatOre(ore: number): string {
  const sign = ore < 0 ? "-" : "";
  const abs = Math.abs(ore);
  const kronor = String(Math.trunc(abs / 100)).replace(/\B(?=(\d{3})+(?!\d))/g, " ");
  const rest = String(abs % 100).padStart(2, "0");
  return `${sign}${kronor},${rest} kr`;
}

/** Normaliserade namn (databasens regel för alias) och befintlig titel via alias. */
async function lookupTitles(
  tx: Tx,
  organizationId: string,
  rawTitles: readonly string[],
): Promise<Map<string, { normalized: string; titleId: string | null }>> {
  const result = new Map<string, { normalized: string; titleId: string | null }>();
  for (const part of chunks(rawTitles)) {
    const found = await query<{ raw: string; normalized: string; title_id: string | null }>(
      tx,
      sql`
        with recursive input as (
          select r.raw,
                 lower(btrim(regexp_replace(normalize(r.raw, NFKC), '\\s+', ' ', 'g'))) as normalized
          from jsonb_array_elements_text(${JSON.stringify(part)}::jsonb) as r(raw)
        ),
        hit as (
          select i.raw, a.title_id, 0 as depth
          from input i
          join public.title_aliases a
            on a.organization_id = ${organizationId}::uuid and a.alias_normalized = i.normalized
        ),
        chain as (
          select raw, title_id, depth from hit
          union all
          select c.raw, t.merged_into_id, c.depth + 1
          from chain c
          join public.titles t on t.organization_id = ${organizationId}::uuid and t.id = c.title_id
          where t.merged_into_id is not null and c.depth < 20
        ),
        resolved as (
          select distinct on (raw) raw, title_id from chain order by raw, depth desc
        )
        select i.raw, i.normalized, r.title_id
        from input i left join resolved r on r.raw = i.raw
      `,
    );
    for (const row of found) {
      result.set(row.raw, { normalized: row.normalized, titleId: row.title_id });
    }
  }
  return result;
}

async function lookupSourceMachines(
  tx: Tx,
  ctx: PipelineContext,
  keys: readonly string[],
): Promise<Map<string, { id: string; machineId: string | null }>> {
  const result = new Map<string, { id: string; machineId: string | null }>();
  for (const part of chunks(keys)) {
    const found = await query<{ external_id: string; id: string; machine_id: string | null }>(
      tx,
      sql`select sm.external_id, sm.id, sm.machine_id
          from public.source_machines sm
          where sm.organization_id = ${ctx.organizationId}::uuid
            and sm.data_source_id = ${ctx.dataSourceId}::uuid
            and sm.external_id in (select jsonb_array_elements_text(${JSON.stringify(part)}::jsonb))`,
    );
    for (const row of found) {
      result.set(row.external_id, { id: row.id, machineId: row.machine_id });
    }
  }
  return result;
}

async function lookupOrders(
  tx: Tx,
  ctx: PipelineContext,
  externalIds: readonly string[],
): Promise<Map<string, StoredOrder>> {
  const result = new Map<string, StoredOrder>();
  for (const part of chunks(externalIds)) {
    const found = await query<{
      id: string;
      external_id: string;
      source_hash: string;
      amount_ore: string | number;
      ordered_at: Date | string;
      raw_title: string;
      payment_method: string | null;
      machine_key: string | null;
    }>(
      tx,
      sql`select o.id, o.external_id, o.source_hash, o.amount_ore::text as amount_ore, o.ordered_at,
                 o.raw_title, o.payment_method, sm.external_id as machine_key
          from public.orders o
          left join public.source_machines sm
            on sm.organization_id = o.organization_id and sm.id = o.source_machine_id
          where o.organization_id = ${ctx.organizationId}::uuid
            and o.data_source_id = ${ctx.dataSourceId}::uuid
            and o.external_id in (select jsonb_array_elements_text(${JSON.stringify(part)}::jsonb))`,
    );
    for (const row of found) {
      result.set(row.external_id, {
        id: row.id,
        externalId: row.external_id,
        sourceHash: row.source_hash,
        amountOre: toInt(row.amount_ore, "amount_ore"),
        orderedAt: toDate(row.ordered_at),
        rawTitle: row.raw_title,
        paymentMethod: row.payment_method,
        machineKey: row.machine_key,
      });
    }
  }
  return result;
}

async function closedMonths(tx: Tx, organizationId: string): Promise<Set<string>> {
  const found = await query<{ month: string }>(
    tx,
    sql`select to_char(pc.month, 'YYYY-MM') as month
        from public.period_closes pc
        where pc.organization_id = ${organizationId}::uuid and pc.reopened_at is null`,
  );
  return new Set(found.map((r) => r.month));
}

type Comparable = Pick<
  StoredOrder,
  "amountOre" | "orderedAt" | "rawTitle" | "paymentMethod" | "machineKey"
>;

function comparableOf(order: RawOrder): Comparable {
  return {
    amountOre: order.amountOre,
    orderedAt: order.paidAtUtc,
    rawTitle: order.rawTitle,
    paymentMethod: order.paymentMethod,
    machineKey: machineKeyOf(order),
  };
}

/**
 * Är källraden samma order som den sparade (eller som en tidigare rad i
 * filen)? Jämför de tolkade fälten, normaliserade som i sourceHash. Fält som
 * källan saknar helt (absent) jämförs inte. En sparad order utan källautomat
 * räknas som avvikande, eftersom automaten då inte går att jämföra.
 */
function sameOrder(stored: Comparable, row: RawOrder, absent: ReadonlySet<OptionalField>): boolean {
  return (
    stored.amountOre === row.amountOre &&
    stored.orderedAt.getTime() === row.paidAtUtc.getTime() &&
    comparableText(stored.rawTitle) === comparableText(row.rawTitle) &&
    stored.machineKey !== null &&
    normalizeText(stored.machineKey) === machineKeyOf(row) &&
    (absent.has("paymentMethod") ||
      comparableText(stored.paymentMethod) === comparableText(row.paymentMethod))
  );
}

function describeDifference(
  stored: Comparable,
  row: RawOrder,
  timezone: string,
  absent: ReadonlySet<OptionalField> = new Set(),
): string {
  const diffs: string[] = [];
  if (stored.amountOre !== row.amountOre) {
    diffs.push(`belopp ${formatOre(stored.amountOre)} → ${formatOre(row.amountOre)}`);
  }
  if (stored.orderedAt.getTime() !== row.paidAtUtc.getTime()) {
    diffs.push(
      `tid ${formatInZone(stored.orderedAt, timezone)} → ${formatInZone(row.paidAtUtc, timezone)}`,
    );
  }
  if (comparableText(stored.rawTitle) !== comparableText(row.rawTitle)) {
    diffs.push(`produkt "${stored.rawTitle}" → "${row.rawTitle}"`);
  }
  if (stored.machineKey === null) {
    diffs.push("den sparade ordern saknar källautomat");
  } else if (normalizeText(stored.machineKey) !== machineKeyOf(row)) {
    diffs.push(`automat "${stored.machineKey}" → "${machineKeyOf(row)}"`);
  }
  if (
    !absent.has("paymentMethod") &&
    comparableText(stored.paymentMethod) !== comparableText(row.paymentMethod)
  ) {
    diffs.push(`betalmetod "${stored.paymentMethod ?? ""}" → "${row.paymentMethod ?? ""}"`);
  }
  return diffs.length > 0
    ? `Avviker från den sparade ordern: ${diffs.join(", ")}. Ordern ändras inte.`
    : "Källraden avviker från den sparade ordern. Ordern ändras inte.";
}

function baseResult(rowNumber: number, status: RowStatus): ImportRowResult {
  return {
    rowNumber,
    status,
    externalId: null,
    rawTitle: null,
    titleId: null,
    titleKnown: false,
    machineName: null,
    machineMapped: false,
    amountOre: null,
    paymentMethod: null,
    orderedAt: null,
    orderedAtLocal: null,
    businessDate: null,
    lateInClosedPeriod: false,
    orderId: null,
    message: null,
    notes: [],
  };
}

function resultFromOrder(order: RawOrder, status: RowStatus, timezone: string): ImportRowResult {
  return {
    ...baseResult(order.sourceRowNumber, status),
    externalId: order.externalId,
    rawTitle: order.rawTitle,
    machineName: order.sourceMachineName,
    amountOre: order.amountOre,
    paymentMethod: order.paymentMethod,
    orderedAt: order.paidAtUtc.toISOString(),
    orderedAtLocal: formatInZone(order.paidAtUtc, timezone),
    businessDate: businessDateOf(order.paidAtUtc, timezone),
    notes: order.notes ?? [],
  };
}

function errorResult(error: RawRowError): ImportRowResult {
  const status: RowStatus = error.isPaid === false ? "not_paid" : "error";
  return {
    ...baseResult(error.sourceRowNumber, status),
    externalId: error.externalId ?? null,
    message: error.message,
  };
}

/**
 * Klassar varje rad utan att skriva något. Används både för förhandsvisningen
 * och som första steg i importen (då under advisory lock).
 */
export async function classify(
  tx: Tx,
  ctx: PipelineContext,
  fetched: FetchResult,
): Promise<Classification> {
  const tz = ctx.organizationTimezone;
  const absent = new Set<OptionalField>(fetched.absentFields ?? []);
  const rows: ImportRowResult[] = [];
  const rawByResult = new Map<ImportRowResult, Record<string, string>>();

  const paid: RawOrder[] = [];
  const unpaid: Array<{ result: ImportRowResult; externalId: string | null }> = [];
  for (const error of fetched.errors) {
    const result = errorResult(error);
    rows.push(result);
    rawByResult.set(result, error.raw);
    if (result.status === "not_paid") {
      unpaid.push({ result, externalId: error.externalId ?? null });
    }
  }
  for (const order of fetched.rows) {
    if (order.isPaid) {
      paid.push(order);
    } else {
      const result = resultFromOrder(order, "not_paid", tz);
      rows.push(result);
      rawByResult.set(result, order.raw);
      unpaid.push({ result, externalId: order.externalId });
    }
  }

  const titles = await lookupTitles(tx, ctx.organizationId, [
    ...new Set(paid.map((o) => o.rawTitle)),
  ]);
  const machines = await lookupSourceMachines(tx, ctx, [...new Set(paid.map(machineKeyOf))]);
  const existing = await lookupOrders(tx, ctx, [
    ...new Set([
      ...paid.map((o) => o.externalId),
      ...unpaid.flatMap((u) => (u.externalId === null ? [] : [u.externalId])),
    ]),
  ]);
  const closed = await closedMonths(tx, ctx.organizationId);

  const candidates: Candidate[] = [];
  const firstInFile = new Map<string, RawOrder>();
  const inFileRefs: Classification["inFileRefs"] = [];
  const newTitles = new Map<string, NewTitle>();
  const unknownMachines = new Map<string, UnknownMachine>();
  const titleByNormalized = new Map<string, string>();

  for (const order of paid) {
    const hash = sourceHash(order);
    const title = titles.get(order.rawTitle);
    const normalizedTitle = title?.normalized ?? comparableText(order.rawTitle).toLowerCase();
    const machineKey = machineKeyOf(order);
    const machine = machines.get(machineKey);
    const result = resultFromOrder(order, "new", tz);
    result.titleId = title?.titleId ?? null;
    result.titleKnown = Boolean(title?.titleId);
    result.machineMapped = Boolean(machine?.machineId);
    result.lateInClosedPeriod = closed.has((result.businessDate ?? "").slice(0, 7));
    rows.push(result);
    rawByResult.set(result, order.raw);

    // 1. Mot den sparade ordern (den avgör alltid, även om samma ordernummer
    //    finns längre upp i filen med avvikande värden).
    const stored = existing.get(order.externalId);
    if (stored) {
      result.orderId = stored.id;
      result.lateInClosedPeriod = false;
      if (sameOrder(stored, order, absent)) {
        result.status = "duplicate";
      } else {
        result.status = "conflict";
        result.message = describeDifference(stored, order, tz, absent);
      }
      continue;
    }

    // 2. Mot samma ordernummer längre upp i samma fil (ordern sparas en gång).
    const earlier = firstInFile.get(order.externalId);
    if (earlier) {
      if (sameOrder(comparableOf(earlier), order, absent)) {
        result.status = "duplicate";
      } else {
        result.status = "conflict";
        result.message = describeDifference(comparableOf(earlier), order, tz, absent).replace(
          "den sparade ordern",
          `rad ${earlier.sourceRowNumber} i samma fil`,
        );
      }
      inFileRefs.push({ result, externalId: order.externalId });
      result.lateInClosedPeriod = false;
      continue;
    }

    firstInFile.set(order.externalId, order);
    const candidate: Candidate = { order, hash, normalizedTitle, result };
    candidates.push(candidate);
    if (order.notes && order.notes.length > 0) {
      result.message = order.notes.join(" ");
    }

    if (title?.titleId) {
      titleByNormalized.set(normalizedTitle, title.titleId);
    } else {
      const nt = newTitles.get(normalizedTitle);
      if (nt) {
        nt.rows += 1;
      } else {
        newTitles.set(normalizedTitle, {
          normalized: normalizedTitle,
          name: order.rawTitle.replace(/\s+/g, " ").trim(),
          rows: 1,
        });
      }
    }
    if (!machine?.machineId) {
      const um = unknownMachines.get(machineKey);
      if (um) {
        um.rows += 1;
      } else {
        unknownMachines.set(machineKey, {
          externalId: machineKey,
          name: order.sourceMachineName,
          rows: 1,
          queued: Boolean(machine),
          sourceMachineId: machine?.id,
        });
      }
    }
  }

  // Ej betalda rader för en order som finns (sparad, eller betald i filen):
  // källan visar en betald order som obetald. Loggas som konflikt; ordern
  // ändras inte och ingen ny order skapas.
  for (const u of unpaid) {
    if (u.externalId === null) {
      continue;
    }
    const stored = existing.get(u.externalId);
    const earlier = firstInFile.get(u.externalId);
    if (!stored && !earlier) {
      continue;
    }
    u.result.status = "conflict";
    u.result.orderId = stored?.id ?? null;
    const where = stored
      ? "den sparade ordern"
      : `rad ${earlier?.sourceRowNumber ?? "?"} i samma fil`;
    u.result.message =
      `Källan visar ordern som ej betald, men ${where} är betald. Ordern ändras inte.` +
      (u.result.message ? ` ${u.result.message}` : "");
    if (!stored) {
      inFileRefs.push({ result: u.result, externalId: u.externalId });
    }
  }

  rows.sort((a, b) => a.rowNumber - b.rowNumber);
  const count = (s: RowStatus): number => rows.filter((r) => r.status === s).length;
  const summary: ImportSummary = {
    total: rows.length,
    new: count("new"),
    duplicate: count("duplicate"),
    conflict: count("conflict"),
    error: count("error"),
    notPaid: count("not_paid"),
    lateInClosedPeriod: rows.filter((r) => r.status === "new" && r.lateInClosedPeriod).length,
  };

  return {
    rows,
    summary,
    newTitles: [...newTitles.values()],
    unknownMachines: [...unknownMachines.values()],
    candidates,
    inFileRefs,
    titleByNormalized,
    rawByResult,
    absent,
  };
}

/** Skapar titel + alias för okända titlar. Returnerar normaliserat namn → titel. */
async function createTitles(
  tx: Tx,
  ctx: PipelineContext,
  newTitles: NewTitle[],
  aliasFor: Map<string, string>,
): Promise<void> {
  for (const nt of newTitles) {
    const name = nt.name.slice(0, 200);
    const inserted = await query<{ id: string }>(
      tx,
      sql`insert into public.titles (organization_id, name)
          values (${ctx.organizationId}::uuid, ${name})
          on conflict do nothing
          returning id`,
    );
    let titleId = inserted[0]?.id;
    nt.createdTitle = titleId !== undefined;
    if (!titleId) {
      // En aktiv titel med samma namn finns redan: koppla aliaset till den.
      const existing = await query<{ id: string }>(
        tx,
        sql`select t.id from public.titles t
            where t.organization_id = ${ctx.organizationId}::uuid
              and lower(t.name) = lower(${name}) and t.archived_at is null
            limit 1`,
      );
      titleId = existing[0]?.id;
    }
    if (!titleId) {
      throw new Error(`Kunde inte skapa titeln "${name}".`);
    }
    await tx.execute(
      sql`insert into public.title_aliases (organization_id, title_id, alias)
          values (${ctx.organizationId}::uuid, ${titleId}::uuid, ${aliasFor.get(nt.normalized) ?? nt.name})
          on conflict do nothing`,
    );
  }
  // Läs om via alias (en samtidig import från en annan källa kan ha hunnit
  // före med samma alias; aliaset avgör).
  const resolved = await lookupTitles(tx, ctx.organizationId, [...new Set(aliasFor.values())]);
  for (const nt of newTitles) {
    const raw = aliasFor.get(nt.normalized);
    const hit = raw === undefined ? undefined : resolved.get(raw);
    if (!hit?.titleId) {
      throw new Error(`Aliaset för "${nt.name}" saknas efter import.`);
    }
    nt.titleId = hit.titleId;
  }
}

export interface CommitOutcome {
  summary: ImportSummary;
  rows: ImportRowResult[];
  newTitles: NewTitle[];
  unknownMachines: UnknownMachine[];
}

/**
 * Skriver klassningen: titlar och alias, källautomater, order (insert … on
 * conflict do nothing), import_rows för new/conflict/error. Förutsätter att
 * anroparen håller advisory lock för datakällan och har skapat imports-raden.
 */
export async function commitClassification(
  tx: Tx,
  ctx: PipelineContext,
  importId: string,
  c: Classification,
): Promise<CommitOutcome> {
  // 1. Titlar.
  const aliasFor = new Map<string, string>();
  for (const cand of c.candidates) {
    if (!c.titleByNormalized.has(cand.normalizedTitle) && !aliasFor.has(cand.normalizedTitle)) {
      aliasFor.set(cand.normalizedTitle, cand.order.rawTitle);
    }
  }
  await createTitles(tx, ctx, c.newTitles, aliasFor);
  const titleId = new Map(c.titleByNormalized);
  for (const nt of c.newTitles) {
    if (nt.titleId) {
      titleId.set(nt.normalized, nt.titleId);
    }
  }

  // 2. Källautomater (okända hamnar i kön med machine_id null).
  const machineRows = [
    ...new Map(
      c.candidates.map((cand) => [
        machineKeyOf(cand.order),
        { external_id: machineKeyOf(cand.order), external_name: cand.order.sourceMachineName },
      ]),
    ).values(),
  ];
  for (const part of chunks(machineRows)) {
    await tx.execute(
      sql`insert into public.source_machines (organization_id, data_source_id, external_id, external_name)
          select ${ctx.organizationId}::uuid, ${ctx.dataSourceId}::uuid, r.external_id, r.external_name
          from jsonb_to_recordset(${JSON.stringify(part)}::jsonb) as r(external_id text, external_name text)
          on conflict (organization_id, data_source_id, external_id) do nothing`,
    );
  }
  const machines = await lookupSourceMachines(
    tx,
    ctx,
    machineRows.map((m) => m.external_id),
  );
  for (const um of c.unknownMachines) {
    um.sourceMachineId = machines.get(um.externalId)?.id;
  }

  // 3. Order.
  const insertedByExternalId = new Map<
    string,
    { id: string; businessDate: string; late: boolean }
  >();
  const notInserted: Candidate[] = [];
  for (const part of chunks(c.candidates)) {
    const payload = part.map((cand, ord) => {
      const machine = machines.get(machineKeyOf(cand.order));
      return {
        ord,
        external_id: cand.order.externalId,
        raw_title: cand.order.rawTitle,
        title_id: titleId.get(cand.normalizedTitle) ?? null,
        ordered_at: cand.order.paidAtUtc.toISOString(),
        amount_ore: cand.order.amountOre,
        payment_method: cand.order.paymentMethod,
        source_machine_id: machine?.id ?? null,
        machine_id: machine?.machineId ?? null,
        source_hash: cand.hash,
      };
    });
    const inserted = await query<{
      id: string;
      external_id: string;
      business_date: string;
      late_in_closed_period: boolean;
    }>(
      tx,
      sql`insert into public.orders (
            organization_id, data_source_id, external_id, raw_title, title_id, ordered_at,
            amount_ore, payment_method, source_machine_id, machine_id, import_id, source_hash
          )
          select ${ctx.organizationId}::uuid, ${ctx.dataSourceId}::uuid, r.external_id, r.raw_title,
                 r.title_id, r.ordered_at, r.amount_ore, r.payment_method, r.source_machine_id,
                 r.machine_id, ${importId}::uuid, r.source_hash
          from jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) as r(
            ord integer, external_id text, raw_title text, title_id uuid, ordered_at timestamptz,
            amount_ore bigint, payment_method text, source_machine_id uuid, machine_id uuid,
            source_hash text
          )
          order by r.ord
          on conflict (organization_id, data_source_id, external_id) do nothing
          returning id, external_id, business_date::text as business_date, late_in_closed_period`,
    );
    for (const row of inserted) {
      insertedByExternalId.set(row.external_id, {
        id: row.id,
        businessDate: row.business_date,
        late: row.late_in_closed_period,
      });
    }
    for (const cand of part) {
      if (!insertedByExternalId.has(cand.order.externalId)) {
        notInserted.push(cand);
      }
    }
  }

  for (const cand of c.candidates) {
    const ins = insertedByExternalId.get(cand.order.externalId);
    if (ins) {
      cand.result.orderId = ins.id;
      cand.result.titleId = titleId.get(cand.normalizedTitle) ?? null;
      cand.result.businessDate = ins.businessDate;
      cand.result.lateInClosedPeriod = ins.late;
      cand.result.machineMapped = Boolean(machines.get(machineKeyOf(cand.order))?.machineId);
    }
  }

  // Någon annan hann före (bör inte hända under advisory lock, men hellre
  // rätt klassning än ett fel): klassa om mot den sparade ordern.
  if (notInserted.length > 0) {
    const stored = await lookupOrders(
      tx,
      ctx,
      notInserted.map((cand) => cand.order.externalId),
    );
    for (const cand of notInserted) {
      const s = stored.get(cand.order.externalId);
      cand.result.orderId = s?.id ?? null;
      cand.result.lateInClosedPeriod = false;
      if (s && (s.sourceHash === cand.hash || sameOrder(s, cand.order, c.absent))) {
        cand.result.status = "duplicate";
        cand.result.message = null;
      } else {
        cand.result.status = "conflict";
        cand.result.message = s
          ? describeDifference(s, cand.order, ctx.organizationTimezone, c.absent)
          : "Ordern kunde inte sparas.";
      }
    }
  }

  // Rader som pekar på en tidigare rad i samma fil.
  for (const ref of c.inFileRefs) {
    ref.result.orderId = insertedByExternalId.get(ref.externalId)?.id ?? null;
  }

  // 4. Importloggen: bara new, conflict och error.
  const logged = c.rows
    .filter((r) => r.status === "new" || r.status === "conflict" || r.status === "error")
    .map((r) => ({
      row_number: r.rowNumber,
      raw: c.rawByResult.get(r) ?? {},
      status: r.status,
      message: r.message,
      order_id: r.orderId,
    }));
  for (const part of chunks(logged)) {
    await tx.execute(
      sql`insert into public.import_rows (organization_id, import_id, row_number, raw, status, message, order_id)
          select ${ctx.organizationId}::uuid, ${importId}::uuid, r.row_number, r.raw,
                 r.status::public.import_row_status, r.message, r.order_id
          from jsonb_to_recordset(${JSON.stringify(part)}::jsonb) as r(
            row_number integer, raw jsonb, status text, message text, order_id uuid
          )`,
    );
  }

  const count = (s: RowStatus): number => c.rows.filter((r) => r.status === s).length;
  const summary: ImportSummary = {
    total: c.rows.length,
    new: count("new"),
    duplicate: count("duplicate"),
    conflict: count("conflict"),
    error: count("error"),
    notPaid: count("not_paid"),
    lateInClosedPeriod: c.rows.filter((r) => r.status === "new" && r.lateInClosedPeriod).length,
  };
  return {
    summary,
    rows: c.rows,
    newTitles: c.newTitles,
    unknownMachines: c.unknownMachines,
  };
}
