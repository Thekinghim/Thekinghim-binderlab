/**
 * Styr automaten mot testdatabasen med en låtsas-Awish i minnet (aldrig riktiga Awish) och
 * en spärr som spelar in vad tjänsterna ber om:
 *
 * - behörighet: påfyllaren och läsaren kommer inte åt (sidan ger null, tjänsterna kastar);
 * - demo: inget anrop till Awish alls (inte ens klienten skapas);
 * - Starta om / Stäng av: rätt spec (fysiskt, online, versionskrav bara för Stäng av),
 *   skriven kod för Stäng av;
 * - Mata ut: parametrar ur kanalen, anledning + skriven kod + fingeravtryck krävs, spärrens
 *   nej (takt, version) når användaren;
 * - strömschema: förifyllt från butiken, tidszonsspärr, HH:MM:00 och veckodagarna;
 * - byt pack via API (skrivväg api) och fyll fullt; skärm och reklam skickar bara ändringar.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { AuthorizationError, listOrganizationsFor } from "../../src/server/access";
import type { AwishApiState } from "../../src/server/awish/control/connect";
import type { ControlActionSpec, ControlActionResult } from "../../src/server/awish/control/guard";
import type { SlotWriter } from "../../src/server/awish/control/slot-writer";
import type {
  AwishControlApi,
  AwishMachineConfig,
  AwishProductDetail,
} from "../../src/server/awish/control/types";
import type { AwishWebProduct } from "../../src/server/awish/web-client";
import type { Viewer } from "../../src/server/data/core/loaders";
import type { MachineControlDeps } from "../../src/server/machine-control/common";

import { asUser, createMember, createOrg, createUser, db, type TestUser } from "./helpers";

vi.mock("server-only", () => ({}));

const { loadStyrPage } = await import("../../src/server/machine-control/load");
const { controlPowerFor } = await import("../../src/server/machine-control/power");
const { executeShipmentFor, previewShipmentFor } =
  await import("../../src/server/machine-control/shipment");
const { applyPowerScheduleFor, previewPowerScheduleFor, storeHoursFor } =
  await import("../../src/server/machine-control/power-schedule");
const { applySlotSwapFor, previewSlotSwapFor } =
  await import("../../src/server/machine-control/slot-swap");
const { applyReplenishFor, previewReplenishFor } =
  await import("../../src/server/machine-control/replenish");
const { applyMachineConfigFor, previewMachineConfigFor } =
  await import("../../src/server/machine-control/machine-config");

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

// ---------------------------------------------------------------------------
// Låtsas-Awish och spärr
// ---------------------------------------------------------------------------

interface FakeState {
  online: boolean;
  timezone: string | null;
  products: AwishProductDetail[];
  config: AwishMachineConfig;
  writes: { method: string; args: unknown }[];
  clients: number;
}

function newState(): FakeState {
  const channel = (name: string, motorId: string) => ({
    id: motorId,
    name,
    addr: "1",
    motorId,
    floorType: 2,
    total: 10,
  });
  return {
    online: true,
    timezone: "Europe/Stockholm",
    products: [
      {
        id: "71",
        machineId: "123",
        status: true,
        floorStatus: "ERR_NORMAL",
        lockStatus: null,
        currentInventory: 4,
        capacity: 10,
        goodId: "9",
        goodName: "Mystery Pack",
        channel: channel("A3", "13"),
      },
      {
        id: "72",
        machineId: "123",
        status: true,
        floorStatus: "ERR_NORMAL",
        lockStatus: null,
        currentInventory: 0,
        capacity: 8,
        goodId: null,
        goodName: null,
        channel: channel("12", "14"),
      },
    ],
    config: {
      volume: 60,
      brightness: 80,
      language: "sv",
      appVersion: "3.1",
      standbyAdsAutoplay: true,
      standbyAdsEnabled: true,
      standbyAdsSwitchInterval: 10,
      carouselAdsEnabled: false,
      carouselAdsSwitchInterval: 10,
      temperature: null,
      uptimeMinutesToday: null,
    },
    writes: [],
    clients: 0,
  };
}

function fakeApi(st: FakeState): AwishControlApi {
  const ok = (method: string) => async (args: unknown) => {
    st.writes.push({ method, args });
    return { code: 0, message: "ok", requestId: "r1", data: null };
  };
  const impl: Partial<AwishControlApi> = {
    machineDetail: async (id) => ({
      id,
      name: "BL-003",
      machineNo: "1",
      isOnline: st.online,
      status: "ok",
      config: st.config,
    }),
    productDetails: async () => st.products,
    merchantDetail: async () => ({
      id: "1",
      title: "Binderlab",
      expiredAt: null,
      timezone: st.timezone,
      whitelistIp: null,
      taxEnabled: null,
    }),
    controlPower: ok("controlPower"),
    executeShipment: ok("executeShipment"),
    setPowerSchedule: ok("setPowerSchedule"),
    clearPowerSchedule: ok("clearPowerSchedule"),
    updateMachineConfig: ok("updateMachineConfig"),
    replenishProductInventory: ok("replenishProductInventory"),
    close: () => {},
  };
  return new Proxy(impl as AwishControlApi, {
    get(target, prop) {
      const v = (target as unknown as Record<string | symbol, unknown>)[prop];
      if (v === undefined) throw new Error(`Låtsas-Awish saknar ${String(prop)}`);
      return v;
    },
  });
}

const STATE: AwishApiState = {
  id: "00000000-0000-4000-8000-000000000001",
  dataSourceId: "00000000-0000-4000-8000-000000000002",
  endpointCheckedAt: null,
  endpointError: null,
  signCheckedAt: null,
  signError: null,
  version: "1.2.41",
  versionSeenAt: null,
  previousVersion: null,
  versionChangedAt: null,
  versionAcknowledgedAt: null,
  endpoint: "plain",
  signMode: "present_sorted",
  signStatus: "ok",
  slotWritesVia: "api",
  goodsWritesVia: "web",
};

let st: FakeState;
let specs: ControlActionSpec[];
let refuse: { kind: "rate_limited" | "version_unacknowledged"; message: string } | null;

function deps(extra: Partial<MachineControlDeps> = {}): MachineControlDeps {
  const api = () => fakeApi(st);
  async function run<T>(
    _viewer: Viewer,
    spec: ControlActionSpec,
    fn: (
      a: AwishControlApi,
      ctx: { awishMachineId: string | null; db: ReturnType<typeof db> },
    ) => Promise<T>,
  ): Promise<ControlActionResult<T>> {
    specs.push(spec);
    if (refuse) return { ok: false, message: refuse.message, actionId: null, kind: refuse.kind };
    const value = await fn(api(), { awishMachineId: "123", db: db() });
    return { ok: true, message: "", value, actionId: randomUUID(), replayed: false };
  }
  return {
    db: db(),
    run,
    client: async () => {
      st.clients++;
      return { api: api(), sourceId: "x", state: STATE };
    },
    awishIdFor: async (_db, _org, machineId) => (machineId === m1 ? "123" : null),
    now: () => new Date("2026-11-24T12:00:00Z"),
    ...extra,
  };
}

let owner: TestUser;
let refiller: TestUser;
let viewerUser: TestUser;
let orgId: string;
let demoOrg: string;
let m1: string;
let m2: string;
let demoMachine: string;

beforeAll(async () => {
  owner = await createUser();
  orgId = await createOrg(owner);
  refiller = await createMember(orgId, "refiller");
  viewerUser = await createMember(orgId, "viewer");
  const machines = await asUser(owner, (tx) =>
    tx
      .insert(s.machines)
      .values([
        { organizationId: orgId, code: "BL-003", name: "Sega gubben", activeFrom: "2026-10-01" },
        { organizationId: orgId, code: "BL-004", name: "Okopplad", activeFrom: "2026-10-01" },
      ])
      .returning(),
  );
  [m1, m2] = machines.map((m) => m.id) as [string, string];
  const [store] = await asUser(owner, (tx) =>
    tx
      .insert(s.stores)
      .values({
        organizationId: orgId,
        name: "Ica Kvantum",
        powerOnTime: "10:00",
        powerOffTime: "21:00",
      })
      .returning(),
  );
  await asUser(owner, (tx) =>
    tx.insert(s.machinePlacements).values({
      organizationId: orgId,
      machineId: m1,
      storeId: store!.id,
      validFrom: "2026-10-01",
    }),
  );

  demoOrg = await createOrg(owner, "Demo");
  const [dm] = await asUser(owner, (tx) =>
    tx
      .insert(s.machines)
      .values({ organizationId: demoOrg, code: "BL-001", name: "Demo", activeFrom: "2026-10-01" })
      .returning(),
  );
  demoMachine = dm!.id;
  await db().execute(
    sql`update public.organizations set is_demo = true where id = ${demoOrg}::uuid`,
  );
});

function fresh() {
  st = newState();
  specs = [];
  refuse = null;
}

describe("behörighet och demo", () => {
  it("påfyllaren och läsaren: sidan finns inte och tjänsterna nekar", async () => {
    fresh();
    for (const u of [refiller, viewerUser]) {
      const v = await viewerFor(u, orgId);
      expect(await loadStyrPage(v, "bl-003", deps())).toBeNull();
      await expect(
        controlPowerFor(
          v,
          { machineId: m1, method: "REBOOT", idempotencyKey: randomUUID() },
          deps(),
        ),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        previewShipmentFor(v, { machineId: m1, productId: "71" }, deps()),
      ).rejects.toBeInstanceOf(AuthorizationError);
    }
    expect(st.clients).toBe(0);
    expect(specs).toHaveLength(0);
  });

  it("demo: sidan visar demo och inget anrop till Awish görs", async () => {
    fresh();
    const v = await viewerFor(owner, demoOrg);
    const page = await loadStyrPage(v, "BL-001", deps());
    expect(page?.kind).toBe("demo");
    await expect(
      previewShipmentFor(v, { machineId: demoMachine, productId: "71" }, deps()),
    ).rejects.toThrow(/demo/);
    expect(st.clients).toBe(0);
  });

  it("okopplad automat", async () => {
    fresh();
    const v = await viewerFor(owner, orgId);
    expect((await loadStyrPage(v, "BL-004", deps()))?.kind).toBe("not_linked");
    await expect(
      previewReplenishFor(v, { machineId: m2, productIds: ["71"] }, deps()),
    ).rejects.toThrow("Automaten är inte kopplad till Awish.");
  });

  it("sidan för ägaren: online, fack, butikens tider", async () => {
    fresh();
    const v = await viewerFor(owner, orgId);
    const page = await loadStyrPage(v, "bl-003", deps());
    expect(page?.kind).toBe("ready");
    if (page?.kind !== "ready") return;
    expect(page.online).toBe(true);
    expect(page.slots.map((x) => x.name)).toEqual(["12", "A3"]);
    expect(page.store).toEqual({ storeName: "Ica Kvantum", on: "10:00", off: "21:00" });
    expect(page.errors).toEqual([]);
    expect(st.writes).toEqual([]);
  });
});

describe("starta om och stäng av", () => {
  it("starta om: fysiskt, online, ingen versionsspärr", async () => {
    fresh();
    const v = await viewerFor(owner, orgId);
    const r = await controlPowerFor(
      v,
      { machineId: m1, method: "REBOOT", idempotencyKey: randomUUID() },
      deps(),
    );
    expect(r).toEqual({
      ok: true,
      message: "Skickat. BL-003 startar om inom ett par minuter.",
      replayed: false,
    });
    expect(specs[0]).toMatchObject({
      kind: "reboot",
      physical: true,
      requireOnline: true,
      requireAckedVersion: false,
      machineId: m1,
    });
    expect(st.writes).toEqual([
      { method: "controlPower", args: { machineId: "123", method: "REBOOT" } },
    ]);
  });

  it("stäng av kräver koden och bekräftad version", async () => {
    fresh();
    const v = await viewerFor(owner, orgId);
    await expect(
      controlPowerFor(
        v,
        { machineId: m1, method: "SHUTDOWN", typed: "BL-004", idempotencyKey: randomUUID() },
        deps(),
      ),
    ).rejects.toThrow("Skriv BL-003 för att stänga av.");
    expect(specs).toHaveLength(0);
    await controlPowerFor(
      v,
      { machineId: m1, method: "SHUTDOWN", typed: "bl-003", idempotencyKey: randomUUID() },
      deps(),
    );
    expect(specs[0]).toMatchObject({ kind: "shutdown", requireAckedVersion: true, physical: true });
  });

  it("utan idempotensnyckel skickas inget", async () => {
    fresh();
    const v = await viewerFor(owner, orgId);
    await expect(
      controlPowerFor(v, { machineId: m1, method: "REBOOT", idempotencyKey: "x" }, deps()),
    ).rejects.toThrow(/förhandsvisningen/);
    expect(st.writes).toEqual([]);
  });
});

describe("mata ut ett pack", () => {
  it("förhandsvisning, sedan anledning + kod + fingeravtryck", async () => {
    fresh();
    const v = await viewerFor(owner, orgId);
    const raw = { machineId: m1, productId: "72" };
    const p = await previewShipmentFor(v, raw, deps());
    expect(p.typed).toBe("BL-003");
    expect(p.blocking).toBeNull();
    expect(p.warnings).toContain("Fack 12 är tomt enligt Awish.");
    const c = { fingerprint: p.fingerprint, idempotencyKey: p.idempotencyKey, typed: "BL-003" };

    await expect(executeShipmentFor(v, raw, { ...c, reason: "kort" }, deps())).rejects.toThrow(
      /minst 5/,
    );
    await expect(
      executeShipmentFor(v, raw, { ...c, typed: "BL-0", reason: "Pack fastnade" }, deps()),
    ).rejects.toThrow("Skriv BL-003 för att mata ut.");
    await expect(
      executeShipmentFor(v, raw, { ...c, fingerprint: "fel", reason: "Pack fastnade" }, deps()),
    ).rejects.toThrow(/ändrats/);
    expect(st.writes).toEqual([]);

    const r = await executeShipmentFor(v, raw, { ...c, reason: "Pack fastnade" }, deps());
    expect(r).toMatchObject({ ok: true, message: "Skickat. Kontrollera att packet kom ut." });
    expect(specs[0]).toMatchObject({
      kind: "shipment",
      physical: true,
      requireOnline: true,
      requireAckedVersion: true,
      reason: "Pack fastnade",
      targetId: "72",
    });
    expect(st.writes).toEqual([
      {
        method: "executeShipment",
        args: { machineId: "123", addr: "1", motorIds: ["14"], floorType: 2, code: "12" },
      },
    ]);
    // Lagret ändras inte av Binderlab.
    expect(st.products[1]!.currentInventory).toBe(0);
  });

  it("offline spärrar redan i förhandsvisningen", async () => {
    fresh();
    st.online = false;
    const v = await viewerFor(owner, orgId);
    const p = await previewShipmentFor(v, { machineId: m1, productId: "71" }, deps());
    expect(p.blocking).toBe("Automaten är offline. Det går bara när den är online.");
    await expect(
      executeShipmentFor(
        v,
        { machineId: m1, productId: "71" },
        {
          fingerprint: p.fingerprint,
          idempotencyKey: p.idempotencyKey,
          typed: "BL-003",
          reason: "Testar motorn",
        },
        deps(),
      ),
    ).rejects.toThrow(/offline/);
  });

  it("spärrens nej (takt, version) når användaren", async () => {
    fresh();
    const v = await viewerFor(owner, orgId);
    const raw = { machineId: m1, productId: "71" };
    for (const no of [
      { kind: "rate_limited" as const, message: "Vänta två minuter innan nästa." },
      { kind: "version_unacknowledged" as const, message: "Awish bytte version. Bekräfta först." },
    ]) {
      const p = await previewShipmentFor(v, raw, deps());
      refuse = no;
      const r = await executeShipmentFor(
        v,
        raw,
        {
          fingerprint: p.fingerprint,
          idempotencyKey: p.idempotencyKey,
          typed: "BL-003",
          reason: "Testar motorn",
        },
        deps(),
      );
      expect(r).toEqual({ ok: false, message: no.message, kind: no.kind });
      refuse = null;
    }
    expect(st.writes).toEqual([]);
  });
});

describe("strömschema", () => {
  it("butikens tider", async () => {
    expect(await storeHoursFor(db(), orgId, m1, new Date("2026-11-24T12:00:00Z"))).toEqual({
      storeName: "Ica Kvantum",
      on: "10:00",
      off: "21:00",
    });
    expect(await storeHoursFor(db(), orgId, m2, new Date())).toBeNull();
  });

  it("skickar HH:MM:00 och veckodagarna", async () => {
    fresh();
    const v = await viewerFor(owner, orgId);
    const raw = { machineId: m1, days: "1111100", on: "10:00", off: "21:00" };
    const p = await previewPowerScheduleFor(v, raw, deps());
    expect(p.lines).toEqual(["Awish slår på 10:00 och av 21:00, mån–fre (Europe/Stockholm)."]);
    const r = await applyPowerScheduleFor(
      v,
      raw,
      { fingerprint: p.fingerprint, idempotencyKey: p.idempotencyKey },
      deps(),
    );
    expect(r.ok).toBe(true);
    expect(specs[0]).toMatchObject({
      kind: "power_schedule_set",
      auditRequest: { source: "custom" },
    });
    expect(st.writes).toEqual([
      {
        method: "setPowerSchedule",
        args: {
          machineId: "123",
          weekdays: [1, 1, 1, 1, 1, 0, 0],
          powerOn: "10:00:00",
          powerOff: "21:00:00",
        },
      },
    ]);
    const [table] = Array.from(
      await db().execute(sql`select to_regclass('public.machine_power_schedules') as t`),
    ) as { t: string | null }[];
    if (table?.t) {
      const [row] = Array.from(
        await db().execute(
          sql`select weekdays, power_on, power_off, status from public.machine_power_schedules
              where organization_id = ${orgId}::uuid and machine_id = ${m1}::uuid`,
        ),
      );
      expect(row).toMatchObject({
        weekdays: "1111100",
        power_on: "10:00",
        power_off: "21:00",
        status: "sent",
      });
    }
  });

  it("annan tidszon i Awish spärrar", async () => {
    fresh();
    st.timezone = "Asia/Shanghai";
    const v = await viewerFor(owner, orgId);
    const raw = { machineId: m1, days: "1111111", on: "10:00", off: "21:00" };
    const p = await previewPowerScheduleFor(v, raw, deps());
    expect(p.blocking).toMatch(/Asia\/Shanghai/);
    await expect(
      applyPowerScheduleFor(
        v,
        raw,
        { fingerprint: p.fingerprint, idempotencyKey: p.idempotencyKey },
        deps(),
      ),
    ).rejects.toThrow(/Asia\/Shanghai/);
    expect(st.writes).toEqual([]);
  });
});

describe("fack", () => {
  function writer(): SlotWriter {
    const toWeb = (p: AwishProductDetail): AwishWebProduct & { floorStatus: string | null } => ({
      id: Number(p.id),
      goodId: p.goodId ? Number(p.goodId) : null,
      goodName: p.goodName,
      status: p.status,
      currentInventory: p.currentInventory,
      capacity: p.capacity,
      channelName: p.channel?.name ?? null,
      floorStatus: p.floorStatus,
    });
    return {
      via: "api",
      close: () => {},
      slots: async () => st.products.map(toWeb),
      setSlot: async (productId, i) => {
        st.writes.push({ method: "setSlot", args: { productId, ...i } });
        const p = st.products.find((x) => Number(x.id) === productId)!;
        p.goodId = i.goodId === null ? null : String(i.goodId);
        p.goodName = i.goodId === 9 ? "Mystery Pack" : i.goodId === 11 ? "Black Bolt" : null;
        p.currentInventory = i.currentInventory;
      },
    };
  }
  const goods = async () => [
    { id: 9, name: "Mystery Pack", priceOre: 7900, thumb: null },
    { id: 11, name: "Black Bolt", priceOre: 7900, thumb: null },
  ];

  it("byt pack via API: bekräftelse när facket har pack, kontroll efteråt", async () => {
    fresh();
    const v = await viewerFor(owner, orgId);
    const d = deps({ slotWriter: async () => writer() });
    const sd = { ...d, listGoods: goods };
    const raw = { machineId: m1, productId: 71, goodId: 11, count: 6 };
    const p = await previewSlotSwapFor(v, raw, sd);
    expect(p.via).toBe("api");
    expect(p.lines).toEqual(["Fack A3: Mystery Pack 4 st → Black Bolt 6 st."]);
    expect(p.confirm).toBe("Fack A3 har 4 Mystery Pack – byt ändå?");
    await expect(
      applySlotSwapFor(
        v,
        raw,
        { fingerprint: p.fingerprint, idempotencyKey: p.idempotencyKey, confirmed: false },
        sd,
      ),
    ).rejects.toThrow(/Bekräfta först/);
    const r = await applySlotSwapFor(
      v,
      raw,
      { fingerprint: p.fingerprint, idempotencyKey: p.idempotencyKey, confirmed: true },
      sd,
    );
    expect(r).toMatchObject({ ok: true, message: "Klart! Fack A3: Black Bolt 6 st." });
    expect(specs[0]).toMatchObject({ kind: "slot_update", targetId: "71" });
    expect(st.writes).toEqual([
      { method: "setSlot", args: { productId: 71, goodId: 11, status: true, currentInventory: 6 } },
    ]);
  });

  it("fyll fullt", async () => {
    fresh();
    const v = await viewerFor(owner, orgId);
    const raw = { machineId: m1, productIds: ["71", "72"] };
    const p = await previewReplenishFor(v, raw, deps());
    expect(p.lines).toEqual(["A3 4 → 10", "12 0 → 8"]);
    const r = await applyReplenishFor(
      v,
      raw,
      { fingerprint: p.fingerprint, idempotencyKey: p.idempotencyKey },
      deps(),
    );
    expect(r).toMatchObject({ ok: true, message: "Klart! 2 fack är fulla (+14 st)." });
    expect(st.writes).toEqual([
      { method: "replenishProductInventory", args: { machineId: "123", ids: ["71", "72"] } },
    ]);
  });
});

describe("skärm och reklam", () => {
  it("bara ändringarna skickas", async () => {
    fresh();
    const v = await viewerFor(owner, orgId);
    const raw = {
      machineId: m1,
      standbyAdsEnabled: true,
      standbyAdsAutoplay: true,
      carouselAdsEnabled: true,
      standbyAdsSwitchInterval: 10,
      carouselAdsSwitchInterval: 20,
    };
    const p = await previewMachineConfigFor(v, raw, deps());
    expect(p.lines).toEqual(["Bildspel: av → på.", "Byt bild i bildspelet var: 10 s → 20 s."]);
    await applyMachineConfigFor(
      v,
      raw,
      { fingerprint: p.fingerprint, idempotencyKey: p.idempotencyKey },
      deps(),
    );
    expect(st.writes).toEqual([
      {
        method: "updateMachineConfig",
        args: { machineId: "123", carouselAdsEnabled: true, carouselAdsSwitchInterval: 20 },
      },
    ]);
  });

  it("inget ändrat: inget skickas", async () => {
    fresh();
    const v = await viewerFor(owner, orgId);
    const raw = {
      machineId: m1,
      standbyAdsEnabled: true,
      standbyAdsAutoplay: true,
      carouselAdsEnabled: false,
      standbyAdsSwitchInterval: 10,
      carouselAdsSwitchInterval: 10,
    };
    const p = await previewMachineConfigFor(v, raw, deps());
    expect(p.blocking).toBe("Inget att ändra.");
    await expect(
      applyMachineConfigFor(
        v,
        raw,
        { fingerprint: p.fingerprint, idempotencyKey: p.idempotencyKey },
        deps(),
      ),
    ).rejects.toThrow("Inget att ändra.");
    expect(st.writes).toEqual([]);
  });
});
