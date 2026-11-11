/**
 * Inventering (räkna ett helt eget lager), mot testdatabasen:
 *
 * - Transaktionen: alla räknade titlar sparas på en gång som 'count'-händelser med
 *   noteringen "Inventering, Hemma" och en rad i stock_counts. Det som hoppas över ändras
 *   inte. Går en rad inte att spara sparas ingenting.
 * - Behörighet: ägare, admin och delägaren med Enkel vy (ägarroll) får inventera. Läsaren
 *   och påfyllaren nekas, också direkt mot databasen, och ingen når en annan organisation.
 * - Idempotens: samma inskick två gånger (dubbeltryck eller nytt försök efter ett
 *   nätverksfel) sparas en gång, även när de kommer samtidigt.
 * - "Senast inventerad" på sidan och punkten "Inventera Hemma" i Att göra efter 30 dagar.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { AuthorizationError, listOrganizationsFor } from "../../src/server/access";
import { loadTodoStateFor, type Viewer } from "../../src/server/data/core/loaders";
import { LagerError } from "../../src/app/(app)/lager/_lib/register";
import { createPlaceFor } from "../../src/app/(app)/vart-lager/_lib/register";
import { loadStockCountFor } from "../../src/app/(app)/vart-lager/inventering/_lib/data";
import {
  saveStockCountFor,
  stockCountSchema,
} from "../../src/app/(app)/vart-lager/inventering/_lib/service";

import {
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  rows,
  type TestUser,
} from "./helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

const session = (u: TestUser) => ({ userId: u.id, email: u.email });

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = session(u);
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

describe("Inventering", () => {
  let owner: TestUser;
  let admin: TestUser;
  let partner: TestUser;
  let viewer: TestUser;
  let refiller: TestUser;
  let orgId: string;
  let hemma: string;
  let kontoret: string;
  let paldea: string;
  let surging: string;
  let prismatic: string;
  let archived: string;

  const level = async (location: string, title: string) =>
    (
      await rows<{ q: number }>(
        db(),
        sql`select quantity as q from public.stock_levels
            where location_id = ${location}::uuid and title_id = ${title}::uuid`,
      )
    )[0]?.q ?? 0;

  const eventCount = async () =>
    (
      await one<{ n: number }>(
        db(),
        sql`select count(*)::int as n from public.stock_events
            where organization_id = ${orgId}::uuid`,
      )
    ).n;

  const countRows = async () =>
    (
      await one<{ n: number }>(
        db(),
        sql`select count(*)::int as n from public.stock_counts
            where organization_id = ${orgId}::uuid`,
      )
    ).n;

  beforeAll(async () => {
    owner = await createUser();
    orgId = await createOrg(owner, "Inventering");
    admin = await createMember(orgId, "admin");
    partner = await createMember(orgId, "owner");
    viewer = await createMember(orgId, "viewer");
    refiller = await createMember(orgId, "refiller");
    await db().execute(
      sql`update public.memberships set view_mode = 'simple'
          where organization_id = ${orgId}::uuid and user_id = ${partner.id}::uuid`,
    );
    const titles = await asUser(owner, (tx) =>
      tx
        .insert(s.titles)
        .values([
          { organizationId: orgId, name: "Paldea Evolved" },
          { organizationId: orgId, name: "Surging Sparks" },
          { organizationId: orgId, name: "Prismatic Evolutions" },
          { organizationId: orgId, name: "Gammal titel" },
        ])
        .returning(),
    );
    [paldea, surging, prismatic, archived] = titles.map((t) => t.id) as [
      string,
      string,
      string,
      string,
    ];
    await db().execute(
      sql`update public.titles set archived_at = now() where id = ${archived}::uuid`,
    );
    hemma = (
      await one<{ id: string }>(
        db(),
        sql`select id from public.stock_locations
            where organization_id = ${orgId}::uuid and is_central and archived_at is null`,
      )
    ).id;
    kontoret = (await createPlaceFor(await viewerFor(owner, orgId), { name: "Kontoret" })).id;
    // Det appen tror före inventeringen: Hemma 162 / 40 / 12, Kontoret 5 Paldea.
    await asUser(owner, (tx) =>
      tx.insert(s.stockEvents).values([
        { organizationId: orgId, locationId: hemma, titleId: paldea, kind: "count", quantity: 162 },
        { organizationId: orgId, locationId: hemma, titleId: surging, kind: "count", quantity: 40 },
        {
          organizationId: orgId,
          locationId: hemma,
          titleId: prismatic,
          kind: "count",
          quantity: 12,
        },
        {
          organizationId: orgId,
          locationId: kontoret,
          titleId: paldea,
          kind: "count",
          quantity: 5,
        },
      ]),
    );
  });

  describe("transaktionen", () => {
    it("sparar alla räknade titlar på en gång, och det som hoppas över ändras inte", async () => {
      const before = await eventCount();
      const res = await saveStockCountFor(await viewerFor(owner, orgId), {
        clientId: randomUUID(),
        placeId: hemma,
        lines: [
          { titleId: paldea, counted: 0 },
          { titleId: surging, counted: 40 },
        ],
      });
      expect(res.duplicate).toBe(false);
      expect(res.lines).toEqual([
        { titleId: paldea, name: "Paldea Evolved", previous: 162, counted: 0 },
        { titleId: surging, name: "Surging Sparks", previous: 40, counted: 40 },
      ]);
      expect(await level(hemma, paldea)).toBe(0);
      expect(await level(hemma, surging)).toBe(40);
      // Hoppades över: Prismatic hemma och allt i Kontoret.
      expect(await level(hemma, prismatic)).toBe(12);
      expect(await level(kontoret, paldea)).toBe(5);
      expect(await eventCount()).toBe(before + 2);

      // Historiken visar att det var en inventering, och vem som räknade.
      const events = await rows<{
        kind: string;
        quantity: number;
        note: string;
        performed_by: string;
        source: string | null;
      }>(
        db(),
        sql`select kind::text as kind, quantity, note, performed_by::text as performed_by, source
            from public.stock_events
            where organization_id = ${orgId}::uuid and location_id = ${hemma}::uuid
            order by seq desc limit 2`,
      );
      expect(events.map((e) => e.kind)).toEqual(["count", "count"]);
      expect(events.map((e) => e.quantity).sort()).toEqual([0, 40]);
      expect(new Set(events.map((e) => e.note))).toEqual(new Set(["Inventering, Hemma"]));
      expect(new Set(events.map((e) => e.performed_by))).toEqual(new Set([owner.id]));
      expect(events.every((e) => e.source === null)).toBe(true);

      const saved = await one<{
        location_id: string;
        line_count: number;
        changed_count: number;
        counted_by: string;
        lines: { titleId: string; previous: number; counted: number; eventId: string }[];
      }>(
        db(),
        sql`select location_id::text as location_id, line_count, changed_count,
                   counted_by::text as counted_by, lines
            from public.stock_counts where id = ${res.countId}::uuid`,
      );
      expect(saved).toMatchObject({
        location_id: hemma,
        line_count: 2,
        changed_count: 1,
        counted_by: owner.id,
      });
      expect(saved.lines.map((l) => [l.titleId, l.previous, l.counted])).toEqual([
        [paldea, 162, 0],
        [surging, 40, 40],
      ]);
      // Raderna pekar på lagerhändelserna.
      const linked = await one<{ n: number }>(
        db(),
        sql`select count(*)::int as n from public.stock_events
            where id = any(${sql.raw(`array[${saved.lines.map((l) => `'${l.eventId}'`).join(",")}]::uuid[]`)})
              and kind = 'count' and location_id = ${hemma}::uuid`,
      );
      expect(linked.n).toBe(2);
      // Loggas i audit_log som användarens.
      const audit = await rows<{ actor_id: string }>(
        db(),
        sql`select actor_id::text as actor_id from public.audit_log
            where organization_id = ${orgId}::uuid and table_name = 'stock_counts'`,
      );
      expect(audit.map((a) => a.actor_id)).toEqual([owner.id]);
    });

    it("går en rad inte att spara sparas ingenting (allt eller inget)", async () => {
      const before = { events: await eventCount(), counts: await countRows() };
      const v = await viewerFor(owner, orgId);
      // En arkiverad titel sist: de två första raderna får inte bli kvar.
      await expect(
        saveStockCountFor(v, {
          clientId: randomUUID(),
          placeId: hemma,
          lines: [
            { titleId: paldea, counted: 7 },
            { titleId: prismatic, counted: 1 },
            { titleId: archived, counted: 3 },
          ],
        }),
      ).rejects.toThrow(new LagerError("Titeln finns inte i organisationen."));
      // En titel som inte finns.
      await expect(
        saveStockCountFor(v, {
          clientId: randomUUID(),
          placeId: hemma,
          lines: [
            { titleId: paldea, counted: 7 },
            { titleId: randomUUID(), counted: 3 },
          ],
        }),
      ).rejects.toThrow(LagerError);
      // Ett lager som inte finns (eller en automats lagerplats).
      await expect(
        saveStockCountFor(v, {
          clientId: randomUUID(),
          placeId: randomUUID(),
          lines: [{ titleId: paldea, counted: 7 }],
        }),
      ).rejects.toThrow(new LagerError("Lagret finns inte."));
      expect(await level(hemma, paldea)).toBe(0);
      expect(await level(hemma, prismatic)).toBe(12);
      expect({ events: await eventCount(), counts: await countRows() }).toEqual(before);
    });

    it("varje lager räknas för sig", async () => {
      const res = await saveStockCountFor(await viewerFor(owner, orgId), {
        clientId: randomUUID(),
        placeId: kontoret,
        lines: [
          { titleId: paldea, counted: 9 },
          { titleId: prismatic, counted: 2 },
        ],
      });
      expect(res.lines.map((l) => [l.previous, l.counted])).toEqual([
        [5, 9],
        [0, 2],
      ]);
      expect(await level(kontoret, paldea)).toBe(9);
      expect(await level(kontoret, prismatic)).toBe(2);
      expect(await level(hemma, paldea)).toBe(0);
      expect(await level(hemma, prismatic)).toBe(12);
      const note = await one<{ note: string }>(
        db(),
        sql`select note from public.stock_events
            where organization_id = ${orgId}::uuid and location_id = ${kontoret}::uuid
            order by seq desc limit 1`,
      );
      expect(note.note).toBe("Inventering, Kontoret");
    });

    it("indata: minst en rad, heltal 0–10 000 och en rad per produkt", () => {
      const base = { clientId: randomUUID(), placeId: hemma };
      const bad = (lines: unknown) => stockCountSchema.safeParse({ ...base, lines }).success;
      expect(bad([])).toBe(false);
      expect(bad([{ titleId: paldea, counted: -1 }])).toBe(false);
      expect(bad([{ titleId: paldea, counted: 1.5 }])).toBe(false);
      expect(bad([{ titleId: paldea, counted: 10_001 }])).toBe(false);
      expect(bad([{ titleId: paldea, counted: "3" }])).toBe(false);
      expect(
        bad([
          { titleId: paldea, counted: 1 },
          { titleId: paldea, counted: 2 },
        ]),
      ).toBe(false);
      expect(bad([{ titleId: paldea, counted: 10_000 }])).toBe(true);
      expect(stockCountSchema.safeParse({ ...base, clientId: "x", lines: [] }).success).toBe(false);
    });

    it("databasen kontrollerar samma sak (anrop förbi appen)", async () => {
      const before = { events: await eventCount(), counts: await countRows() };
      const call = (lines: unknown) =>
        asUser(owner, (tx) =>
          attempt(tx, (sp) =>
            sp.execute(
              sql`select * from public.save_stock_count(${orgId}::uuid, gen_random_uuid(),
                    ${hemma}::uuid, ${JSON.stringify(lines)}::jsonb)`,
            ),
          ),
        );
      for (const lines of [
        [],
        {},
        [{ titleId: paldea, counted: -1 }],
        [{ titleId: paldea, counted: 10001 }],
        [{ titleId: paldea, counted: 1.5 }],
        [{ titleId: paldea, counted: "3" }],
        [{ titleId: "x", counted: 3 }],
        [{ counted: 3 }],
        [
          { titleId: paldea, counted: 1 },
          { titleId: paldea, counted: 2 },
        ],
        Array.from({ length: 501 }, () => ({ titleId: randomUUID(), counted: 1 })),
      ]) {
        expect(await call(lines), JSON.stringify(lines).slice(0, 80)).toMatchObject({
          ok: false,
          code: "22023",
        });
      }
      expect({ events: await eventCount(), counts: await countRows() }).toEqual(before);
    });
  });

  describe("behörighet", () => {
    it("ägare, admin och delägaren med Enkel vy får inventera", async () => {
      let n = 20;
      for (const person of [owner, admin, partner]) {
        n += 1;
        const v = await viewerFor(person, orgId);
        const res = await saveStockCountFor(v, {
          clientId: randomUUID(),
          placeId: hemma,
          lines: [{ titleId: prismatic, counted: n }],
        });
        expect(res.duplicate).toBe(false);
        expect(await level(hemma, prismatic)).toBe(n);
        const who = await one<{ counted_by: string }>(
          db(),
          sql`select counted_by::text as counted_by from public.stock_counts
              where id = ${res.countId}::uuid`,
        );
        expect(who.counted_by).toBe(person.id);
      }
      const p = await viewerFor(partner, orgId);
      expect(p.organization.viewMode).toBe("simple");
      expect(p.organization.role).toBe("owner");
      expect((await loadStockCountFor(p)).canEdit).toBe(true);
    });

    it("läsaren och påfyllaren nekas, och inget ändras", async () => {
      const before = { events: await eventCount(), counts: await countRows() };
      for (const person of [viewer, refiller]) {
        await expect(
          saveStockCountFor(await viewerFor(person, orgId), {
            clientId: randomUUID(),
            placeId: hemma,
            lines: [{ titleId: prismatic, counted: 99 }],
          }),
        ).rejects.toThrow(AuthorizationError);
        // Direkt mot databasen, förbi appens rollkontroll.
        const direct = await asUser(person, (tx) =>
          attempt(tx, (sp) =>
            sp.execute(
              sql`select * from public.save_stock_count(${orgId}::uuid, gen_random_uuid(),
                    ${hemma}::uuid, ${JSON.stringify([{ titleId: prismatic, counted: 99 }])}::jsonb)`,
            ),
          ),
        );
        expect(direct).toMatchObject({ ok: false, code: "42501" });
      }
      expect(await level(hemma, prismatic)).toBe(23);
      expect({ events: await eventCount(), counts: await countRows() }).toEqual(before);
      // Läsaren ser sidan men får inte spara.
      const view = await loadStockCountFor(await viewerFor(viewer, orgId));
      expect(view.canEdit).toBe(false);
      expect(view.places.map((p) => p.name)).toEqual(["Hemma", "Kontoret"]);
      // Påfyllaren har inte sidan alls.
      await expect(loadStockCountFor(await viewerFor(refiller, orgId))).rejects.toThrow(
        AuthorizationError,
      );
    });

    it("ingen skriver i stock_counts direkt, och ingen ändrar eller tar bort en inventering", async () => {
      for (const person of [owner, admin, viewer, refiller]) {
        const insert = await asUser(person, (tx) =>
          attempt(tx, (sp) =>
            sp.execute(
              sql`insert into public.stock_counts
                    (organization_id, client_id, location_id, line_count, changed_count, lines)
                  values (${orgId}::uuid, gen_random_uuid(), ${hemma}::uuid, 1, 0, '[]'::jsonb)`,
            ),
          ),
        );
        expect(insert).toMatchObject({ ok: false, code: "42501" });
        for (const change of [
          sql`update public.stock_counts set changed_count = 0 where organization_id = ${orgId}::uuid`,
          sql`delete from public.stock_counts where organization_id = ${orgId}::uuid`,
        ]) {
          expect(
            await asUser(person, (tx) => attempt(tx, (sp) => sp.execute(change))),
          ).toMatchObject({ ok: false, code: "42501" });
        }
      }
    });

    it("inventeringarna läses av ägare, admin och läsare, inte av påfyllaren eller andra organisationer", async () => {
      const seen = async (person: TestUser) =>
        (
          await asUser(person, (tx) =>
            one<{ n: number }>(tx, sql`select count(*)::int as n from public.stock_counts`),
          )
        ).n;
      const total = await countRows();
      expect(total).toBeGreaterThan(0);
      for (const person of [owner, admin, partner, viewer]) expect(await seen(person)).toBe(total);
      expect(await seen(refiller)).toBe(0);

      const stranger = await createUser();
      const otherOrg = await createOrg(stranger, "Annan organisation");
      expect(await seen(stranger)).toBe(0);
      // Ägaren i en annan organisation når inte det här lagret, varken i sin egen eller vår.
      const before = { events: await eventCount(), counts: await countRows() };
      for (const org of [orgId, otherOrg]) {
        const res = await asUser(stranger, (tx) =>
          attempt(tx, (sp) =>
            sp.execute(
              sql`select * from public.save_stock_count(${org}::uuid, gen_random_uuid(),
                    ${hemma}::uuid, ${JSON.stringify([{ titleId: prismatic, counted: 1 }])}::jsonb)`,
            ),
          ),
        );
        expect(res.ok).toBe(false);
      }
      expect({ events: await eventCount(), counts: await countRows() }).toEqual(before);
      expect(await level(hemma, prismatic)).toBe(23);
    });
  });

  describe("idempotens", () => {
    it("samma inskick två gånger sparas en gång och ger samma svar", async () => {
      const v = await viewerFor(owner, orgId);
      const input = {
        clientId: randomUUID(),
        placeId: hemma,
        lines: [
          { titleId: paldea, counted: 30 },
          { titleId: surging, counted: 38 },
        ],
      };
      const first = await saveStockCountFor(v, input);
      const before = { events: await eventCount(), counts: await countRows() };
      // Något händer mellan försöken (en leverans): det andra försöket får inte räkna om.
      await asUser(owner, (tx) =>
        tx.insert(s.stockEvents).values({
          organizationId: orgId,
          locationId: hemma,
          titleId: paldea,
          kind: "receipt",
          quantity: 10,
        }),
      );
      const second = await saveStockCountFor(v, input);
      expect(first.duplicate).toBe(false);
      expect(second.duplicate).toBe(true);
      expect(second.countId).toBe(first.countId);
      expect(second.lines).toEqual(first.lines);
      expect(second.countedAt).toBe(first.countedAt);
      expect(await level(hemma, paldea)).toBe(40);
      expect(await level(hemma, surging)).toBe(38);
      expect({ events: await eventCount(), counts: await countRows() }).toEqual({
        events: before.events + 1,
        counts: before.counts,
      });
    });

    it("två samtidiga inskick (dubbeltryck) ger en inventering", async () => {
      const v = await viewerFor(owner, orgId);
      const input = {
        clientId: randomUUID(),
        placeId: kontoret,
        lines: [
          { titleId: paldea, counted: 4 },
          { titleId: surging, counted: 6 },
          { titleId: prismatic, counted: 8 },
        ],
      };
      const before = { events: await eventCount(), counts: await countRows() };
      const results = await Promise.all([
        saveStockCountFor(v, input),
        saveStockCountFor(v, input),
        saveStockCountFor(v, input),
      ]);
      expect(results.map((r) => r.duplicate).sort()).toEqual([false, true, true]);
      expect(new Set(results.map((r) => r.countId)).size).toBe(1);
      expect({ events: await eventCount(), counts: await countRows() }).toEqual({
        events: before.events + 3,
        counts: before.counts + 1,
      });
      expect(await level(kontoret, surging)).toBe(6);
    });

    it("samma id från en annan person eller för ett annat lager nekas", async () => {
      const clientId = randomUUID();
      await saveStockCountFor(await viewerFor(owner, orgId), {
        clientId,
        placeId: hemma,
        lines: [{ titleId: surging, counted: 37 }],
      });
      const before = { events: await eventCount(), counts: await countRows() };
      await expect(
        saveStockCountFor(await viewerFor(admin, orgId), {
          clientId,
          placeId: hemma,
          lines: [{ titleId: surging, counted: 1 }],
        }),
      ).rejects.toThrow(new LagerError("Den här inventeringen är redan sparad. Ladda om sidan."));
      await expect(
        saveStockCountFor(await viewerFor(owner, orgId), {
          clientId,
          placeId: kontoret,
          lines: [{ titleId: surging, counted: 1 }],
        }),
      ).rejects.toThrow(LagerError);
      expect(await level(hemma, surging)).toBe(37);
      expect({ events: await eventCount(), counts: await countRows() }).toEqual(before);
    });
  });

  describe("senast inventerad och Att göra", () => {
    it("sidan visar när varje lager senast inventerades", async () => {
      const view = await loadStockCountFor(await viewerFor(owner, orgId));
      expect(view.hasWarehouse).toBe(true);
      expect(view.places.map((p) => [p.name, p.daysSince, p.overdue])).toEqual([
        ["Hemma", 0, false],
        ["Kontoret", 0, false],
      ]);
      expect(view.places.every((p) => p.lastCountedAt !== null)).toBe(true);
      // Arkiverade titlar räknas inte; det appen tror står per lager.
      expect(view.rows.map((r) => r.name)).toEqual([
        "Paldea Evolved",
        "Prismatic Evolutions",
        "Surging Sparks",
      ]);
      const p = view.rows.find((r) => r.titleId === paldea)!;
      expect(p.byPlace).toEqual({ [hemma]: 40, [kontoret]: 4 });
    });

    it("ett lager som aldrig inventerats: Inte inventerat än, och punkten kommer efter 30 dagar", async () => {
      const v = await viewerFor(owner, orgId);
      const garaget = (await createPlaceFor(v, { name: "Garaget" })).id;
      const place = async () => (await loadStockCountFor(v)).places.find((p) => p.id === garaget)!;
      expect(await place()).toMatchObject({ lastCountedAt: null, daysSince: null, overdue: false });
      const todoKeys = async (person: TestUser) =>
        (await loadTodoStateFor(await viewerFor(person, orgId))).items
          .filter((t) => t.kind === "stock-count")
          .map((t) => t.key);
      expect(await todoKeys(owner)).toEqual([]);

      // Lagret är 31 dagar gammalt och har aldrig inventerats.
      // (created_at skyddas av en trigger: stängs av bara för den här raden i testet.)
      await db().transaction(async (tx) => {
        await tx.execute(sql`set local session_replication_role = replica`);
        await tx.execute(
          sql`update public.stock_locations set created_at = now() - interval '31 days'
              where id = ${garaget}::uuid`,
        );
      });
      expect((await place()).overdue).toBe(true);
      expect(await todoKeys(owner)).toEqual([`stock-count:${garaget}`]);
      expect(await todoKeys(admin)).toEqual([`stock-count:${garaget}`]);
      const item = (await loadTodoStateFor(v)).items.find((t) => t.kind === "stock-count")!;
      expect(item).toMatchObject({
        title: "Inventera Garaget",
        level: "later",
        link: `/vart-lager/inventering?lager=${garaget}`,
      });
      // Påfyllaren och läsaren får ingen sådan punkt.
      expect(await todoKeys(refiller)).toEqual([]);
      expect(await todoKeys(viewer)).toEqual([]);

      // Efter en inventering är punkten borta.
      await saveStockCountFor(v, {
        clientId: randomUUID(),
        placeId: garaget,
        lines: [{ titleId: paldea, counted: 0 }],
      });
      expect(await todoKeys(owner)).toEqual([]);
      expect(await place()).toMatchObject({ daysSince: 0, overdue: false });
    });
  });
});
