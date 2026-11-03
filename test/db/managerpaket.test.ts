/**
 * Managerpaket 1–3 mot testdatabasen (20261104170000_managerpaket_ansvar.sql): ansvarig per
 * automat, tilldelning i Att göra (src/server/team/service.ts) och butikens plats, per roll.
 */

import { eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { updateStoreFor } from "@/app/(app)/butiker/_lib/service";
import * as s from "@/db/schema";
import { listOrganizationsFor, type SessionUser } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import { loadTeamStateFor, queryStorePlaces } from "@/server/data/team";
import { assignTodoFor, setMachineResponsibleFor } from "@/server/team/service";

import {
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

function sessionUser(u: TestUser): SessionUser {
  return { userId: u.id, email: u.email };
}

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = sessionUser(u);
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let orgId: string;
let owner: TestUser;
let coOwner: TestUser;
let refiller: TestUser;
let viewer: TestUser;
let outsider: TestUser;
let machineId: string;
let storeId: string;
let titleId: string;

beforeAll(async () => {
  owner = await createUser(`mgr-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(owner, `Managerpaket ${uniqueSuffix()}`);
  coOwner = await createMember(orgId, "admin");
  refiller = await createMember(orgId, "refiller");
  viewer = await createMember(orgId, "viewer");
  outsider = await createUser(`ute-${uniqueSuffix()}@test.binderlab.se`);
  await asUser(owner, async (tx) => {
    const org = { organizationId: orgId };
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: "ICA Lund", address: "Storgatan 1", city: "Lund" })
      .returning();
    const [machine] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-001", name: "Automat 1", activeFrom: "2025-01-01" })
      .returning();
    const [title] = await tx
      .insert(s.titles)
      .values({ ...org, name: "Pokémon 151 Booster" })
      .returning();
    storeId = store!.id;
    machineId = machine!.id;
    titleId = title!.id;
  });
});

describe("ansvarig per automat", () => {
  it("är Båda (null) från början", async () => {
    const [m] = await rows<{ r: string | null }>(
      db(),
      sql`select responsible_user_id as r from public.machines where id = ${machineId}`,
    );
    expect(m!.r).toBeNull();
  });

  it("ägaren sätter delägaren, sig själv och Båda", async () => {
    const v = await viewerFor(owner, orgId);
    expect(await setMachineResponsibleFor(v, { machineId, userId: coOwner.id })).toEqual({
      ok: true,
      data: { userId: coOwner.id },
    });
    let team = await loadTeamStateFor(sessionUser(owner), orgId);
    expect(team.responsibles.get(machineId)).toBe(coOwner.id);
    // Personerna som fyller på: ägaren, delägaren och påfyllaren, inte läsaren.
    expect(team.team.map((t) => t.userId).sort()).toEqual(
      [owner.id, coOwner.id, refiller.id].sort(),
    );
    await setMachineResponsibleFor(v, { machineId, userId: owner.id });
    await setMachineResponsibleFor(v, { machineId, userId: "" });
    team = await loadTeamStateFor(sessionUser(owner), orgId);
    expect(team.responsibles.get(machineId)).toBeNull();
  });

  it("läsaren och utomstående kan inte vara ansvariga (22023)", async () => {
    const v = await viewerFor(owner, orgId);
    const asViewer = await setMachineResponsibleFor(v, { machineId, userId: viewer.id });
    expect(asViewer.ok).toBe(false);
    expect(asViewer.ok ? "" : asViewer.error).toBe("Ansvarig måste vara medlem som fyller på.");
    const asOutsider = await setMachineResponsibleFor(v, { machineId, userId: outsider.id });
    expect(asOutsider.ok).toBe(false);
    // Direkt i databasen: triggern stoppar även utan servern.
    const direct = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.machines set responsible_user_id = ${outsider.id} where id = ${machineId}`,
        ),
      ),
    );
    expect(direct.ok).toBe(false);
    expect(direct.code).toBe("22023");
  });

  it("påfyllaren och läsaren får inte ändra; okänd automat och ogiltig indata avvisas", async () => {
    const r = await setMachineResponsibleFor(await viewerFor(refiller, orgId), {
      machineId,
      userId: refiller.id,
    });
    expect(r.ok).toBe(false);
    const w = await setMachineResponsibleFor(await viewerFor(viewer, orgId), {
      machineId,
      userId: "",
    });
    expect(w.ok).toBe(false);
    const v = await viewerFor(owner, orgId);
    const gone = await setMachineResponsibleFor(v, {
      machineId: "00000000-0000-4000-8000-000000000000",
      userId: "",
    });
    expect(gone).toEqual({ ok: false, error: "Automaten finns inte." });
    expect((await setMachineResponsibleFor(v, { machineId, userId: "jag" })).ok).toBe(false);
  });
});

describe("tilldelning i Att göra", () => {
  const stockKey = () => `refill:${machineId}:${titleId}`;
  const priceKey = () => `missing-price:${titleId}`;

  it("ägaren tilldelar delägaren; vem och när sätts av databasen; samma punkt skriver över", async () => {
    const v = await viewerFor(owner, orgId);
    expect(await assignTodoFor(v, { key: priceKey(), userId: coOwner.id })).toEqual({
      ok: true,
      data: { userId: coOwner.id },
    });
    const [row] = await rows<{ to: string; by: string }>(
      db(),
      sql`select assigned_to as "to", assigned_by as "by" from public.todo_assignments
          where organization_id = ${orgId} and todo_key = ${priceKey()}`,
    );
    expect(row).toEqual({ to: coOwner.id, by: owner.id });
    await assignTodoFor(v, { key: priceKey(), userId: "" });
    const team = await loadTeamStateFor(sessionUser(owner), orgId);
    // Båda sparas uttryckligen (null), så att punkten inte faller tillbaka på automaten.
    expect(team.assignments.has(priceKey())).toBe(true);
    expect(team.assignments.get(priceKey())).toBeNull();
    const n = await rows<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.todo_assignments
          where organization_id = ${orgId} and todo_key = ${priceKey()}`,
    );
    expect(n[0]!.n).toBe(1);
  });

  it("påfyllaren tilldelar lagerpunkter men inte andra, och ser bara lagerpunkter", async () => {
    const r = await viewerFor(refiller, orgId);
    expect((await assignTodoFor(r, { key: stockKey(), userId: refiller.id })).ok).toBe(true);
    const denied = await assignTodoFor(r, { key: priceKey(), userId: refiller.id });
    expect(denied).toEqual({ ok: false, error: "Du har inte behörighet att ändra det här." });
    const seen = await loadTeamStateFor(sessionUser(refiller), orgId);
    expect([...seen.assignments.keys()]).toEqual([stockKey()]);
    // Påfyllaren ser bara sig själv bland personerna (RLS på profiler och medlemskap).
    expect(seen.team.map((t) => t.userId)).toEqual([refiller.id]);
  });

  it("läsaren får inte tilldela; den tilldelade måste fylla på; nyckeln kontrolleras", async () => {
    expect(
      (await assignTodoFor(await viewerFor(viewer, orgId), { key: stockKey(), userId: "" })).ok,
    ).toBe(false);
    const v = await viewerFor(owner, orgId);
    const toViewer = await assignTodoFor(v, { key: stockKey(), userId: viewer.id });
    expect(toViewer).toEqual({
      ok: false,
      error: "Punkten kan bara tilldelas en medlem som fyller på.",
    });
    expect((await assignTodoFor(v, { key: "inte en nyckel", userId: "" })).ok).toBe(false);
  });

  it("en annan organisation ser inte tilldelningarna", async () => {
    const other = await createUser(`annan-${uniqueSuffix()}@test.binderlab.se`);
    await createOrg(other, `Annan ${uniqueSuffix()}`);
    const seen = await asUser(other, (tx) =>
      rows(tx, sql`select 1 from public.todo_assignments where organization_id = ${orgId}`),
    );
    expect(seen).toEqual([]);
  });
});

describe("butikens plats", () => {
  it("kartlänken sparas som plats, utelämnad rörs inte, tom tar bort", async () => {
    const v = await viewerFor(owner, orgId);
    const base = { storeId, name: "ICA Lund", address: "Storgatan 1", city: "Lund" };
    expect(
      (
        await updateStoreFor(v, {
          ...base,
          location: "https://www.google.com/maps/@55.7,13.19,17z",
        })
      ).ok,
    ).toBe(true);
    const places = async () =>
      asUser(owner, (tx) => queryStorePlaces(tx, orgId)).then((m) => m.get(storeId));
    expect((await places())?.location).toEqual({ lat: 55.7, lng: 13.19 });
    await updateStoreFor(v, base);
    expect((await places())?.location).toEqual({ lat: 55.7, lng: 13.19 });
    await updateStoreFor(v, { ...base, location: "" });
    expect((await places())?.location).toBeNull();
    const bad = await updateStoreFor(v, { ...base, location: "Storgatan 1" });
    expect(bad.ok).toBe(false);
  });

  it("databasen kräver både latitud och longitud, inom gränserna", async () => {
    for (const set of [
      sql`latitude = 55.7, longitude = null`,
      sql`latitude = 95, longitude = 13`,
      sql`latitude = 55, longitude = 190`,
    ]) {
      const r = await asUser(owner, (tx) =>
        attempt(tx, (sp) => sp.execute(sql`update public.stores set ${set} where id = ${storeId}`)),
      );
      expect(r.ok).toBe(false);
      expect(r.code).toBe("23514");
    }
    // Påfyllaren läser platsen (rutten) men får inte ändra butiken.
    const seen = await asUser(refiller, (tx) => queryStorePlaces(tx, orgId));
    expect(seen.has(storeId)).toBe(true);
    const n = await asUser(refiller, (tx) =>
      tx
        .update(s.stores)
        .set({ latitude: 1, longitude: 1 })
        .where(eq(s.stores.id, storeId))
        .returning({ id: s.stores.id }),
    );
    expect(n).toEqual([]);
  });
});
