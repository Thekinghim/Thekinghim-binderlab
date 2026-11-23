/**
 * Automatens skärm i portalen: hur butikens egna automater ser ut (machines.appearance) och
 * vilka pack som finns i dem just nu (stock_locations.awish_fill, samma Awish-läsning som
 * Automater och Fyll på). Bara för bilden av automaten (MachineGlyph): titelns namn, fyllnad
 * och tomma fack. Inga belopp, inga inköpspriser, ingen annan butik.
 *
 * Butiksanvändaren får inte läsa lagerplatserna (RLS: bara medlemmar i organisationen), så
 * frågan körs som systemroll, som notisen vid felanmälan (fault-push.ts). Därför tar den
 * aldrig emot id:n ur anropet: laddaren (load.ts) skickar bara automater som
 * portal_machines (som användaren, med RLS) har lämnat ut för butiken och som står där i dag.
 *
 * Läser bara. Kastar aldrig: utan skärmdata ritas automaten utan pack.
 */

import { sql } from "drizzle-orm";

import type { AwishFillRow } from "@/analytics/fleet-status";
import type { Db } from "@/db/client";
import { machineLookOf, type MachineLook } from "@/lib/machine-look";

/** Ett fack (en titel) på skärmen. Samma form som MachineGlyph:s GlyphSlot. */
export interface PortalScreenSlot {
  readonly title: string;
  /** 0–1, eller null när kapaciteten är okänd. */
  readonly fill: number | null;
  readonly empty: boolean;
}

export type PortalScreenStatus = "ok" | "refill" | "empty";

/** En automat som den syns på skärmen i portalen. */
export interface PortalMachineScreen {
  readonly machineId: string;
  readonly look: MachineLook;
  /** Titlarna i automaten (tom när Awish inte har läst automaten). */
  readonly slots: readonly PortalScreenSlot[];
  /** Fack totalt och fack med pack (kanaler ur Awish). null utan läsning. */
  readonly channels: number | null;
  readonly channelsWithPacks: number | null;
  readonly status: PortalScreenStatus;
  /** När Awish senast läste automaten (ISO), eller null. */
  readonly readAt: string | null;
}

/** Fyllnad under detta (andel av kapaciteten) räknas som "fylls på snart". */
const LOW_FILL = 0.25;

/**
 * Raderna ur Awish-läsningen → skärmen. Ren funktion (testas i screens.test.ts). Titlar utan
 * namn hoppas över; titlar med samma namn slås ihop.
 */
export function portalScreenOf(input: {
  machineId: string;
  appearance: unknown;
  fill: readonly AwishFillRow[] | null;
  readAt: string | null;
  titleName: (titleId: string) => string | null | undefined;
}): PortalMachineScreen {
  const look = machineLookOf(input.appearance);
  const rows = (input.fill ?? []).filter((r) => r && typeof r.title_id === "string");
  if (rows.length === 0) {
    return {
      machineId: input.machineId,
      look,
      slots: [],
      channels: null,
      channelsWithPacks: null,
      status: "ok",
      readAt: input.readAt,
    };
  }
  let units = 0;
  let capacity = 0;
  let channels = 0;
  let empty = 0;
  const byTitle = new Map<string, { units: number; capacity: number; empty: boolean }>();
  for (const r of rows) {
    const u = Math.max(0, Math.trunc(Number(r.units) || 0));
    const c = Math.max(0, Math.trunc(Number(r.capacity) || 0));
    const ch = Math.max(0, Math.trunc(Number(r.channels) || 0));
    const e = Math.min(ch, Math.max(0, Math.trunc(Number(r.empty) || 0)));
    units += u;
    capacity += c;
    channels += ch;
    empty += e;
    const title = input.titleName(r.title_id)?.trim();
    if (!title) continue;
    const prev = byTitle.get(title);
    byTitle.set(title, {
      units: (prev?.units ?? 0) + u,
      capacity: (prev?.capacity ?? 0) + c,
      empty: (prev?.empty ?? false) || e > 0 || u <= 0,
    });
  }
  const slots: PortalScreenSlot[] = [...byTitle].map(([title, s]) => ({
    title,
    fill: s.capacity > 0 ? Math.min(1, s.units / s.capacity) : null,
    empty: s.empty || s.units <= 0,
  }));
  const status: PortalScreenStatus =
    units <= 0
      ? "empty"
      : empty > 0 || (capacity > 0 && units / capacity <= LOW_FILL)
        ? "refill"
        : "ok";
  return {
    machineId: input.machineId,
    look,
    slots,
    channels,
    channelsWithPacks: channels - empty,
    status,
    readAt: input.readAt,
  };
}

/**
 * Butiken har valt bort detaljer ("Visa detaljer i rapporten" av): inga titlar i portalen,
 * alltså inte heller på bilden. Facken (titelnamnen) tas bort; läget, antalet fack och när
 * Awish läste står kvar. Ren funktion (screens.test.ts).
 */
export function screensForPortal(
  screens: readonly PortalMachineScreen[],
  details: boolean,
): PortalMachineScreen[] {
  return details ? [...screens] : screens.map((s) => ({ ...s, slots: [] }));
}

type Row = Record<string, unknown>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Skärmarna för automaterna `machineIds` i organisationen. Anroparen ansvarar för att id:na
 * är butikens egna (ur portal_machines). Fel = tom lista.
 */
export async function queryPortalScreens(
  db: Db,
  organizationId: string,
  machineIds: readonly string[],
): Promise<PortalMachineScreen[]> {
  const valid = machineIds.filter((id) => UUID.test(id));
  if (valid.length === 0) return [];
  try {
    const ids = `{${valid.join(",")}}`;
    const machines = Array.from(
      await db.execute(
        sql`select m.id::text as machine_id, m.appearance, l.awish_fill, l.awish_synced_at
            from public.machines m
            left join public.stock_locations l
              on l.organization_id = m.organization_id and l.machine_id = m.id
             and l.kind = 'machine' and l.archived_at is null
            where m.organization_id = ${organizationId}::uuid and m.id = any(${ids}::uuid[])`,
      ),
    ) as Row[];
    const titleIds = new Set<string>();
    for (const r of machines) {
      if (!Array.isArray(r.awish_fill)) continue;
      for (const f of r.awish_fill as AwishFillRow[]) {
        if (typeof f?.title_id === "string" && UUID.test(f.title_id)) titleIds.add(f.title_id);
      }
    }
    const names = new Map<string, string>();
    if (titleIds.size > 0) {
      const titles = Array.from(
        await db.execute(
          sql`select id::text as id, name from public.titles
              where organization_id = ${organizationId}::uuid
                and id = any(${`{${[...titleIds].join(",")}}`}::uuid[])`,
        ),
      ) as Row[];
      for (const t of titles) names.set(String(t.id), String(t.name));
    }
    const seen = new Map<string, PortalMachineScreen>();
    for (const r of machines) {
      const id = String(r.machine_id);
      if (seen.has(id)) continue;
      const at = r.awish_synced_at;
      seen.set(
        id,
        portalScreenOf({
          machineId: id,
          appearance: r.appearance,
          fill: Array.isArray(r.awish_fill) ? (r.awish_fill as AwishFillRow[]) : null,
          readAt: at instanceof Date ? at.toISOString() : at ? String(at) : null,
          titleName: (t) => names.get(t),
        }),
      );
    }
    return valid.flatMap((id) => (seen.has(id) ? [seen.get(id)!] : []));
  } catch {
    return [];
  }
}
