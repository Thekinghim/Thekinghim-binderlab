/**
 * Managerpaket 8 (push i mobilen) mot testdatabasen:
 * - larmtypen machine_discovered går att prenumerera på (private.alert_kinds_valid), men
 *   inte för påfyllaren (private.alert_kinds_are_field);
 * - "Notiser på/av" och typerna sparas i personens egen rad (saveNoticeChange, RLS);
 * - larmjobbet larmar "Ny automat hittad" för en okopplad Awish-automat till den som valt
 *   typen, inte till påfyllaren, och stänger larmet när automaten markerats "Inte vår".
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { evaluateOrganization } from "@/server/alerts/evaluate";
import { saveNoticeChange } from "@/server/alerts/notice-service";
import { listOrganizationsFor } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import { ignoreNewMachineFor } from "@/server/machines/new-machines";

import { asUser, attempt, createMember, db, rows, type TestUser } from "./helpers";
import { awishCsv, mapMachine, setupImportOrg, type ImportFixture } from "./import-fixtures";

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

async function ownRow(orgId: string, userId: string) {
  const [row] = await rows<{ kinds: string[] | null; channels: string[]; active: boolean }>(
    db(),
    sql`select kinds, channels, active from public.alert_subscriptions
        where organization_id = ${orgId}::uuid and user_id = ${userId}::uuid`,
  );
  return row ?? null;
}

let f: ImportFixture;
let refiller: TestUser;

beforeAll(async () => {
  f = await setupImportOrg();
  refiller = await createMember(f.orgId, "refiller");
  await mapMachine(f, "BL-001 ICA Lund", "BL-001");
  await f.run(
    awishCsv([
      { no: "1", machine: "BL-001 ICA Lund", time: "2026-10-20 12:00:00" },
      { no: "2", machine: "Nya hallen", time: "2026-10-21 12:00:00" },
      { no: "3", machine: "Nya hallen", time: "2026-10-21 13:00:00" },
    ]),
  );
}, 120_000);

describe("notiser: inställningar per person", () => {
  it("ägaren slår på: push och alla larm; av tar bort push men behåller e-post", async () => {
    const ctx = { orgId: f.orgId, userId: f.owner.id, role: "owner" };
    const on = await asUser(f.owner, (tx) => saveNoticeChange(tx, ctx, { on: true }));
    expect(on).toMatchObject({ ok: true, state: { on: true } });
    expect(await ownRow(f.orgId, f.owner.id)).toEqual({
      kinds: null,
      channels: ["push", "email"],
      active: true,
    });

    const off = await asUser(f.owner, (tx) => saveNoticeChange(tx, ctx, { on: false }));
    expect(off).toMatchObject({ ok: true, state: { on: false } });
    expect(await ownRow(f.orgId, f.owner.id)).toMatchObject({ channels: ["email"], active: true });

    await asUser(f.owner, (tx) => saveNoticeChange(tx, ctx, { on: true }));
    const typed = await asUser(f.owner, (tx) =>
      saveNoticeChange(tx, ctx, { types: ["discovered", "empty"] }),
    );
    expect(typed).toMatchObject({ ok: true, state: { types: ["empty", "discovered"] } });
    expect((await ownRow(f.orgId, f.owner.id))?.kinds).toEqual([
      "low_stock",
      "machine_discovered",
      "day_anomaly",
    ]);
  });

  it("påfyllaren får bara automater och lager, och kan inte välja Ny automat hittad", async () => {
    const ctx = { orgId: f.orgId, userId: refiller.id, role: "refiller" };
    await asUser(refiller, (tx) => saveNoticeChange(tx, ctx, { on: true }));
    const r = await asUser(refiller, (tx) =>
      saveNoticeChange(tx, ctx, { types: ["empty", "silent", "discovered"] }),
    );
    expect(r).toMatchObject({ ok: true, state: { on: true, types: ["empty", "silent"] } });
    const row = await ownRow(f.orgId, refiller.id);
    expect(row?.kinds).not.toContain("machine_discovered");

    // Direkt mot databasen: policyn stoppar typen för påfyllaren.
    const direct = await asUser(refiller, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.alert_subscriptions set kinds = array['machine_discovered']
              where organization_id = ${f.orgId}::uuid and user_id = ${refiller.id}::uuid`,
        ),
      ),
    );
    expect(direct.ok).toBe(false);
  });

  it("okända larmtyper avvisas av databasen", async () => {
    const out = await asUser(f.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.alert_subscriptions set kinds = array['machine_discovered', 'påhittad']
              where organization_id = ${f.orgId}::uuid and user_id = ${f.owner.id}::uuid`,
        ),
      ),
    );
    expect(out.ok).toBe(false);
  });

  it("en annan person ser och ändrar inte någon annans rad", async () => {
    const seen = await asUser(refiller, (tx) =>
      rows<{ user_id: string }>(
        tx,
        sql`select user_id from public.alert_subscriptions where organization_id = ${f.orgId}::uuid`,
      ),
    );
    expect(seen.map((r) => r.user_id)).toEqual([refiller.id]);
  });
});

describe("larmjobbet: ny automat hittad", () => {
  const NOW = new Date("2026-10-22T10:00:00Z");

  it("larmar ägaren (och inte påfyllaren) om den okopplade automaten", async () => {
    // Påfyllaren med alla sina typer; ägaren med Ny automat hittad vald (testet ovan).
    const summary = await evaluateOrganization(db(), f.orgId, NOW);
    expect(summary.status).toBe("ok");
    const alerts = await rows<{ kind: string; alert_group: string; status: string; title: string }>(
      db(),
      sql`select kind, alert_group, status, title from public.alerts
          where organization_id = ${f.orgId}::uuid and kind = 'machine_discovered'`,
    );
    expect(alerts).toEqual([
      {
        kind: "machine_discovered",
        alert_group: "import",
        status: "open",
        title: "Ny automat hittad: Nya hallen",
      },
    ]);
    const deliveries = await rows<{ user_id: string; items: { kind: string }[] }>(
      db(),
      sql`select user_id, items from public.alert_deliveries
          where organization_id = ${f.orgId}::uuid`,
    );
    const kindsFor = (id: string) =>
      deliveries.filter((d) => d.user_id === id).flatMap((d) => d.items.map((i) => i.kind));
    expect(kindsFor(f.owner.id)).toContain("machine_discovered");
    expect(kindsFor(refiller.id)).not.toContain("machine_discovered");

    // Samma körning igen: ingen ny avisering.
    await evaluateOrganization(db(), f.orgId, new Date(NOW.getTime() + 10 * 60_000));
    const again = await rows<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.alert_deliveries
          where organization_id = ${f.orgId}::uuid and user_id = ${f.owner.id}::uuid
            and items @> '[{"kind":"machine_discovered"}]'::jsonb`,
    );
    expect(again[0]?.n).toBe(1);
  });

  it('"Inte vår" stänger larmet', async () => {
    const owner = await viewerFor(f.owner, f.orgId);
    const [source] = await rows<{ id: string }>(
      db(),
      sql`select id from public.source_machines
          where organization_id = ${f.orgId}::uuid and machine_id is null`,
    );
    expect((await ignoreNewMachineFor(owner, { sourceMachineId: source!.id })).ok).toBe(true);
    await evaluateOrganization(db(), f.orgId, new Date(NOW.getTime() + 60 * 60_000));
    const [alert] = await rows<{ status: string }>(
      db(),
      sql`select status from public.alerts
          where organization_id = ${f.orgId}::uuid and kind = 'machine_discovered'`,
    );
    expect(alert?.status).toBe("closed");
  });
});
