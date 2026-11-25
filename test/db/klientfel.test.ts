/**
 * Klientfel (20261231000200_klientfel.sql): telefonens eget fel sparas i
 * private.client_errors via public.report_client_error.
 *
 * - En inloggad person kan rapportera (via serverkoden och direkt), anon kan inte.
 * - Ingen klientroll kan läsa eller skriva tabellen direkt.
 * - Databasen kortar fälten, tar bort frågesträngar och e-post och sparar organisationen
 *   bara för den som är medlem.
 * - Högst 30 rader per person och timme; rader äldre än 30 dagar gallras.
 */

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { saveClientErrorFor } from "@/server/client-errors/report";

import {
  asAnon,
  asPostgres,
  asServiceRole,
  asUser,
  attempt,
  createOrg,
  createUser,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

interface Stored extends Record<string, unknown> {
  user_id: string;
  organization_id: string | null;
  path: string;
  message: string;
  stack: string;
  digest: string | null;
  build_id: string | null;
  user_agent: string | null;
  extra: Record<string, unknown>;
}

function storedFor(user: TestUser): Promise<Stored[]> {
  return asPostgres((tx) =>
    rows<Stored>(
      tx,
      sql`select user_id, organization_id, path, message, stack, digest, build_id, user_agent, extra
          from private.client_errors where user_id = ${user.id} order by id`,
    ),
  );
}

function report(user: TestUser, args: { path?: string; message?: string; stack?: string } = {}) {
  return asUser(user, (tx) =>
    tx.execute(
      sql`select public.report_client_error(
            ${args.path ?? "/"}, ${args.message ?? "Error: x"}, ${args.stack ?? ""},
            null, null, null, '{}'::jsonb, null)`,
    ),
  );
}

describe("klientfel", () => {
  it("den inloggade rapporterar via serverkoden; organisationen bara som medlem", async () => {
    const owner = await createUser(`klientfel-${uniqueSuffix()}@test.binderlab.se`);
    const org = await createOrg(owner, `Klientfel ${uniqueSuffix()}`);
    const other = await createUser(`klientfel-annan-${uniqueSuffix()}@test.binderlab.se`);
    const otherOrg = await createOrg(other, `Klientfel annan ${uniqueSuffix()}`);
    const session = { userId: owner.id, email: owner.email };
    const input = {
      path: "/?vmb=1",
      message: "TypeError: undefined is not an object (evaluating 'a.b')",
      stack: "render@https://x.se/_next/static/chunks/a.js?dpl=dpl_1:1:200",
      digest: null,
      buildId: "dpl_abc",
      userAgent: "Mozilla/5.0 (iPhone)",
      extra: { source: "boundary", online: true, standalone: true, visibility: "visible" },
    };
    expect(await saveClientErrorFor(session, org, input)).toBe(true);
    expect(await saveClientErrorFor(session, otherOrg, input)).toBe(true);
    expect(await saveClientErrorFor(session, "inte-ett-id", input)).toBe(true);
    // Ogiltigt (inget meddelande och ingen stack): skickas inte till databasen.
    expect(await saveClientErrorFor(session, org, { path: "/" })).toBe(false);

    const stored = await storedFor(owner);
    expect(stored).toHaveLength(3);
    expect(stored.map((r) => r.organization_id)).toEqual([org, null, null]);
    expect(stored[0]).toMatchObject({
      path: "/",
      message: input.message,
      stack: "render@https://x.se/_next/static/chunks/a.js",
      digest: null,
      build_id: "dpl_abc",
      user_agent: "Mozilla/5.0 (iPhone)",
      extra: { source: "boundary", online: true, standalone: true, visibility: "visible" },
    });
  });

  it("anon kan inte rapportera; ingen klientroll når tabellen direkt", async () => {
    const user = await createUser(`klientfel-rls-${uniqueSuffix()}@test.binderlab.se`);
    await report(user);

    const anon = await asAnon((tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`select public.report_client_error('/', 'x', '', null, null, null, '{}'::jsonb, null)`,
        ),
      ),
    );
    expect(anon).toMatchObject({ ok: false, code: "42501" });

    for (const run of [
      (fn: Parameters<typeof asAnon>[0]) => asAnon(fn),
      (fn: Parameters<typeof asAnon>[0]) => asUser(user, fn),
      (fn: Parameters<typeof asAnon>[0]) => asServiceRole(fn),
    ]) {
      const read = await run((tx) =>
        attempt(tx, (sp) => sp.execute(sql`select * from private.client_errors`)),
      );
      expect(read).toMatchObject({ ok: false, code: "42501" });
      const write = await run((tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`insert into private.client_errors (user_id, message) values (${user.id}, 'falskt')`,
          ),
        ),
      );
      expect(write).toMatchObject({ ok: false, code: "42501" });
      const remove = await run((tx) =>
        attempt(tx, (sp) => sp.execute(sql`delete from private.client_errors`)),
      );
      expect(remove).toMatchObject({ ok: false, code: "42501" });
    }
    expect(await storedFor(user)).toHaveLength(1);
  });

  it("databasen kortar fälten och tar bort frågesträngar och e-post", async () => {
    const user = await createUser(`klientfel-kort-${uniqueSuffix()}@test.binderlab.se`);
    const extraBig = JSON.stringify({ source: "boundary", junk: "x".repeat(2000) });
    await asUser(user, (tx) =>
      tx.execute(
        sql`select public.report_client_error(
              ${`/drift/${"a".repeat(400)}?token=hemligt#frag`},
              ${`fel för anna@example.se ${"m".repeat(600)}`},
              ${`at https://x.se/a.js?k=hemligt:1:2 ${"s".repeat(5000)}`},
              ${"d".repeat(200)}, ${"b".repeat(200)}, ${"u".repeat(400)},
              ${extraBig}::jsonb, null)`,
      ),
    );
    const [row] = await storedFor(user);
    expect(row?.path).toHaveLength(300);
    expect(row?.path.startsWith("/drift/")).toBe(true);
    expect(row?.message).toHaveLength(500);
    expect(row?.message.startsWith("fel för [e-post] ")).toBe(true);
    expect(row?.stack).toHaveLength(4000);
    expect(row?.stack.startsWith("at https://x.se/a.js s")).toBe(true);
    expect(row?.stack).not.toContain("hemligt");
    expect(row?.digest).toHaveLength(100);
    expect(row?.build_id).toHaveLength(80);
    expect(row?.user_agent).toHaveLength(300);
    // För stort extra sparas inte (tomt objekt i stället).
    expect(row?.extra).toEqual({});

    await asUser(user, (tx) =>
      tx.execute(
        sql`select public.report_client_error('/sok?q=hemligt', 'x', '', null, null, null, null, null)`,
      ),
    );
    expect((await storedFor(user))[1]?.path).toBe("/sok");
  });

  it("högst 30 rader per person och timme, fler släpps tyst; gamla rader gallras", async () => {
    const user = await createUser(`klientfel-grans-${uniqueSuffix()}@test.binderlab.se`);
    const other = await createUser(`klientfel-grans2-${uniqueSuffix()}@test.binderlab.se`);
    // En rad från förra timmen räknas inte mot gränsen; en från 31 dagar sedan gallras.
    await asPostgres((tx) =>
      tx.execute(
        sql`insert into private.client_errors (user_id, message, created_at) values
              (${user.id}, 'förra timmen', now() - interval '61 minutes'),
              (${user.id}, 'gammal', now() - interval '31 days')`,
      ),
    );
    for (let i = 0; i < 35; i += 1) await report(user, { message: `e${i}` });
    const stored = await storedFor(user);
    // 30 nya (e0–e29) och raden från förra timmen; e30–e34 släpptes tyst.
    expect(stored).toHaveLength(31);
    expect(stored.map((r) => r.message)).toContain("e29");
    expect(stored.map((r) => r.message)).not.toContain("e30");
    expect(stored.map((r) => r.message)).not.toContain("gammal");
    expect(stored.map((r) => r.message)).toContain("förra timmen");
    // Gränsen gäller per person.
    await report(other);
    expect(await storedFor(other)).toHaveLength(1);
  });
});
