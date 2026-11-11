/**
 * Skrivningarna på Vårt lager, bundna till en given användare (testbart utan Next).
 * Rollen kontrolleras mot databasen (ägare, admin) och allt skrivs som användaren med RLS.
 *
 * - Antal (inventering) i ett eget lager: Lagers registerCountFor (samma som Prognos).
 * - Inköp: en 'receipt'-händelse (positivt antal) i valt lager, annars standardlagret.
 *   Med pris (registerReceiptWithPriceFor) sparas ett nytt inköpspris från i dag i samma steg.
 * - Flytt mellan lager: public.transfer_stock (transfer_out + transfer_in), Ångra med
 *   public.undo_transfer.
 * - Lagren: public.create_warehouse, rename_warehouse och archive_warehouse (med Ångra).
 *
 * Händelserna loggas i audit_log av triggarna på stock_events.
 */

import "server-only";

import { and, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import * as s from "@/db/schema";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { pgErrorOf } from "@/server/errors";
import type { Tx } from "@/db/client";
import { businessToday, type Viewer } from "@/server/data/core/loaders";

import {
  LagerError,
  locationId,
  locationName,
  registerCountFor,
  type RegisterResult,
} from "../../lager/_lib/register";
import { MAX_PACKS } from "../../lager/_lib/schemas";
import { addPurchasePriceFor, receiptPriceCheckFor } from "../../inkopspriser/_lib/data";
import { MAX_UNIT_COST_ORE } from "../../inkopspriser/_lib/model";
import { priceDoubtText, type PriceDoubtResult } from "../../inkopspriser/_lib/price-check";
import { PurchasingError } from "@/server/purchasing/service";
import { receiveArrivalFor } from "@/server/purchasing/quick";

import { EDIT_ROLES } from "./data";

const uuid = z
  .string({ error: "Ogiltigt id." })
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Ogiltigt id.");

const INVALID = "Ogiltig registrering. Ladda om sidan och försök igen.";

export const homeCountSchema = z.object(
  {
    titleId: uuid,
    /** Vilket lager. Utelämnat = standardlagret. */
    warehouseId: uuid.optional(),
    counted: z
      .number({ error: "Ange antal, 0 eller mer." })
      .int("Ange ett heltal.")
      .min(0, "Ange antal, 0 eller mer.")
      .max(MAX_PACKS, `Högst ${MAX_PACKS} pack.`),
  },
  { error: INVALID },
);

export const receiptSchema = z.object(
  {
    titleId: uuid,
    /** Vilket lager packen kom till. Utelämnat = standardlagret. */
    warehouseId: uuid.optional(),
    quantity: z
      .number({ error: "Ange antal pack, minst 1." })
      .int("Ange ett heltal.")
      .min(1, "Ange antal pack, minst 1.")
      .max(MAX_PACKS, `Högst ${MAX_PACKS} pack.`),
    /**
     * Vad ett pack kostade (öre). Skiljer det sig från dagens inköpspris sparas det som nytt
     * pris från i dag, i samma steg. Utelämnat = priset rörs inte.
     */
    unitCostOre: z
      .number({ error: "Skriv priset i kronor, t.ex. 112,50." })
      .int("Skriv priset i kronor, t.ex. 112,50.")
      .min(0, "Skriv priset i kronor, t.ex. 112,50.")
      .max(MAX_UNIT_COST_ORE, "Priset är för högt.")
      .optional(),
    /** true = användaren har sett varningen om ett konstigt pris och sparar ändå. */
    confirmed: z.boolean().optional(),
    /** Formulärets id för inskicket: samma id två gånger lägger in packen en gång. */
    clientId: uuid.optional(),
  },
  { error: INVALID },
);

const packs = z
  .number({ error: "Ange antal pack, minst 1." })
  .int("Ange ett heltal.")
  .min(1, "Ange antal pack, minst 1.")
  .max(MAX_PACKS, `Högst ${MAX_PACKS} pack.`);

export const moveSchema = z
  .object({ titleId: uuid, from: uuid, to: uuid, quantity: packs }, { error: INVALID })
  .refine((v) => v.from !== v.to, { message: "Välj två olika lager." });

export const undoMoveSchema = z.object({ transferId: uuid }, { error: INVALID });

const placeName = z
  .string({ error: "Skriv ett namn." })
  .trim()
  .min(1, "Skriv ett namn.")
  .max(60, "Namnet får vara högst 60 tecken.");

export const createPlaceSchema = z.object({ name: placeName }, { error: INVALID });
export const renamePlaceSchema = z.object({ id: uuid, name: placeName }, { error: INVALID });
export const archivePlaceSchema = z.object(
  { id: uuid, archived: z.boolean().default(true) },
  { error: INVALID },
);

export type HomeCountInput = z.infer<typeof homeCountSchema>;
export type ReceiptInput = z.infer<typeof receiptSchema>;
export type MoveInput = z.infer<typeof moveSchema>;

/** Felen från lagrens RPC:er (22023) har svenska meddelanden; övriga blir allmänna. */
function rethrowKnown(error: unknown): never {
  const pg = pgErrorOf(error);
  if (pg?.code === "22023" && pg.message) throw new LagerError(pg.message);
  throw error;
}

/** Antal i ett eget lager: en inventering (ägare, admin). Utan lager: standardlagret. */
export async function setHomeCountFor(
  viewer: Viewer,
  input: HomeCountInput,
): Promise<RegisterResult> {
  await requireRoleFor(viewer.user, viewer.organization.id, EDIT_ROLES);
  return registerCountFor(viewer, {
    location: "warehouse",
    ...(input.warehouseId ? { warehouseId: input.warehouseId } : {}),
    titleId: input.titleId,
    counted: input.counted,
    note: "Inventering, Vårt lager",
  });
}

/** Inköp: packen kom till ett eget lager (ägare, admin). Utan lager: standardlagret. */
export async function registerReceiptFor(
  viewer: Viewer,
  input: Pick<ReceiptInput, "titleId" | "warehouseId" | "quantity">,
): Promise<RegisterResult> {
  await requireRoleFor(viewer.user, viewer.organization.id, EDIT_ROLES);
  const orgId = viewer.organization.id;
  return withUserDbFor(viewer.user, async (tx) => {
    const [title] = await tx
      .select({ id: s.titles.id })
      .from(s.titles)
      .where(
        and(
          eq(s.titles.organizationId, orgId),
          eq(s.titles.id, input.titleId),
          isNull(s.titles.mergedIntoId),
          isNull(s.titles.archivedAt),
        ),
      )
      .limit(1);
    if (!title) throw new LagerError("Titeln finns inte i organisationen.");
    const placeId = await locationId(
      tx,
      orgId,
      input.warehouseId ? { warehouseId: input.warehouseId } : { central: true },
    );
    if (!placeId) {
      throw new LagerError(
        input.warehouseId ? "Lagret finns inte." : "Organisationen har inget eget lager.",
      );
    }
    const central = { id: placeId };
    const level = async () =>
      (
        await tx
          .select({ q: s.stockLevels.quantity })
          .from(s.stockLevels)
          .where(
            and(
              eq(s.stockLevels.organizationId, orgId),
              eq(s.stockLevels.locationId, central.id),
              eq(s.stockLevels.titleId, input.titleId),
            ),
          )
      )[0]?.q ?? 0;
    const previous = await level();
    await tx.insert(s.stockEvents).values({
      organizationId: orgId,
      locationId: central.id,
      titleId: input.titleId,
      kind: "receipt",
      quantity: input.quantity,
      performedBy: viewer.user.userId,
      note: "Inköp, Vårt lager",
    });
    return {
      previous,
      onHand: await level(),
      warehouseOnHand: null,
      placeName: await locationName(tx, orgId, central.id),
    };
  });
}

/** Vad som hände med priset vid en leverans. */
export interface ReceiptPrice {
  /**
   * none = inget pris angavs · same = samma som dagens pris (inget skrevs) · saved = nytt
   * pris från i dag · failed = packen sparades men priset gick inte att spara.
   */
  readonly status: "none" | "same" | "saved" | "failed";
  readonly unitCostOre?: number;
  /** Priset som gällde innan (null = titeln saknade pris). */
  readonly previousOre?: number | null;
  /** Varför priset inte sparades (status failed). */
  readonly error?: string;
}

export type ReceiptResult = RegisterResult & {
  readonly price: ReceiptPrice;
  /** Pack av titeln som fortfarande är på väg (beställda) efter inköpet. 0 = inget. */
  readonly stillOnTheWay?: number;
};

/**
 * Leverans med pris: antal + lager + vad ett pack kostade. Används av "+ Inköp" på Vårt
 * lager och av delägarens leveransformulär.
 *
 * 1. Ser priset konstigt ut (price-check.ts) och är inte bekräftat sparas ingenting:
 *    svaret är frågan (PriceDoubtResult).
 * 2. Packen sparas först, som en vanlig 'receipt'-händelse (registerReceiptFor).
 * 3. Är priset ett annat än dagens sparas det som nytt pris från i dag (äldre försäljning
 *    behåller sitt pris). Går det inte (t.ex. stängd månad) ligger packen kvar och svaret
 *    säger varför priset inte sparades. Samma pris skriver ingen prisrad.
 */
export async function registerReceiptWithPriceFor(
  viewer: Viewer,
  input: ReceiptInput,
  now: Date = new Date(),
): Promise<ReceiptResult | PriceDoubtResult> {
  await requireRoleFor(viewer.user, viewer.organization.id, EDIT_ROLES);
  const { unitCostOre, confirmed, ...receipt } = input;
  // Packen räknas först av från det som är beställt och på väg för titeln ("Beställt" på
  // inköpslistan), resten läggs in som ett vanligt inköp. Annars står beställningen kvar
  // som "På väg" och samma pack räknas två gånger när någon sedan trycker "Kom fram".
  return withReceiptPrice(
    viewer,
    { titleId: input.titleId, unitCostOre, confirmed },
    now,
    async () => {
      try {
        const r = await receiveArrivalFor(viewer, receipt, now);
        return {
          previous: r.previous,
          onHand: r.onHand,
          warehouseOnHand: null,
          placeName: r.placeName,
          stillOnTheWay: r.stillOnTheWay,
        };
      } catch (error) {
        if (error instanceof PurchasingError) throw new LagerError(error.message);
        throw error;
      }
    },
  );
}

/**
 * Prisdelen av en leverans, runt valfritt lagersteg (`stock`): ett vanligt inköp här, eller
 * "Kom fram" på inköpslistan (src/server/purchasing/quick.ts). Kollen körs före lagersteget,
 * priset sparas efter. Utan pris körs bara lagersteget.
 */
export async function withReceiptPrice<R extends object>(
  viewer: Viewer,
  input: { titleId: string; unitCostOre?: number | undefined; confirmed?: boolean | undefined },
  now: Date,
  stock: () => Promise<R>,
): Promise<(R & { readonly price: ReceiptPrice }) | PriceDoubtResult> {
  const { unitCostOre, confirmed } = input;
  if (unitCostOre === undefined) return { ...(await stock()), price: { status: "none" } };
  const organizationId = viewer.organization.id;
  const today = businessToday(now, viewer.organization.timezone);
  const check = await receiptPriceCheckFor(viewer.user, {
    organizationId,
    titleId: input.titleId,
    unitCostOre,
    today,
  });
  if (check.doubt && confirmed !== true) {
    return { ok: false, error: priceDoubtText(check.doubt), doubt: check.doubt };
  }
  const saved = await stock();
  if (check.currentOre === unitCostOre) {
    return { ...saved, price: { status: "same", unitCostOre, previousOre: check.currentOre } };
  }
  const price = await addPurchasePriceFor(viewer.user, {
    organizationId,
    titleId: input.titleId,
    unitCostOre,
    validFrom: today,
    note: "Inköp, Vårt lager",
  }).catch((error: unknown) => {
    console.error("[vart-lager] priset vid inköp", error);
    return { ok: false as const, error: "Priset gick inte att spara just nu." };
  });
  return {
    ...saved,
    price: price.ok
      ? { status: "saved", unitCostOre, previousOre: check.currentOre }
      : { status: "failed", unitCostOre, previousOre: check.currentOre, error: price.error },
  };
}

async function placeLevel(
  tx: Tx,
  orgId: string,
  location: string,
  titleId: string,
): Promise<number> {
  const rows = await tx
    .select({ q: s.stockLevels.quantity })
    .from(s.stockLevels)
    .where(
      and(
        eq(s.stockLevels.organizationId, orgId),
        eq(s.stockLevels.locationId, location),
        eq(s.stockLevels.titleId, titleId),
      ),
    );
  return rows[0]?.q ?? 0;
}

export interface MoveResult {
  /** Flyttens id (transfer_group_id), för Ångra. */
  readonly transferId: string;
  readonly fromName: string;
  readonly toName: string;
  /** Saldot efter flytten i lagret man flyttade från och till. */
  readonly fromOnHand: number;
  readonly toOnHand: number;
}

async function moveResult(
  tx: Tx,
  orgId: string,
  transferId: string,
  titleId: string,
  from: string,
  to: string,
): Promise<MoveResult> {
  return {
    transferId,
    fromName: (await locationName(tx, orgId, from)) ?? "",
    toName: (await locationName(tx, orgId, to)) ?? "",
    fromOnHand: await placeLevel(tx, orgId, from, titleId),
    toOnHand: await placeLevel(tx, orgId, to, titleId),
  };
}

/** Flytt mellan två egna lager (ägare, admin). Summan i vårt lager ändras inte. */
export async function moveStockFor(viewer: Viewer, input: MoveInput): Promise<MoveResult> {
  await requireRoleFor(viewer.user, viewer.organization.id, EDIT_ROLES);
  const orgId = viewer.organization.id;
  return withUserDbFor(viewer.user, async (tx) => {
    let transferId: string;
    try {
      const result = await tx.execute(
        sql`select public.transfer_stock(${orgId}::uuid, ${input.from}::uuid, ${input.to}::uuid,
              ${input.titleId}::uuid, ${input.quantity}::integer, null)::text as id`,
      );
      transferId = (Array.from(result)[0] as { id: string }).id;
    } catch (error) {
      rethrowKnown(error);
    }
    return moveResult(tx, orgId, transferId, input.titleId, input.from, input.to);
  });
}

/** Ångra en flytt: samma antal tillbaka (ägare, admin). Bara en gång per flytt. */
export async function undoMoveFor(
  viewer: Viewer,
  input: z.infer<typeof undoMoveSchema>,
): Promise<MoveResult> {
  await requireRoleFor(viewer.user, viewer.organization.id, EDIT_ROLES);
  const orgId = viewer.organization.id;
  return withUserDbFor(viewer.user, async (tx) => {
    let transferId: string;
    try {
      const result = await tx.execute(
        sql`select public.undo_transfer(${orgId}::uuid, ${input.transferId}::uuid)::text as id`,
      );
      transferId = (Array.from(result)[0] as { id: string }).id;
    } catch (error) {
      rethrowKnown(error);
    }
    const events = await tx
      .select({
        titleId: s.stockEvents.titleId,
        locationId: s.stockEvents.locationId,
        kind: s.stockEvents.kind,
      })
      .from(s.stockEvents)
      .where(
        and(eq(s.stockEvents.organizationId, orgId), eq(s.stockEvents.transferGroupId, transferId)),
      );
    const out = events.find((e) => e.kind === "transfer_out");
    const into = events.find((e) => e.kind === "transfer_in");
    if (!out || !into) throw new LagerError("Flytten finns inte.");
    return moveResult(tx, orgId, transferId, out.titleId, out.locationId, into.locationId);
  });
}

/** Nytt eget lager (ägare, admin). Returnerar lagrets id. */
export async function createPlaceFor(
  viewer: Viewer,
  input: z.infer<typeof createPlaceSchema>,
): Promise<{ id: string; name: string }> {
  await requireRoleFor(viewer.user, viewer.organization.id, EDIT_ROLES);
  const orgId = viewer.organization.id;
  return withUserDbFor(viewer.user, async (tx) => {
    try {
      const result = await tx.execute(
        sql`select public.create_warehouse(${orgId}::uuid, ${input.name})::text as id`,
      );
      const id = (Array.from(result)[0] as { id: string }).id;
      return { id, name: (await locationName(tx, orgId, id)) ?? input.name };
    } catch (error) {
      rethrowKnown(error);
    }
  });
}

/** Byt namn på ett eget lager (ägare, admin). */
export async function renamePlaceFor(
  viewer: Viewer,
  input: z.infer<typeof renamePlaceSchema>,
): Promise<{ id: string; name: string }> {
  await requireRoleFor(viewer.user, viewer.organization.id, EDIT_ROLES);
  const orgId = viewer.organization.id;
  return withUserDbFor(viewer.user, async (tx) => {
    try {
      await tx.execute(
        sql`select public.rename_warehouse(${orgId}::uuid, ${input.id}::uuid, ${input.name})`,
      );
    } catch (error) {
      rethrowKnown(error);
    }
    return { id: input.id, name: (await locationName(tx, orgId, input.id)) ?? input.name };
  });
}

/** Ta bort (arkivera) ett tomt lager, eller ta tillbaka det (Ångra). Ägare, admin. */
export async function archivePlaceFor(
  viewer: Viewer,
  input: z.input<typeof archivePlaceSchema>,
): Promise<{ id: string; name: string; archived: boolean }> {
  await requireRoleFor(viewer.user, viewer.organization.id, EDIT_ROLES);
  const orgId = viewer.organization.id;
  const archived = input.archived ?? true;
  return withUserDbFor(viewer.user, async (tx) => {
    try {
      await tx.execute(
        sql`select public.archive_warehouse(${orgId}::uuid, ${input.id}::uuid, ${archived}::boolean)`,
      );
    } catch (error) {
      rethrowKnown(error);
    }
    return { id: input.id, name: (await locationName(tx, orgId, input.id)) ?? "", archived };
  });
}

/** Automatens "Fylls på från" (ägare, admin). null = standardlagret. */
export async function setRefillSourceFor(
  viewer: Viewer,
  input: { machineId: string; placeId: string | null },
): Promise<{ placeId: string | null; name: string | null }> {
  await requireRoleFor(viewer.user, viewer.organization.id, EDIT_ROLES);
  const orgId = viewer.organization.id;
  const parsed = z
    .object({ machineId: uuid, placeId: uuid.nullable() }, { error: INVALID })
    .parse(input);
  return withUserDbFor(viewer.user, async (tx) => {
    try {
      await tx.execute(
        sql`select public.set_refill_source(${orgId}::uuid, ${parsed.machineId}::uuid,
              ${parsed.placeId}::uuid)`,
      );
    } catch (error) {
      rethrowKnown(error);
    }
    return {
      placeId: parsed.placeId,
      name: parsed.placeId ? await locationName(tx, orgId, parsed.placeId) : null,
    };
  });
}
