/**
 * "Beställt" och "Kom fram" direkt på inköpslistan, utan leverantörsregister (T3-4).
 *
 * - quickOrderFor: "Beställt" skapar en inköpsorder hos den inbyggda leverantören
 *   "Eget inköp" (skapas vid första användningen), beställd i dag och väntad om 7 dagar.
 *   Ingen leverantörsartikel behövs. Inköpsplanen räknar redan av det som är beställt, så
 *   listan slutar fråga efter de packen.
 * - receiveArrivalFor: "Kom fram" / "Köpt, har dem här". Packen bokas först mot det som är
 *   på väg för titeln (äldst först; databasen skriver lagerhändelsen 'receipt'), resten som
 *   ett vanligt inköp. Bara "Kom fram" på en "På väg"-rad (`closeShort`) avslutar en order
 *   hos "Eget inköp" där färre kom, så att planen ber om resten igen. Alla andra inköp
 *   ("Köpt, har dem här", "+ Inköp" på Vårt lager, delägarens leverans) räknas av från det
 *   som är på väg och låter resten stå kvar som på väg: annars skulle ett extra köp i butik
 *   stryka en beställning som fortfarande är på väg, och en leverans som läggs in på Vårt
 *   lager skulle räknas två gånger när någon sedan trycker "Kom fram". Ett annat lager än
 *   standardlagret: packen flyttas dit i samma transaktion (transfer_stock).
 * - notComingFor: "Kommer inte". Det som är på väg för titeln väntas inte längre, och
 *   listan ber om packen igen.
 * - onTheWay (src/analytics/purchasing/on-the-way.ts): det som är på väg per titel.
 *
 * Inget skrivs två gånger: formuläret skickar ett eget id (`clientId`) och behåller det tills
 * svaret kommit. Samma id en gång till (dubbeltryck, eller ett nytt försök efter ett svar som
 * aldrig kom fram) ger samma svar och ingen ny order eller lagerhändelse
 * (public.purchase_requests). "Kom fram" på en rad där inget längre är på väg vägras: den
 * leveransen är redan inlagd.
 *
 * Allt skrivs som användaren med RLS (ägare och admin, som övriga inköp).
 */

import "server-only";

import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";

import type { Tx } from "@/db/client";
import * as s from "@/db/schema";
import { addDays, type IsoDate } from "@/domain";
import { requireRoleFor, withUserDbFor } from "@/server/access";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { OPERATOR_ROLES } from "@/server/data/core/types";
import { pgErrorOf } from "@/server/errors";

import { PurchasingError } from "./service";

/** Den inbyggda leverantören för det man köper själv, utan leverantörsregister. */
export const OWN_SUPPLIER_NAME = "Eget inköp";
/** "kommer om ca 7 dagar" */
export const ARRIVES_IN_DAYS = 7;
/**
 * Utan `clientId` (en äldre flik): samma "Beställt" (titel och antal) inom så här många
 * sekunder är ett omtryck, inte en ny order. Med `clientId` avgör id:t.
 */
const SAME_ORDER_SECONDS = 60;

const uuid = z
  .string()
  .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i, "Ogiltigt id.");
const packs = z
  .number({ error: "Ange antal pack, minst 1." })
  .int("Ange ett heltal.")
  .min(1, "Ange antal pack, minst 1.")
  .max(10_000, "Högst 10 000 pack.");

export const quickOrderSchema = z.object({
  titleId: uuid,
  quantity: packs,
  /** Formulärets id för inskicket: samma id två gånger ger en order, inte två. */
  clientId: uuid.optional(),
});
export type QuickOrderInput = z.infer<typeof quickOrderSchema>;

export const arrivalSchema = z.object({
  titleId: uuid,
  quantity: packs,
  /** Vilket lager packen kom till. Utelämnat = standardlagret. */
  warehouseId: uuid.optional(),
  /** Vad ett pack kostade (öre); ett annat pris än dagens sparas från i dag. */
  unitCostOre: z.number().int().min(0).max(10_000_000).optional(),
  confirmed: z.boolean().optional(),
  /**
   * true = "Kom fram" på en "På väg"-rad: det här var hela leveransen, så kom färre än
   * beställt väntas resten inte längre. Annars står resten kvar som på väg.
   */
  closeShort: z.boolean().optional(),
  /** Formulärets id för inskicket: samma id två gånger lägger in packen en gång. */
  clientId: uuid.optional(),
});
export type ArrivalInput = z.infer<typeof arrivalSchema>;

async function asBuyer<T>(viewer: Viewer, fn: (tx: Tx) => Promise<T>): Promise<T> {
  await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  try {
    return await withUserDbFor(viewer.user, fn);
  } catch (error) {
    const pg = pgErrorOf(error);
    if (pg?.code === "22023" && pg.message) throw new PurchasingError(pg.message);
    throw error;
  }
}

async function assertTitle(tx: Tx, orgId: string, titleId: string): Promise<void> {
  const [title] = await tx
    .select({ id: s.titles.id })
    .from(s.titles)
    .where(
      and(
        eq(s.titles.organizationId, orgId),
        eq(s.titles.id, titleId),
        isNull(s.titles.mergedIntoId),
        isNull(s.titles.archivedAt),
      ),
    )
    .limit(1);
  if (!title) throw new PurchasingError("Titeln finns inte i organisationen.");
}

/** Svaret när "Kom fram" trycks för en leverans som redan är inlagd. */
export const ALREADY_RECEIVED = "Leveransen är redan inlagd. Ladda om sidan.";

/**
 * Kör `fn` en gång per `clientId`. Finns inskicket redan (public.purchase_requests) körs
 * ingenting: svaret från första gången returneras. Utan id körs `fn` som vanligt.
 */
async function once<T extends object>(
  tx: Tx,
  viewer: Viewer,
  request: { clientId: string | undefined; kind: s.PurchaseRequestKind; titleId: string },
  fn: () => Promise<T>,
): Promise<T> {
  const orgId = viewer.organization.id;
  const { clientId } = request;
  if (!clientId) return fn();
  // Två samtidiga inskick med samma id: det andra väntar här och hittar sedan raden.
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`inkop:${orgId}:${clientId}`}, 0))`,
  );
  const [seen] = await tx
    .select({
      kind: s.purchaseRequests.kind,
      titleId: s.purchaseRequests.titleId,
      result: s.purchaseRequests.result,
    })
    .from(s.purchaseRequests)
    .where(
      and(eq(s.purchaseRequests.organizationId, orgId), eq(s.purchaseRequests.clientId, clientId)),
    )
    .limit(1);
  if (seen) {
    if (seen.kind !== request.kind || seen.titleId !== request.titleId) {
      throw new PurchasingError("Ogiltigt inskick. Ladda om sidan och försök igen.");
    }
    return seen.result as T;
  }
  const result = await fn();
  await tx.insert(s.purchaseRequests).values({
    organizationId: orgId,
    clientId,
    kind: request.kind,
    titleId: request.titleId,
    result: result as Record<string, unknown>,
  });
  return result;
}

/** "Eget inköp": finns den inte (eller är arkiverad) skapas den. */
async function ownSupplierId(tx: Tx, orgId: string): Promise<string> {
  const [found] = await tx
    .select({ id: s.suppliers.id })
    .from(s.suppliers)
    .where(
      and(
        eq(s.suppliers.organizationId, orgId),
        eq(s.suppliers.name, OWN_SUPPLIER_NAME),
        isNull(s.suppliers.archivedAt),
      ),
    )
    .orderBy(asc(s.suppliers.createdAt))
    .limit(1);
  if (found) return found.id;
  const [created] = await tx
    .insert(s.suppliers)
    .values({
      organizationId: orgId,
      name: OWN_SUPPLIER_NAME,
      defaultLeadTimeDays: ARRIVES_IN_DAYS,
    })
    .returning({ id: s.suppliers.id });
  return created!.id;
}

export interface QuickOrderResult {
  readonly orderId: string;
  readonly quantity: number;
  readonly expectedOn: IsoDate;
}

/** "Beställt": en beställd inköpsorder hos "Eget inköp", väntad om 7 dagar. */
export async function quickOrderFor(
  viewer: Viewer,
  input: QuickOrderInput,
  now: Date = new Date(),
): Promise<QuickOrderResult> {
  const orgId = viewer.organization.id;
  const today = businessToday(now, viewer.organization.timezone);
  const expectedOn = addDays(today, ARRIVES_IN_DAYS);
  return asBuyer(viewer, async (tx) => {
    await assertTitle(tx, orgId, input.titleId);
    // En i taget per organisation: två samtidiga "Beställt" ska inte skapa två "Eget inköp"
    // eller samma beställning två gånger.
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${`eget-inkop:${orgId}`}, 0))`,
    );
    return once<QuickOrderResult>(
      tx,
      viewer,
      { clientId: input.clientId, kind: "order", titleId: input.titleId },
      () => placeOrder(tx, orgId, input, today, expectedOn),
    );
  });
}

async function placeOrder(
  tx: Tx,
  orgId: string,
  input: QuickOrderInput,
  today: IsoDate,
  expectedOn: IsoDate,
): Promise<QuickOrderResult> {
  {
    const supplierId = await ownSupplierId(tx, orgId);
    // Utan id från formuläret: samma beställning igen inom en minut (svaret kom aldrig fram
    // och man tryckte en gång till) är den första, ingen ny order.
    const same = input.clientId
      ? undefined
      : (Array.from(
          await tx.execute(
            sql`select po.id, po.expected_on::text as expected_on
            from public.purchase_orders po
            join public.purchase_order_lines l
              on l.organization_id = po.organization_id and l.purchase_order_id = po.id
            where po.organization_id = ${orgId}::uuid and po.supplier_id = ${supplierId}::uuid
              and po.status = 'ordered'
              and po.created_at > now() - make_interval(secs => ${SAME_ORDER_SECONDS})
              and l.title_id = ${input.titleId}::uuid and l.quantity = ${input.quantity}
              and l.received_quantity = 0
            order by po.created_at desc limit 1`,
          ),
        )[0] as { id: string; expected_on: string | null } | undefined);
    if (same) {
      return {
        orderId: same.id,
        quantity: input.quantity,
        expectedOn: (same.expected_on ?? expectedOn) as IsoDate,
      };
    }
    // Priset på raden: dagens inköpspris (Inköpspriser), annars 0.
    const price = Array.from(
      await tx.execute(
        sql`select pp.unit_cost_ore::bigint as ore from public.purchase_prices pp
            where pp.organization_id = ${orgId}::uuid and pp.title_id = ${input.titleId}::uuid
              and pp.valid_from <= ${today}::date
            order by pp.valid_from desc limit 1`,
      ),
    )[0] as { ore: unknown } | undefined;
    const [po] = await tx
      .insert(s.purchaseOrders)
      .values({
        organizationId: orgId,
        supplierId,
        status: "ordered",
        orderedOn: today,
        expectedOn,
        note: "Beställt från inköpslistan",
      })
      .returning({ id: s.purchaseOrders.id });
    await tx.insert(s.purchaseOrderLines).values({
      organizationId: orgId,
      purchaseOrderId: po!.id,
      titleId: input.titleId,
      quantity: input.quantity,
      unitCostOre: price ? Number(price.ore) : 0,
    });
    return { orderId: po!.id, quantity: input.quantity, expectedOn };
  }
}

export interface ArrivalResult {
  /** Saldot före och efter i lagret packen kom till. */
  readonly previous: number;
  readonly onHand: number;
  readonly placeName: string | null;
  /** Pack som var på väg för titeln innan leveransen (0 = inget var beställt). */
  readonly expected: number;
  /** Pack som bokades mot det som var på väg. */
  readonly fromOrders: number;
  /**
   * Pack som inte kom och inte längre väntas (ordern hos "Eget inköp" avslutades):
   * inköpslistan ber om dem igen.
   */
  readonly missing: number;
  /** Pack av titeln som fortfarande är på väg efter leveransen. */
  readonly stillOnTheWay: number;
}

/**
 * Leveransen kom: `quantity` pack av titeln till `warehouseId` (annars standardlagret).
 * En transaktion: antingen bokas allt eller inget.
 */
export async function receiveArrivalFor(
  viewer: Viewer,
  input: Pick<ArrivalInput, "titleId" | "quantity" | "warehouseId" | "closeShort" | "clientId">,
  now: Date = new Date(),
): Promise<ArrivalResult> {
  const orgId = viewer.organization.id;
  const today = businessToday(now, viewer.organization.timezone);
  return asBuyer(viewer, async (tx) => {
    await assertTitle(tx, orgId, input.titleId);
    return once<ArrivalResult>(
      tx,
      viewer,
      { clientId: input.clientId, kind: "arrival", titleId: input.titleId },
      () => bookArrival(tx, viewer, input, today),
    );
  });
}

async function bookArrival(
  tx: Tx,
  viewer: Viewer,
  input: Pick<ArrivalInput, "titleId" | "quantity" | "warehouseId" | "closeShort">,
  today: IsoDate,
): Promise<ArrivalResult> {
  const orgId = viewer.organization.id;
  {
    const places = await tx
      .select({
        id: s.stockLocations.id,
        name: s.stockLocations.name,
        isCentral: s.stockLocations.isCentral,
      })
      .from(s.stockLocations)
      .where(
        and(
          eq(s.stockLocations.organizationId, orgId),
          eq(s.stockLocations.kind, "warehouse"),
          isNull(s.stockLocations.archivedAt),
        ),
      );
    const central = places.find((p) => p.isCentral);
    const target = input.warehouseId ? places.find((p) => p.id === input.warehouseId) : central;
    if (!target) {
      throw new PurchasingError(
        input.warehouseId ? "Lagret finns inte." : "Organisationen har inget eget lager.",
      );
    }
    const level = async () =>
      (
        await tx
          .select({ q: s.stockLevels.quantity })
          .from(s.stockLevels)
          .where(
            and(
              eq(s.stockLevels.organizationId, orgId),
              eq(s.stockLevels.locationId, target.id),
              eq(s.stockLevels.titleId, input.titleId),
            ),
          )
      )[0]?.q ?? 0;
    const previous = await level();

    // Det som är på väg för titeln, äldst först (låst mot samtidig mottagning).
    const open = Array.from(
      await tx.execute(
        sql`select l.id as line_id, l.purchase_order_id as order_id, l.quantity::int as quantity,
                   l.received_quantity::int as received, po.note,
                   (sup.name = ${OWN_SUPPLIER_NAME}) as own
            from public.purchase_order_lines l
            join public.purchase_orders po
              on po.organization_id = l.organization_id and po.id = l.purchase_order_id
            join public.suppliers sup
              on sup.organization_id = po.organization_id and sup.id = po.supplier_id
            where l.organization_id = ${orgId}::uuid and l.title_id = ${input.titleId}::uuid
              and po.status in ('ordered', 'partially_received')
              and l.received_quantity < l.quantity
            order by po.expected_on nulls last, po.created_at, l.id
            for update of l, po`,
      ),
    ) as {
      line_id: string;
      order_id: string;
      quantity: number;
      received: number;
      note: string | null;
      own: boolean;
    }[];
    const expected = open.reduce((sum, l) => sum + (l.quantity - l.received), 0);
    // "Kom fram" på en rad där inget längre är på väg: leveransen är redan inlagd (ett
    // dubbeltryck, eller en annan flik hann före). Skriv ingenting.
    if (input.closeShort === true && expected === 0) throw new PurchasingError(ALREADY_RECEIVED);
    let left = input.quantity;
    let missing = 0;
    const touched = new Map<string, { own: boolean; note: string | null; short: number }>();
    for (const line of open) {
      if (left <= 0) break;
      const outstanding = line.quantity - line.received;
      const take = Math.min(left, outstanding);
      left -= take;
      await tx
        .update(s.purchaseOrderLines)
        .set({ receivedQuantity: line.received + take })
        .where(
          and(
            eq(s.purchaseOrderLines.organizationId, orgId),
            eq(s.purchaseOrderLines.id, line.line_id),
          ),
        );
      touched.set(line.order_id, { own: line.own, note: line.note, short: outstanding - take });
    }
    const fromOrders = input.quantity - left;
    // Orderns nya läge: allt mottaget = mottagen. "Kom fram" (closeShort) på en order hos
    // "Eget inköp" där färre kom avslutar den (resten väntas inte längre). Annars står
    // resten kvar som på väg; andra leverantörers order sköts under Inköpsorder.
    if (touched.size > 0) {
      const rest = Array.from(
        await tx.execute(
          sql`select l.purchase_order_id as order_id,
                     sum(l.quantity - l.received_quantity)::int as outstanding
              from public.purchase_order_lines l
              where l.organization_id = ${orgId}::uuid
                and l.purchase_order_id in ${inList([...touched.keys()])}
              group by l.purchase_order_id`,
        ),
      ) as { order_id: string; outstanding: number }[];
      for (const r of rest) {
        const info = touched.get(r.order_id)!;
        const complete = r.outstanding === 0;
        const close = !complete && info.own && input.closeShort === true;
        if (close) missing += r.outstanding;
        const line = `Avslutad ${today}: ${r.outstanding} pack kom aldrig.`;
        await tx
          .update(s.purchaseOrders)
          .set(
            complete || close
              ? {
                  status: "received",
                  receivedOn: today,
                  ...(close ? { note: info.note ? `${info.note}\n${line}` : line } : {}),
                }
              : { status: "partially_received" },
          )
          .where(
            and(eq(s.purchaseOrders.organizationId, orgId), eq(s.purchaseOrders.id, r.order_id)),
          );
      }
    }
    // Databasen lade de mottagna packen i standardlagret: flytta dem till valt lager.
    if (fromOrders > 0 && central && target.id !== central.id) {
      await tx.execute(
        sql`select public.transfer_stock(${orgId}::uuid, ${central.id}::uuid, ${target.id}::uuid,
              ${input.titleId}::uuid, ${fromOrders}::integer, null)`,
      );
    }
    // Fler än beställt (eller inget beställt): ett vanligt inköp direkt i lagret.
    if (left > 0) {
      await tx.insert(s.stockEvents).values({
        organizationId: orgId,
        locationId: target.id,
        titleId: input.titleId,
        kind: "receipt",
        quantity: left,
        performedBy: viewer.user.userId,
        note: "Inköp, Vårt lager",
      });
    }
    return {
      previous,
      onHand: await level(),
      placeName: target.name,
      expected,
      fromOrders,
      missing,
      stillOnTheWay: expected - fromOrders - missing,
    };
  }
}

export interface NotComingResult {
  /** Pack som inte längre väntas: inköpslistan ber om dem igen. */
  readonly dropped: number;
}

/**
 * "Kommer inte": det som är på väg för titeln väntas inte längre. En order där inget kommit
 * avbryts, en delvis mottagen avslutas ("N pack kom aldrig"). Bara order som enbart gäller
 * den här titeln (det är alla som skapats med "Beställt"); en order med flera titlar sköts
 * under Inköpsorder.
 */
export async function notComingFor(
  viewer: Viewer,
  input: { titleId: string },
  now: Date = new Date(),
): Promise<NotComingResult> {
  const orgId = viewer.organization.id;
  const today = businessToday(now, viewer.organization.timezone);
  return asBuyer(viewer, async (tx) => {
    await assertTitle(tx, orgId, input.titleId);
    const hasTitle = sql`po.id in (
      select x.purchase_order_id from public.purchase_order_lines x
      where x.organization_id = ${orgId}::uuid and x.title_id = ${input.titleId}::uuid
        and x.received_quantity < x.quantity)`;
    // Lås orderna först (mot en samtidig mottagning), räkna sedan.
    await tx.execute(
      sql`select po.id from public.purchase_orders po
          where po.organization_id = ${orgId}::uuid
            and po.status in ('ordered', 'partially_received') and ${hasTitle}
          for update`,
    );
    const open = Array.from(
      await tx.execute(
        sql`select po.id, po.status::text as status, po.note,
                   sum(l.quantity - l.received_quantity)::int as outstanding,
                   bool_and(l.title_id = ${input.titleId}::uuid) as only_title
            from public.purchase_orders po
            join public.purchase_order_lines l
              on l.organization_id = po.organization_id and l.purchase_order_id = po.id
            where po.organization_id = ${orgId}::uuid
              and po.status in ('ordered', 'partially_received') and ${hasTitle}
            group by po.id, po.status, po.note, po.created_at
            order by po.created_at`,
      ),
    ) as {
      id: string;
      status: string;
      note: string | null;
      outstanding: number;
      only_title: boolean;
    }[];
    if (open.length === 0) throw new PurchasingError("Inget är på väg för titeln.");
    const mine = open.filter((o) => o.only_title);
    if (mine.length === 0) {
      throw new PurchasingError("Beställningen har fler titlar. Avsluta den under Inköp, Mer.");
    }
    let dropped = 0;
    for (const o of mine) {
      dropped += o.outstanding;
      const line = `Avslutad ${today}: ${o.outstanding} pack kom aldrig.`;
      await tx
        .update(s.purchaseOrders)
        .set(
          o.status === "ordered"
            ? { status: "cancelled", note: o.note ? `${o.note}\n${line}` : line }
            : {
                status: "received",
                receivedOn: today,
                note: o.note ? `${o.note}\n${line}` : line,
              },
        )
        .where(and(eq(s.purchaseOrders.organizationId, orgId), eq(s.purchaseOrders.id, o.id)));
    }
    return { dropped };
  });
}

function inList(ids: readonly string[]) {
  return sql`(${sql.join(
    ids.map((id) => sql`${id}::uuid`),
    sql`, `,
  )})`;
}

export { onTheWay, type OnTheWay } from "@/analytics/purchasing/on-the-way";
