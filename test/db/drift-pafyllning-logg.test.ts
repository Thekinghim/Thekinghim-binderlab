/**
 * Drift → Påfyllning visar loggen över påfyllningar från Fyll på (det enda sättet att
 * registrera): loadRefillLogFor läser field_submissions som användaren med RLS.
 *
 * - ägare och läsare ser allas påfyllningar, med namnet på den som fyllde på,
 * - påfyllaren ser bara sina egna,
 * - ångrade påfyllningar (Ångra i Fyll på) syns inte,
 * - i dag räknas i organisationens tidszon (refillLogView).
 */

import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import type { Viewer } from "../../src/server/data/core/loaders";
import { syncRefillsFor, undoRefillsFor } from "../../src/server/data/field-refills";
import { loadRefillLogFor } from "../../src/app/(app)/drift/_lib/refill-log";
import { refillLogView } from "../../src/app/(app)/drift/_lib/refill-log-view";
import { businessToday } from "../../src/server/data/core/loaders";

import { asUser, createMember, createOrg, createUser, type TestUser } from "./helpers";

vi.mock("server-only", () => ({}));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, revalidateTag: () => {} }));

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

const TZ = "Europe/Stockholm";

describe("Drift → Påfyllning: loggen", () => {
  let owner: TestUser;
  let refiller: TestUser;
  let viewer: TestUser;
  let orgId: string;
  let machineId: string;
  let titleId: string;
  let undone: string;
  const today = businessToday(new Date(), TZ);

  const refill = (quantity: number) => ({
    clientId: randomUUID(),
    machineId,
    titleId,
    quantity,
    fromWarehouse: false,
    occurredAt: new Date().toISOString(),
  });
  const log = (u: TestUser) =>
    loadRefillLogFor({ userId: u.id, email: u.email }, { organizationId: orgId, today });

  beforeAll(async () => {
    owner = await createUser();
    orgId = await createOrg(owner);
    refiller = await createMember(orgId, "refiller");
    viewer = await createMember(orgId, "viewer");
    await asUser(owner, async (tx) => {
      const [m] = await tx
        .insert(s.machines)
        .values({
          organizationId: orgId,
          code: "BL-001",
          name: "Sega gubben",
          activeFrom: "2026-10-01",
        })
        .returning();
      const [t] = await tx
        .insert(s.titles)
        .values({ organizationId: orgId, name: "Mystery Pack" })
        .returning();
      machineId = m!.id;
      titleId = t!.id;
    });
    const rv = await viewerFor(refiller, orgId);
    const first = refill(12);
    const second = refill(3);
    undone = second.clientId;
    const saved = await syncRefillsFor(rv, [first, second]);
    expect(saved.results.map((r) => r.status)).toEqual(["saved", "saved"]);
    await undoRefillsFor(rv, [undone]);
    const own = await syncRefillsFor(await viewerFor(owner, orgId), [refill(5)]);
    expect(own.results[0]?.status).toBe("saved");
  });

  it("ägaren ser allas påfyllningar med namn, utan ångrade", async () => {
    const rows = await log(owner);
    expect(rows.map((r) => r.quantity).sort((a, b) => a - b)).toEqual([5, 12]);
    expect(rows.some((r) => r.clientId === undone)).toBe(false);
    const byRefiller = rows.find((r) => r.quantity === 12);
    expect(byRefiller?.by).toBe(refiller.email.split("@")[0]);
    expect(byRefiller?.machineCode).toBe("BL-001");
    expect(byRefiller?.titleName).toBe("Mystery Pack");
    const view = refillLogView(rows, today, TZ);
    expect(view.today.packs).toBe(17);
    expect(view.headline).toBe("17 pack påfyllda i dag.");
  });

  it("läsaren ser samma logg (bara läsning)", async () => {
    expect((await log(viewer)).map((r) => r.quantity).sort((a, b) => a - b)).toEqual([5, 12]);
  });

  it("påfyllaren ser bara sina egna", async () => {
    const rows = await log(refiller);
    expect(rows.map((r) => r.quantity)).toEqual([12]);
  });
});
