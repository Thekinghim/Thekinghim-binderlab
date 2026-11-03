/**
 * Tyst titel: påfyllaren får bocka av 'silent-title:<automat>:<titel>' (lagerpunkt),
 * men fortfarande inte andra nycklar.
 */

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { asUser, attempt, createMember, createOrg, createUser, db, one } from "./helpers";

describe("tyst titel i todo_dismissals", () => {
  it("räknas som lagerpunkt", async () => {
    const r = await one<{ silent: boolean; stale: boolean; price: boolean }>(
      db(),
      sql`select private.todo_key_is_stock('silent-title:m:t') as silent,
                 private.todo_key_is_stock('stale-machine:m') as stale,
                 private.todo_key_is_stock('missing-price:t') as price`,
    );
    expect(r).toEqual({ silent: true, stale: true, price: false });
  });

  it("påfyllaren bockar av en tyst titel men inte en prispunkt", async () => {
    const owner = await createUser();
    const orgId = await createOrg(owner);
    const refiller = await createMember(orgId, "refiller");
    const insert = (key: string) =>
      asUser(refiller, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(sql`insert into public.todo_dismissals (organization_id, todo_key, fingerprint, dismissed_by)
                         values (${orgId}::uuid, ${key}, 'fp', ${refiller.id}::uuid)`),
        ),
      );
    expect((await insert("silent-title:m1:t1")).ok).toBe(true);
    expect((await insert("missing-price:t1")).ok).toBe(false);
  });
});
