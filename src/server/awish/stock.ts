/**
 * Saldot i automaterna från Awish (Products). Körs av synken (sync.ts) efter orderna.
 *
 * För varje automat som är kopplad i källan (source_machines.machine_id) läses facken:
 * kanal ("A3"), vara (good.name), antal nu (current_inventory) och kapacitet
 * (inventory). Awish är facit för vad som finns i automaten:
 *
 * - Facken grupperas per vara (samma namnregel som orderimporten: NFKC, blanktecken
 *   ihopslagna, gemener). Varan kopplas till titeln via title_aliases, precis som en
 *   order; en okänd vara får en ny titel och ett alias (som i importen).
 * - Per titel skrivs en inventering (stock_events kind 'count', source 'awish') när
 *   Awish antal skiljer sig från saldot, eller när titeln aldrig har inventerats på
 *   platsen. Samma antal ger ingen ny händelse.
 * - En titel med saldo på platsen som Awish inte listar inventeras till 0.
 * - Sortimentet (machine_slots) följer Awish: antal fack per titel från i dag, när det
 *   skiljer sig från det som gäller. En titel som Awish inte listar men som har sålts i
 *   automaten och saknar sortimentsperiod får en avslutad period (i går), så att Lager,
 *   Drift och Att göra räknar den som utgången och inte som tom. Fackfördelningen från
 *   en genomförd sortimentsändring (Marknad) skrivs inte över samma dag eller tidigare.
 * - stock_locations.awish_synced_at sätts, så att Lager vet att saldot är känt.
 * - Kapaciteten per titel (fyllnadsgraden) skrivs till machine_slot_capacity
 *   (./slot-capacity).
 *
 * En tom lista från Awish ändrar inget (automaten kan vara nere). Fel för en automat
 * stoppar inte de andra.
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Db, Tx } from "@/db/client";
import { comparableText } from "@/import/adapter";
import { writeSlotCapacities } from "@/server/awish/slot-capacity";

import { AWISH_MIN_CALL_MS, AwishApiError, type AwishApi, type AwishProduct } from "./grpc-client";

type Row = Record<string, unknown>;

async function query<T extends Row>(tx: Tx | Db, q: ReturnType<typeof sql>): Promise<T[]> {
  return Array.from(await tx.execute(q)) as T[];
}

/** Saldot läses högst så här ofta i cron (Synka nu läser alltid). */
export const STOCK_SYNC_INTERVAL_MS = 30 * 60_000;
/** Så här mycket tid ska vara kvar för att nästa automat ska påbörjas. */
const STOCK_MIN_LEFT_MS = AWISH_MIN_CALL_MS + 2_000;

/** Facken för en vara i en automat. */
export interface AwishSlotGroup {
  /** Namnet som Awish skriver det (första facket). */
  readonly name: string;
  /** Jämförbar nyckel: samma regel som title_aliases.alias_normalized. */
  readonly key: string;
  readonly units: number;
  readonly capacity: number;
  /** Kanalernas namn, sorterade ("A1", "A2", "B10"). */
  readonly channels: string[];
}

/** Nyckeln för en vara: NFKC, blanktecken ihopslagna, trimmad, gemener (som aliasen). */
export function goodKey(name: string): string {
  return comparableText(name).toLowerCase();
}

/**
 * Facken grupperade per vara. Fack utan vara hoppas över. Ren funktion.
 */
export function groupProducts(products: readonly AwishProduct[]): AwishSlotGroup[] {
  const groups = new Map<
    string,
    { name: string; units: number; capacity: number; channels: string[] }
  >();
  for (const p of products) {
    const name = comparableText(p.goodName);
    if (name === "") continue;
    const key = name.toLowerCase();
    const g = groups.get(key) ?? { name: name.slice(0, 200), units: 0, capacity: 0, channels: [] };
    g.units += p.currentInventory;
    g.capacity += p.capacity;
    if (p.channel !== "") g.channels.push(p.channel);
    groups.set(key, g);
  }
  return [...groups.entries()]
    .map(([key, g]) => ({
      ...g,
      key,
      channels: [...new Set(g.channels)].sort((a, b) =>
        a.localeCompare(b, "sv", { numeric: true, sensitivity: "base" }),
      ),
    }))
    .sort((a, b) => a.key.localeCompare(b.key, "sv"));
}

/** Resultatet av en saldosynk (alla automater i källan). */
export interface AwishStockSummary {
  /** Kopplade automater i källan. */
  readonly machines: number;
  /** Automater vars fack lästes och sparades. */
  readonly read: number;
  /** Nya inventeringar (titlar vars antal ändrades). */
  readonly counts: number;
  /** Nya titlar från okända varor. */
  readonly titlesCreated: number;
  /** Automater som inte gick att läsa eller spara. */
  readonly failed: number;
  /** Automater som inte hanns med (tidsgränsen). */
  readonly deferred: number;
  readonly at: string;
}

export interface MachineStockResult {
  readonly counts: number;
  readonly titlesCreated: number;
  readonly slotsChanged: boolean;
  readonly skipped: "empty" | null;
}

/** Titlar för varornas namn via alias (samma fråga som importen), okända skapas. */
async function resolveTitles(
  tx: Tx,
  organizationId: string,
  groups: readonly AwishSlotGroup[],
): Promise<{ byKey: Map<string, string>; created: number }> {
  const lookup = async (names: readonly string[]) => {
    const found = await query<{ raw: string; title_id: string | null }>(
      tx,
      sql`
        with recursive input as (
          select r.raw,
                 lower(btrim(regexp_replace(normalize(r.raw, NFKC), '\\s+', ' ', 'g'))) as normalized
          from jsonb_array_elements_text(${JSON.stringify(names)}::jsonb) as r(raw)
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
        select i.raw, r.title_id
        from input i left join resolved r on r.raw = i.raw
      `,
    );
    return new Map(found.map((r) => [r.raw, r.title_id]));
  };

  const names = groups.map((g) => g.name);
  let hits = await lookup(names);
  let created = 0;
  const missing = groups.filter((g) => !hits.get(g.name));
  for (const g of missing) {
    const inserted = await query<{ id: string }>(
      tx,
      sql`insert into public.titles (organization_id, name)
          values (${organizationId}::uuid, ${g.name})
          on conflict do nothing
          returning id`,
    );
    let titleId = inserted[0]?.id;
    if (titleId) created += 1;
    if (!titleId) {
      const existing = await query<{ id: string }>(
        tx,
        sql`select t.id from public.titles t
            where t.organization_id = ${organizationId}::uuid
              and lower(t.name) = lower(${g.name}) and t.archived_at is null
            limit 1`,
      );
      titleId = existing[0]?.id;
    }
    if (!titleId) throw new Error(`Kunde inte skapa titeln "${g.name}".`);
    await tx.execute(
      sql`insert into public.title_aliases (organization_id, title_id, alias)
          values (${organizationId}::uuid, ${titleId}::uuid, ${g.name})
          on conflict do nothing`,
    );
  }
  if (missing.length > 0) hits = await lookup(names);
  const byKey = new Map<string, string>();
  for (const g of groups) {
    const id = hits.get(g.name);
    if (!id) throw new Error(`Aliaset för "${g.name}" saknas.`);
    byKey.set(g.key, id);
  }
  return { byKey, created };
}

/**
 * Sparar en automats fack från Awish (en transaktion). `at` är tidpunkten då facken
 * lästes; inventeringarna får den tiden.
 */
export async function applyMachineStock(
  db: Db,
  input: {
    organizationId: string;
    dataSourceId: string;
    machineId: string;
    products: readonly AwishProduct[];
    at: Date;
  },
): Promise<MachineStockResult> {
  const org = input.organizationId;
  const groups = groupProducts(input.products);
  if (groups.length === 0) {
    return { counts: 0, titlesCreated: 0, slotsChanged: false, skipped: "empty" };
  }
  const at = input.at.toISOString();
  return db.transaction(async (tx) => {
    // Samma lås som importen av källans order: titlar och alias skapas i samma ordning.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`binderlab:import:${input.dataSourceId}`}, 0))`,
    );
    const [machine] = await query<{ today: string; yesterday: string; label: string }>(
      tx,
      sql`select ((${at}::timestamptz at time zone o.timezone)::date)::text as today,
                 ((${at}::timestamptz at time zone o.timezone)::date - 1)::text as yesterday,
                 m.code || ' ' || m.name as label
          from public.machines m
          join public.organizations o on o.id = m.organization_id
          where m.organization_id = ${org}::uuid and m.id = ${input.machineId}::uuid`,
    );
    if (!machine) throw new Error("Automaten finns inte.");

    let [location] = await query<{ id: string }>(
      tx,
      sql`select id from public.stock_locations
          where organization_id = ${org}::uuid and machine_id = ${input.machineId}::uuid`,
    );
    if (!location) {
      [location] = await query<{ id: string }>(
        tx,
        sql`insert into public.stock_locations (organization_id, kind, machine_id, name)
            values (${org}::uuid, 'machine', ${input.machineId}::uuid, ${machine.label})
            on conflict (organization_id, machine_id) do update set name = stock_locations.name
            returning id`,
      );
    }
    if (!location) throw new Error("Automatens lagerplats saknas.");

    const { byKey, created } = await resolveTitles(tx, org, groups);
    // Två varunamn kan peka på samma titel (sammanslagna titlar): summera.
    const wanted = new Map<string, { units: number; slots: number; channels: string[] }>();
    for (const g of groups) {
      const titleId = byKey.get(g.key)!;
      const cur = wanted.get(titleId) ?? { units: 0, slots: 0, channels: [] };
      cur.units += g.units;
      cur.slots += Math.max(1, g.channels.length);
      cur.channels.push(...g.channels);
      wanted.set(titleId, cur);
    }

    const levels = await query<{ title_id: string; quantity: number; last_counted_at: unknown }>(
      tx,
      sql`select title_id, quantity, last_counted_at from public.stock_levels
          where organization_id = ${org}::uuid and location_id = ${location.id}::uuid`,
    );
    const level = new Map(levels.map((l) => [l.title_id, l]));
    const counts: { titleId: string; quantity: number }[] = [];
    for (const [titleId, w] of wanted) {
      const l = level.get(titleId);
      if (!l || l.last_counted_at === null || Number(l.quantity) !== w.units) {
        counts.push({ titleId, quantity: w.units });
      }
    }
    // Saldo på platsen för en titel som Awish inte listar: den finns inte i automaten.
    const absent = levels.filter((l) => !wanted.has(l.title_id));
    for (const l of absent) {
      if (Number(l.quantity) !== 0 || l.last_counted_at === null) {
        counts.push({ titleId: l.title_id, quantity: 0 });
      }
    }
    if (counts.length > 0) {
      await tx.execute(
        sql`insert into public.stock_events
              (organization_id, location_id, title_id, kind, quantity, occurred_at, performed_by, source)
            select ${org}::uuid, ${location.id}::uuid, r.title_id, 'count', r.quantity,
                   ${at}::timestamptz, null, 'awish'
            from jsonb_to_recordset(${JSON.stringify(counts.map((c) => ({ title_id: c.titleId, quantity: c.quantity })))}::jsonb)
              as r(title_id uuid, quantity integer)`,
      );
    }

    const slotsChanged = await syncSlots(tx, {
      org,
      machineId: input.machineId,
      today: machine.today,
      yesterday: machine.yesterday,
      wanted,
      absentTitleIds: absent.map((l) => l.title_id),
    });

    // Fyllnadsgraden: kapaciteten per titel enligt Awish (./slot-capacity).
    await writeSlotCapacities(tx, {
      org,
      machineId: input.machineId,
      at,
      groups,
      titleIdByKey: byKey,
    });

    await tx.execute(
      sql`update public.stock_locations set awish_synced_at = ${at}::timestamptz
          where organization_id = ${org}::uuid and id = ${location.id}::uuid`,
    );
    return { counts: counts.length, titlesCreated: created, slotsChanged, skipped: null };
  });
}

/** Sortimentet (machine_slots) från Awish fack. Sant om något ändrades. */
async function syncSlots(
  tx: Tx,
  input: {
    org: string;
    machineId: string;
    today: string;
    yesterday: string;
    wanted: ReadonlyMap<string, { slots: number; channels: string[] }>;
    absentTitleIds: readonly string[];
  },
): Promise<boolean> {
  const { org, machineId, today } = input;
  // Den genomförda sortimentsändringens fackfördelning följs upp: skriv inte över den.
  const [locked] = await query<{ on: string | null }>(
    tx,
    sql`select max(implemented_on)::text as on from public.assortment_changes
        where organization_id = ${org}::uuid and machine_id = ${machineId}::uuid`,
  );
  if (locked?.on && locked.on >= today) return false;

  const periods = await query<{
    title_id: string;
    slots: number;
    valid_from: string;
    valid_to: string | null;
  }>(
    tx,
    sql`select title_id, slots, valid_from::text as valid_from, valid_to::text as valid_to
        from public.machine_slots
        where organization_id = ${org}::uuid and machine_id = ${machineId}::uuid`,
  );
  const current = new Map<string, number>();
  // En planerad fackfördelning (Marknad, från ett senare datum) lämnas orörd: dagens
  // perioder slutar dagen före den.
  let nextPlan: string | null = null;
  for (const p of periods) {
    if (p.valid_from > today) {
      if (nextPlan === null || p.valid_from < nextPlan) nextPlan = p.valid_from;
    } else if (p.valid_to === null || p.valid_to >= today) {
      current.set(p.title_id, Number(p.slots));
    }
  }
  const lines = [...input.wanted.entries()].map(([titleId, w]) => ({
    title_id: titleId,
    slots: Math.min(100, Math.max(1, w.slots)),
    note: w.channels.length > 0 ? `Awish: ${w.channels.join(", ")}`.slice(0, 2000) : "Awish",
  }));
  const same =
    current.size === lines.length && lines.every((l) => current.get(l.title_id) === l.slots);

  let changed = false;
  if (!same) {
    changed = true;
    await tx.execute(
      sql`delete from public.machine_slots
          where organization_id = ${org}::uuid and machine_id = ${machineId}::uuid
            and valid_from = ${today}::date`,
    );
    await tx.execute(
      sql`update public.machine_slots set valid_to = ${input.yesterday}::date
          where organization_id = ${org}::uuid and machine_id = ${machineId}::uuid
            and valid_from < ${today}::date and (valid_to is null or valid_to >= ${today}::date)`,
    );
    await tx.execute(
      sql`insert into public.machine_slots
            (organization_id, machine_id, title_id, slots, valid_from, valid_to, note)
          select ${org}::uuid, ${machineId}::uuid, r.title_id, r.slots, ${today}::date,
                 ${nextPlan}::date - 1, r.note
          from jsonb_to_recordset(${JSON.stringify(lines)}::jsonb)
            as r(title_id uuid, slots integer, note text)`,
    );
  }

  // Sålda i automaten, inte i Awish och utan någon period (efter ersättningen ovan):
  // avslutad period i går, så att titeln räknas som utgången och inte som tom.
  const withPeriod = new Set(
    (
      await query<{ title_id: string }>(
        tx,
        sql`select distinct title_id from public.machine_slots
            where organization_id = ${org}::uuid and machine_id = ${machineId}::uuid`,
      )
    ).map((r) => r.title_id),
  );
  const closeIds = input.absentTitleIds.filter(
    (id) => !withPeriod.has(id) && !input.wanted.has(id),
  );
  if (closeIds.length > 0) {
    changed = true;
    await tx.execute(
      sql`insert into public.machine_slots
            (organization_id, machine_id, title_id, slots, valid_from, valid_to, note)
          select ${org}::uuid, ${machineId}::uuid, r.id::uuid, 1, ${input.yesterday}::date,
                 ${input.yesterday}::date, 'Awish: inte i automaten'
          from jsonb_array_elements_text(${JSON.stringify(closeIds)}::jsonb) as r(id)
          on conflict do nothing`,
    );
  }
  return changed;
}

/**
 * Läser facken för alla kopplade automater i källan och sparar dem. Respekterar
 * körningens tidsgräns (deadlineAt): automater som inte hinns med tas nästa gång.
 */
export async function syncSourceStock(
  db: Db,
  api: AwishApi,
  source: { id: string; organization_id: string },
  opts: { now: () => Date; deadlineAt: number },
): Promise<AwishStockSummary> {
  const machines = await query<{ external_id: string; machine_id: string }>(
    db,
    sql`select sm.external_id, sm.machine_id::text as machine_id
        from public.source_machines sm
        join public.machines m on m.organization_id = sm.organization_id and m.id = sm.machine_id
        left join public.stock_locations l
          on l.organization_id = sm.organization_id and l.machine_id = sm.machine_id
        where sm.organization_id = ${source.organization_id}::uuid
          and sm.data_source_id = ${source.id}::uuid
          and sm.machine_id is not null
          and sm.external_id ~ '^[0-9]{1,30}$'
        -- Den som lästes längst sedan först: hinns inte alla med fortsätter nästa körning där.
        order by l.awish_synced_at asc nulls first, sm.external_id`,
  );
  let read = 0;
  let counts = 0;
  let titlesCreated = 0;
  let failed = 0;
  let deferred = 0;
  for (const [index, m] of machines.entries()) {
    if (opts.deadlineAt - opts.now().getTime() < STOCK_MIN_LEFT_MS) {
      deferred = machines.length - index;
      break;
    }
    try {
      const products = await api.products(m.external_id);
      const r = await applyMachineStock(db, {
        organizationId: source.organization_id,
        dataSourceId: source.id,
        machineId: m.machine_id,
        products,
        at: opts.now(),
      });
      if (r.skipped === null) read += 1;
      counts += r.counts;
      titlesCreated += r.titlesCreated;
    } catch (error) {
      if (error instanceof AwishApiError && error.kind === "budget") {
        deferred = machines.length - index;
        break;
      }
      failed += 1;
      if (!(error instanceof AwishApiError))
        console.error("[awish] saldot kunde inte sparas", error);
    }
  }
  return {
    machines: machines.length,
    read,
    counts,
    titlesCreated,
    failed,
    deferred,
    at: opts.now().toISOString(),
  };
}
