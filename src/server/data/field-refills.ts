/**
 * Påfyllningar från fältet (kön i webbläsaren), bundet till en given användare: testbart
 * utan Next (test/db/fyll-pa.test.ts). Server action syncRefills i
 * src/app/(app)/drift/actions.ts är ett tunt omslag kring den här.
 *
 * Varje påfyllning sparas i en egen transaktion via register_refill_once: samma klient-id
 * igen ger "duplicate" och inget nytt. Packen dras ur valt lager (fromLocationId), annars
 * automatens "Fylls på från", annars standardlagret. Ett avvisat inskick (t.ex. för lite i vårt lager)
 * kommer tillbaka med ett svenskt felmeddelande. Rollen kontrolleras mot databasen här och
 * i funktionen (ägare, admin, påfyllare); allt skrivs som användaren med RLS.
 */

import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { requireRoleFor, withUserDbFor } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";

/** Rollerna som registrerar påfyllningar (samma som register_refill). */
export const FIELD_REFILL_ROLES = ["owner", "admin", "refiller"] as const;

const uuid = z.string().uuid();

const refillItem = z.object({
  clientId: uuid,
  machineId: uuid,
  titleId: uuid,
  quantity: z.number().int().min(1).max(10000),
  fromWarehouse: z.boolean(),
  /** Lagret packen togs från. Utelämnat = automatens "Fylls på från", annars standardlagret. */
  fromLocationId: uuid.optional(),
  occurredAt: z.string().datetime({ offset: true }),
  note: z.string().max(500).optional(),
});

export interface RefillSyncResult {
  readonly clientId: string;
  readonly status: "saved" | "duplicate" | "rejected";
  readonly error?: string;
}

function pgMessage(error: unknown): string | null {
  const e = error as {
    code?: string;
    message?: string;
    cause?: { code?: string; message?: string };
  };
  const code = e?.code ?? e?.cause?.code;
  const message = e?.cause?.message ?? e?.message;
  if (code === "22023" || code === "42501" || code === "BL004" || code === "BL020") {
    return message ?? null;
  }
  return null;
}

/** Sparar köade påfyllningar. `ok: false` bara när listan i sig är ogiltig. */
export async function syncRefillsFor(
  viewer: Viewer,
  items: unknown,
): Promise<{ ok: boolean; results: RefillSyncResult[]; savedMachineIds: string[] }> {
  await requireRoleFor(viewer.user, viewer.organization.id, FIELD_REFILL_ROLES);
  const orgId = viewer.organization.id;
  const list = z.array(z.unknown()).max(200).safeParse(items);
  if (!list.success) return { ok: false, results: [], savedMachineIds: [] };
  const results: RefillSyncResult[] = [];
  const savedMachines = new Set<string>();
  for (const raw of list.data) {
    const parsed = refillItem.safeParse(raw);
    const clientId =
      typeof raw === "object" && raw !== null && "clientId" in raw
        ? String((raw as { clientId: unknown }).clientId)
        : "";
    if (!parsed.success) {
      results.push({ clientId, status: "rejected", error: "Påfyllningen saknar uppgifter." });
      continue;
    }
    const it = parsed.data;
    try {
      const rows = await withUserDbFor(viewer.user, (tx) =>
        tx.execute(sql`select stock_event_id, duplicate from public.register_refill_once(
          ${orgId}::uuid, ${it.clientId}::uuid, ${it.machineId}::uuid, ${it.titleId}::uuid,
          ${it.quantity}::integer, ${it.fromWarehouse}::boolean, ${it.occurredAt}::timestamptz,
          ${it.note ?? null}::text, ${it.fromWarehouse ? (it.fromLocationId ?? null) : null}::uuid)`),
      );
      const row = Array.from(rows)[0] as { duplicate?: boolean } | undefined;
      results.push({ clientId: it.clientId, status: row?.duplicate ? "duplicate" : "saved" });
      if (!row?.duplicate) savedMachines.add(it.machineId);
    } catch (error) {
      results.push({
        clientId: it.clientId,
        status: "rejected",
        error: pgMessage(error) ?? "Påfyllningen kunde inte sparas. Försök igen.",
      });
    }
  }
  return { ok: true, results, savedMachineIds: [...savedMachines] };
}

/**
 * Ångra efter Klar i Fyll på: motbokar påfyllningarna (klient-id) som användaren själv
 * sparat de senaste 30 minuterna (public.undo_field_refills). Svarar med antal ångrade pack,
 * eller ett svenskt fel ("För sent att ångra …").
 */
export async function undoRefillsFor(
  viewer: Viewer,
  clientIds: unknown,
): Promise<{ ok: true; packs: number } | { ok: false; error: string }> {
  await requireRoleFor(viewer.user, viewer.organization.id, FIELD_REFILL_ROLES);
  const ids = z.array(uuid).min(1).max(200).safeParse(clientIds);
  if (!ids.success) return { ok: false, error: "Inget att ångra." };
  const orgId = viewer.organization.id;
  try {
    const rows = await withUserDbFor(viewer.user, (tx) =>
      tx.execute(
        sql`select public.undo_field_refills(${orgId}::uuid, ${`{${ids.data.join(",")}}`}::uuid[]) as packs`,
      ),
    );
    const row = Array.from(rows)[0] as { packs?: number | string } | undefined;
    return { ok: true, packs: Number(row?.packs ?? 0) };
  } catch (error) {
    return { ok: false, error: pgMessage(error) ?? "Kunde inte ångra. Försök igen." };
  }
}
