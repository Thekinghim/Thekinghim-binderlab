/**
 * Storage: privata buckets imports och reports. Sökvägen börjar med
 * organization_id och policyerna kontrollerar rollen mot den.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  asUser,
  attempt,
  createMember,
  db,
  one,
  rows,
  seedTenantFixture,
  type TenantFixture,
  type TestUser,
} from "./helpers";

let A: TenantFixture;
let B: TenantFixture;
let refiller: TestUser;
let viewer: TestUser;

beforeAll(async () => {
  A = await seedTenantFixture();
  B = await seedTenantFixture();
  refiller = await createMember(A.orgId, "refiller");
  viewer = await createMember(A.orgId, "viewer");
});

function upload(user: TestUser, bucket: string, name: string) {
  return asUser(user, (tx) =>
    attempt(tx, (sp) =>
      sp.execute(sql`insert into storage.objects (bucket_id, name, owner) values (${bucket}, ${name}, ${user.id})`),
    ),
  );
}

function visible(user: TestUser, bucket: string, prefix: string) {
  return asUser(user, (tx) =>
    one<{ n: number }>(
      tx,
      sql`select count(*)::int as n from storage.objects where bucket_id = ${bucket} and name like ${`${prefix}/%`}`,
    ),
  );
}

describe("storage", () => {
  it("bucketarna finns och är privata", async () => {
    const buckets = await rows<{ id: string; public: boolean }>(
      db(),
      sql`select id, public from storage.buckets where id in ('imports', 'reports') order by id`,
    );
    expect(buckets).toEqual([
      { id: "imports", public: false },
      { id: "reports", public: false },
    ]);
  });

  it.each(["imports", "reports"])("%s: ägaren laddar upp i sin egen mapp, läsaren kan läsa", async (bucket) => {
    const name = `${A.orgId}/${randomUUID()}.pdf`;
    expect((await upload(A.owner, bucket, name)).ok).toBe(true);
    expect((await visible(A.owner, bucket, A.orgId)).n).toBeGreaterThan(0);
    expect((await visible(viewer, bucket, A.orgId)).n).toBeGreaterThan(0);
  });

  it.each(["imports", "reports"])("%s: påfyllaren har ingen åtkomst", async (bucket) => {
    await upload(A.owner, bucket, `${A.orgId}/${randomUUID()}.csv`);
    expect((await visible(refiller, bucket, A.orgId)).n).toBe(0);
    expect((await upload(refiller, bucket, `${A.orgId}/${randomUUID()}.csv`)).code).toBe("42501");
  });

  it.each(["imports", "reports"])("%s: läsaren kan inte ladda upp", async (bucket) => {
    expect((await upload(viewer, bucket, `${A.orgId}/${randomUUID()}.csv`)).code).toBe("42501");
  });

  it.each(["imports", "reports"])("%s: ingen åtkomst till en annan organisations mapp", async (bucket) => {
    await upload(B.owner, bucket, `${B.orgId}/${randomUUID()}.csv`);
    expect((await visible(A.owner, bucket, B.orgId)).n).toBe(0);
    expect((await upload(A.owner, bucket, `${B.orgId}/${randomUUID()}.csv`)).code).toBe("42501");
    // Sökvägar som inte börjar med ett uuid nekas också.
    expect((await upload(A.owner, bucket, `inte-ett-uuid/${randomUUID()}.csv`)).code).toBe("42501");
    expect((await upload(A.owner, bucket, `${randomUUID()}.csv`)).code).toBe("42501");
  });

  it("filer kan inte skrivas över eller raderas av klienter", async () => {
    const name = `${A.orgId}/${randomUUID()}.csv`;
    await upload(A.owner, "imports", name);
    const changed = await asUser(A.owner, (tx) =>
      tx.execute(sql`update storage.objects set name = name where name = ${name}`),
    );
    expect((changed as unknown as { count: number }).count).toBe(0);
    const removed = await asUser(A.owner, (tx) => tx.execute(sql`delete from storage.objects where name = ${name}`));
    expect((removed as unknown as { count: number }).count).toBe(0);
  });
});
