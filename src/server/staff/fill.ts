/**
 * Datan till påfyllarens skärm (public.staff_fill_data): bara antal, aldrig belopp.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { withUserDbFor, type SessionUser } from "@/server/access";

export interface StaffFillRow {
  readonly titleId: string;
  readonly title: string;
  /** Pack i automaten nu (Awish), eller enligt Binderlab när Awish inte lästs. */
  readonly units: number;
  /** Plats för så många pack (Awish), null = okänt. */
  readonly capacity: number | null;
  /** Förslaget: plats − pack i automaten. */
  readonly suggested: number;
  /** Pack i butikens lager (automatens "Fylls på från"), null = spåras inte. */
  readonly storeStock: number | null;
}

export interface StaffFillData {
  readonly machineId: string;
  readonly code: string;
  readonly name: string;
  readonly storeName: string | null;
  readonly syncedAt: string | null;
  readonly rows: readonly StaffFillRow[];
}

interface RawRow {
  title_id: string;
  title: string;
  units: number;
  capacity: number | null;
  suggested: number;
  store_stock: number | null;
}

export async function loadStaffFill(
  user: SessionUser,
  orgId: string,
  machineId: string,
): Promise<StaffFillData> {
  const result = await withUserDbFor(user, (tx) =>
    tx.execute(sql`select public.staff_fill_data(${orgId}::uuid, ${machineId}::uuid) as data`),
  );
  const d = (Array.from(result)[0] as { data: Record<string, unknown> }).data;
  const rows = (d.rows as RawRow[] | null) ?? [];
  return {
    machineId: String(d.machine_id),
    code: String(d.code),
    name: String(d.name),
    storeName: (d.store_name as string | null) ?? null,
    syncedAt: (d.synced_at as string | null) ?? null,
    rows: rows.map((r) => ({
      titleId: r.title_id,
      title: r.title,
      units: Number(r.units ?? 0),
      capacity: r.capacity === null ? null : Number(r.capacity),
      suggested: Number(r.suggested ?? 0),
      storeStock: r.store_stock === null ? null : Number(r.store_stock),
    })),
  };
}
