/**
 * Styrning via Awishs gRPC-API v1.2.41 (src/server/awish/control) mot testdatabasen och
 * låtsas-Awish på 127.0.0.1:
 *
 *  - skyddet: bara ägare och admin, demo anropar aldrig Awish, samma bekräftelse en gång,
 *    gränser, pausat när signeringen inte fungerar eller versionen inte är kvitterad,
 *  - loggen: utan sign, timestamp och personuppgifter; påfyllaren ser den inte; en demo
 *    kan bara spara 'blocked',
 *  - Version: byte ger larm och kräver kvittering,
 *  - Testa signering: hittar full_sorted, eller pausar när inget fungerar,
 *  - påfyllning via API:t (plan B) och valet webb/API.
 *
 * Testet når aldrig riktiga Awish.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import type { Viewer } from "../../src/server/data/core/loaders";

import {
  asPostgres,
  asUser,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  rows,
  type TestUser,
} from "./helpers";

vi.mock("server-only", () => ({}));

const { saveAwishCredentialsFor } = await import("../../src/server/awish/manage");
const { startFakeAwish } = await import("../../src/server/awish/testing/fake-server");
const { runControlAction, recentActionsFor, newIdempotencyKey } =
  await import("../../src/server/awish/control/guard");
const {
  checkAwishVersion,
  acknowledgeAwishVersion,
  probeSigning,
  setAwishWritesVia,
  awishApiCardFor,
} = await import("../../src/server/awish/control/version");
const { pushMachinesViaApi } = await import("../../src/server/awish/control/api-push");
const { refillPushVia } = await import("../../src/server/awish/control/refill-push");
const { slotWriterFor } = await import("../../src/server/awish/control/slot-writer");
const { updateApiState } = await import("../../src/server/awish/control/state");

type Fake = Awaited<ReturnType<typeof startFakeAwish>>;
let fake: Fake;

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

const deps = () => ({ env: { AWISH_CONTROL_ENDPOINT: "plain", AWISH_GRPC_ADDRESS: fake.address } });

interface Org {
  owner: TestUser;
  orgId: string;
  sourceId: string;
  machineId: string;
  offlineMachineId: string;
  viewer: Viewer;
}

/** En ny organisation med Awish-nycklarna och två kopplade automater (7 online, 8 offline). */
async function freshOrg(): Promise<Org> {
  const owner = await createUser();
  const orgId = await createOrg(owner);
  const machines = await asUser(owner, (tx) =>
    tx
      .insert(s.machines)
      .values([
        { organizationId: orgId, code: "BL-001", name: "Sega gubben", activeFrom: "2026-10-01" },
        { organizationId: orgId, code: "BL-002", name: "Bortre", activeFrom: "2026-10-01" },
      ])
      .returning(),
  );
  const viewer = await viewerFor(owner, orgId);
  const { dataSourceId: sourceId } = await saveAwishCredentialsFor(viewer, {
    appId: fake.state.appId,
    appSecret: fake.state.appSecret,
    appKey: fake.state.appKey,
  });
  for (const [ext, m] of [
    ["7", machines[0]!],
    ["8", machines[1]!],
  ] as const) {
    await db().execute(sql`
      insert into public.source_machines (organization_id, data_source_id, external_id, external_name, machine_id)
      values (${orgId}::uuid, ${sourceId}::uuid, ${ext}, ${m.name}, ${m.id}::uuid)
      on conflict (organization_id, data_source_id, external_id) do update set machine_id = ${m.id}::uuid`);
  }
  return {
    owner,
    orgId,
    sourceId,
    machineId: machines[0]!.id,
    offlineMachineId: machines[1]!.id,
    viewer,
  };
}

const reboot = (o: Org, machineId = o.machineId, key = newIdempotencyKey()) =>
  runControlAction(
    o.viewer,
    { kind: "reboot", machineId, idempotencyKey: key, auditRequest: { method: "REBOOT" } },
    (api, ctx) => api.controlPower({ machineId: ctx.awishMachineId!, method: "REBOOT" }),
    deps(),
  );

beforeAll(async () => {
  fake = await startFakeAwish({
    machines: [
      { id: "7", name: "Sega gubben", machine_no: "M7" },
      { id: "8", name: "Bortre", machine_no: "M8", is_online: false },
    ],
    products: {
      "7": [
        { id: "71", channel: "A1", good: "30th Celebration", current: 2, capacity: 10 },
        { id: "72", channel: "A2", good: "Surging Sparks", current: 9, capacity: 10 },
      ],
    },
  });
});

afterAll(async () => {
  await fake.stop();
});

describe("skyddet runt skrivningarna", () => {
  let o: Org;
  beforeAll(async () => {
    o = await freshOrg();
  });

  it("ägaren startar om; loggen får raden med Awishs svar, utan sign och timestamp", async () => {
    const r = await reboot(o);
    expect(r.ok, r.message).toBe(true);
    expect(fake.state.powerCommands.at(-1)).toEqual({ machine_id: "7", method: "REBOOT" });
    const row = await one<{
      status: string;
      request: Record<string, unknown>;
      awish_code: number;
      actor_id: string;
    }>(
      db(),
      sql`select status, request, awish_code, actor_id from public.awish_actions
          where organization_id = ${o.orgId}::uuid and kind = 'reboot' and status = 'ok'`,
    );
    expect(row.status).toBe("ok");
    expect(row.awish_code).toBe(200);
    expect(row.actor_id).toBe(o.owner.id);
    expect(JSON.stringify(row.request)).not.toMatch(/sign|timestamp/);
  });

  it("samma bekräftelse skickas inte två gånger", async () => {
    const other = await freshOrg();
    const key = newIdempotencyKey();
    const before = fake.state.powerCommands.length;
    const first = await reboot(other, other.machineId, key);
    const second = await reboot(other, other.machineId, key);
    expect(first.ok && !first.replayed).toBe(true);
    expect(second.ok && second.replayed).toBe(true);
    expect(fake.state.powerCommands.length).toBe(before + 1);
  });

  it("andra omstarten inom tio minuter stoppas (gräns per automat)", async () => {
    const before = fake.state.powerCommands.length;
    const r = await reboot(o);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.kind).toBe("rate_limited");
    expect(fake.state.powerCommands.length).toBe(before);
  });

  it("påfyllare, läsare och admin utan rätt roll nekas; admin får", async () => {
    for (const role of ["refiller", "viewer"] as const) {
      const u = await createMember(o.orgId, role);
      const r = await reboot({ ...o, viewer: await viewerFor(u, o.orgId) }, o.offlineMachineId);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.kind).toBe("forbidden");
    }
    const admin = await createMember(o.orgId, "admin");
    const r = await runControlAction(
      await viewerFor(admin, o.orgId),
      {
        kind: "machine_config",
        machineId: o.machineId,
        idempotencyKey: newIdempotencyKey(),
        auditRequest: {},
      },
      (api, ctx) =>
        api.updateMachineConfig({ machineId: ctx.awishMachineId!, carouselAdsEnabled: true }),
      deps(),
    );
    expect(r.ok, r.message).toBe(true);
  });

  it("mata ut kräver skäl och att automaten är online", async () => {
    const shipment = (machineId: string, reason: string | null) =>
      runControlAction(
        o.viewer,
        {
          kind: "shipment",
          machineId,
          idempotencyKey: newIdempotencyKey(),
          reason,
          auditRequest: {},
        },
        (api, ctx) =>
          api.executeShipment({ machineId: ctx.awishMachineId!, addr: "1", motorIds: ["1"] }),
        deps(),
      );
    const noReason = await shipment(o.machineId, "kort");
    expect(!noReason.ok && noReason.kind).toBe("invalid");
    const offline = await shipment(o.offlineMachineId, "Test av motorn");
    expect(!offline.ok && offline.kind).toBe("offline");
    const before = fake.state.shipments.length;
    const ok = await shipment(o.machineId, "Test av motorn");
    expect(ok.ok, ok.message).toBe(true);
    const again = await shipment(o.machineId, "Test av motorn igen");
    expect(!again.ok && again.kind).toBe("rate_limited");
    expect(fake.state.shipments.length).toBe(before + 1);
  });

  it("ett obekräftat versionsbyte pausar mata ut och stäng av, men inte omstart", async () => {
    const other = await freshOrg();
    fake.state.version = "1.2.42";
    try {
      const check = await checkAwishVersion(db(), other.orgId, deps());
      expect(check.changed).toBe(true);
      const alert = await one<{ n: number }>(
        db(),
        sql`select count(*)::int as n from public.alerts where organization_id = ${other.orgId}::uuid
            and incident_key = 'awish_version:1.2.42' and status = 'open'`,
      );
      expect(alert.n).toBe(1);
      const shutdown = await runControlAction(
        other.viewer,
        {
          kind: "shutdown",
          machineId: other.machineId,
          idempotencyKey: newIdempotencyKey(),
          auditRequest: {},
        },
        (api, ctx) => api.controlPower({ machineId: ctx.awishMachineId!, method: "SHUTDOWN" }),
        deps(),
      );
      expect(!shutdown.ok && shutdown.kind).toBe("version_unacknowledged");
      expect((await reboot(other)).ok).toBe(true);
      expect((await awishApiCardFor(other.viewer)).versionNeedsAck).toBe(true);
      const ack = await acknowledgeAwishVersion(other.viewer);
      expect(ack.ok).toBe(true);
      expect((await awishApiCardFor(other.viewer)).versionNeedsAck).toBe(false);
      // Samma version igen: inget nytt byte.
      expect((await checkAwishVersion(db(), other.orgId, deps())).changed).toBe(false);
    } finally {
      fake.state.version = "1.2.41";
    }
  });

  it("AWISH_CONTROL_DISABLED stänger av allt", async () => {
    const r = await runControlAction(
      o.viewer,
      { kind: "category_create", idempotencyKey: newIdempotencyKey(), auditRequest: {} },
      (api) => api.createCategory({ title: "X" }),
      { env: { ...deps().env, AWISH_CONTROL_DISABLED: "true" } },
    );
    expect(!r.ok && r.kind).toBe("disabled");
  });

  it("medlemmar: namn, telefon och e-post sparas aldrig i loggen", async () => {
    const r = await runControlAction(
      o.viewer,
      {
        kind: "member_create",
        idempotencyKey: newIdempotencyKey(),
        auditRequest: {
          name: "Anna Andersson",
          tel: "0701234567",
          email: "a@b.se",
          fields: ["name", "tel"],
        },
      },
      (api) =>
        api.batchCreateMembers([{ name: "Anna Andersson", tel: "0701234567", email: "a@b.se" }]),
      deps(),
    );
    expect(r.ok, r.message).toBe(true);
    const row = await one<{ request: unknown }>(
      db(),
      sql`select request from public.awish_actions where id = ${r.actionId}::uuid`,
    );
    const text = JSON.stringify(row.request);
    expect(text).not.toMatch(/Anna|0701234567|a@b\.se/);
    expect(text).toContain("fields");
  });

  it("påfyllaren och läsaren ser inte loggen eller API-läget (RLS); ägaren gör det", async () => {
    const refiller = await createMember(o.orgId, "refiller");
    const viewer = await createMember(o.orgId, "viewer");
    for (const u of [refiller, viewer]) {
      const [n] = await asUser(u, (tx) =>
        rows<{ a: number; s: number }>(
          tx,
          sql`select (select count(*)::int from public.awish_actions where organization_id = ${o.orgId}::uuid) as a,
                     (select count(*)::int from public.awish_api_state where organization_id = ${o.orgId}::uuid) as s`,
        ),
      );
      expect(n).toEqual({ a: 0, s: 0 });
    }
    const [own] = await asUser(o.owner, (tx) =>
      rows<{ a: number }>(
        tx,
        sql`select count(*)::int as a from public.awish_actions where organization_id = ${o.orgId}::uuid`,
      ),
    );
    expect(own!.a).toBeGreaterThan(0);
    const recent = await recentActionsFor(o.viewer, { machineId: o.machineId, limit: 5 });
    expect(recent.length).toBeGreaterThan(0);
    await expect(recentActionsFor(await viewerFor(refiller, o.orgId), {})).rejects.toBeTruthy();
  });

  it("en loggrad får bara sitt utfall en gång och tas aldrig bort", async () => {
    const [row] = await rows<{ id: string }>(
      db(),
      sql`select id from public.awish_actions where organization_id = ${o.orgId}::uuid and status = 'ok' limit 1`,
    );
    await expect(
      asPostgres((tx) =>
        tx.execute(
          sql`update public.awish_actions set status = 'failed' where id = ${row!.id}::uuid`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      asPostgres((tx) =>
        tx.execute(sql`delete from public.awish_actions where id = ${row!.id}::uuid`),
      ),
    ).rejects.toThrow();
  });
});

describe("demo", () => {
  it("anropar aldrig Awish och sparar bara 'blocked'", async () => {
    const o = await freshOrg();
    await asPostgres((tx) =>
      tx.execute(sql`update public.organizations set is_demo = true where id = ${o.orgId}::uuid`),
    );
    const calls = fake.state.calls.length;
    const r = await reboot(o);
    expect(!r.ok && r.kind).toBe("demo");
    expect(fake.state.calls.length).toBe(calls);
    const blocked = await one<{ status: string }>(
      db(),
      sql`select status from public.awish_actions where id = ${r.actionId}::uuid`,
    );
    expect(blocked.status).toBe("blocked");
    const demoInsert = await asPostgres((tx) =>
      tx.execute(sql`insert into public.awish_actions (organization_id, kind, idempotency_key, status)
                       values (${o.orgId}::uuid, 'reboot', ${randomUUID()}, 'ok')`),
    ).catch((e: unknown) => e);
    expect(String((demoInsert as { cause?: Error }).cause?.message)).toMatch(/demo/);
    expect((await probeSigning(o.viewer, deps())).ok).toBe(false);
    expect(fake.state.calls.length).toBe(calls);
  });
});

describe("Testa signering", () => {
  it("hittar full_sorted när servern bygger hela kroppen", async () => {
    const o = await freshOrg();
    fake.state.signMode = "full_sorted";
    try {
      const r = await probeSigning(o.viewer, deps());
      expect(r.ok, r.message).toBe(true);
      expect(r.mode).toBe("full_sorted");
      const card = await awishApiCardFor(o.viewer);
      expect(card.state?.signStatus).toBe("ok");
      expect(card.state?.signMode).toBe("full_sorted");
      // Nästa skrivning använder det sparade läget.
      const w = await runControlAction(
        o.viewer,
        {
          kind: "slot_update",
          machineId: o.machineId,
          idempotencyKey: newIdempotencyKey(),
          auditRequest: {},
        },
        (api) => api.updateProduct({ id: "71", status: true }),
        deps(),
      );
      expect(w.ok, w.message).toBe(true);
    } finally {
      fake.state.signMode = "present_sorted";
    }
  });

  it("inget läge fungerar: skrivningar via API pausas", async () => {
    const o = await freshOrg();
    fake.state.signKeyOverride = "en-annan-nyckel";
    try {
      const r = await probeSigning(o.viewer, deps());
      expect(r.ok).toBe(false);
      const card = await awishApiCardFor(o.viewer);
      expect(card.state?.signStatus).toBe("failed");
      const calls = fake.state.calls.length;
      const blocked = await runControlAction(
        o.viewer,
        { kind: "category_create", idempotencyKey: newIdempotencyKey(), auditRequest: {} },
        (api) => api.createCategory({ title: "X" }),
        deps(),
      );
      expect(!blocked.ok && blocked.kind).toBe("sign_failed");
      expect(fake.state.calls.length).toBe(calls);
    } finally {
      fake.state.signKeyOverride = null;
    }
  });

  it("ett signaturfel i en vanlig skrivning pausar också", async () => {
    const o = await freshOrg();
    fake.state.signKeyOverride = "en-annan-nyckel";
    try {
      const r = await runControlAction(
        o.viewer,
        { kind: "category_create", idempotencyKey: newIdempotencyKey(), auditRequest: {} },
        (api) => api.createCategory({ title: "X" }),
        deps(),
      );
      expect(!r.ok && r.kind).toBe("sign_failed");
      expect((await awishApiCardFor(o.viewer)).state?.signStatus).toBe("failed");
    } finally {
      fake.state.signKeyOverride = null;
    }
  });
});

describe("påfyllning via API:t (plan B)", () => {
  let o: Org;
  let locationId: string;
  beforeAll(async () => {
    o = await freshOrg();
    locationId = (
      await one<{ id: string }>(
        db(),
        sql`select id from public.stock_locations where machine_id = ${o.machineId}::uuid`,
      )
    ).id;
    await asPostgres(async (tx) => {
      const [t] = Array.from(
        await tx.execute(
          sql`insert into public.titles (organization_id, name) values (${o.orgId}::uuid, '30th Celebration') returning id`,
        ),
      ) as Array<{ id: string }>;
      await tx.execute(sql`
        insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at, note)
        values (${o.orgId}::uuid, ${locationId}::uuid, ${t!.id}::uuid, 'count', 6, now(), 'test')`);
    });
  });

  it("valet är webbpanelen tills signeringen fungerar", async () => {
    expect(await refillPushVia(o.orgId)).toBe("web");
    expect((await setAwishWritesVia(o.viewer, { slot: "api" })).ok).toBe(true);
    expect(await refillPushVia(o.orgId)).toBe("web");
    expect((await pushMachinesViaApi(o.orgId, [o.machineId], deps())).status).toBe("off");
    await updateApiState(db(), o.orgId, o.sourceId, { signStatus: "ok", endpoint: "plain" });
    expect(await refillPushVia(o.orgId)).toBe("api");
  });

  it("höjer facket till Binderlabs antal via UpdateProduct och loggar", async () => {
    fake.state.products["7"]![0]!.current = 2;
    const r = await pushMachinesViaApi(o.orgId, [o.machineId], deps());
    expect(r.status).toBe("done");
    expect(r.machines[0]).toMatchObject({ status: "pushed", slotsUpdated: 1 });
    expect(fake.state.products["7"]![0]!.current).toBe(6);
    const log = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.awish_actions
          where organization_id = ${o.orgId}::uuid and kind = 'refill_push_api' and status = 'ok'`,
    );
    expect(log.n).toBe(1);
    // Awish har redan fler: inget sänks.
    fake.state.products["7"]![0]!.current = 8;
    const again = await pushMachinesViaApi(o.orgId, [o.machineId], deps());
    expect(again.machines[0]!.status).toBe("nothing");
    expect(fake.state.products["7"]![0]!.current).toBe(8);
  });

  it("fackskrivaren använder API:t när det är valt och signeringen fungerar", async () => {
    const writer = await slotWriterFor(db(), o.orgId, deps());
    expect(writer.via).toBe("api");
    const slots = await writer.slots("7");
    expect(slots.map((x) => x.id)).toEqual([71, 72]);
    await writer.setSlot(72, { goodId: null, status: true, currentInventory: 10 });
    expect(fake.state.products["7"]![1]!.current).toBe(10);
    writer.close();
  });
});
