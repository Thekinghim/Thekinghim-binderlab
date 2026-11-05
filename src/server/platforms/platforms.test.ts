import { readFileSync } from "node:fs";
import path from "node:path";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { awishCsvAdapter } = await import("@/import/adapters/awish-csv");
const { mapAwishOrders } = await import("@/import/adapters/awish-grpc");
const { manualCsvAdapter, MANUAL_CSV_TEMPLATE } = await import("@/import/adapters/manual-csv");
const { ImportValidationError } = await import("@/import/errors");
const { createAwishClient } = await import("@/server/awish/grpc-client");
const { fakeOrder, startFakeAwish } = await import("@/server/awish/testing/fake-server");
const platforms = await import("./index");
const { createAwishPlatform } = await import("./awish");

const {
  allPlatforms,
  isManualProvider,
  parsePlatformFile,
  platformFor,
  platformIdOf,
  PLATFORM_INFO,
  providerAcceptsFiles,
} = platforms;

const context = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  dataSourceId: "22222222-2222-4222-8222-222222222222",
  sourceTimezone: "Asia/Shanghai",
  config: {},
  secretRef: null,
};

const awishFile = new Uint8Array(
  readFileSync(
    path.join(
      __dirname,
      "..",
      "..",
      "..",
      "test",
      "fixtures",
      "awish",
      "orderlista-2026-11-02.csv",
    ),
  ),
);

/** Resultatet utan Date-objekt, för jämförelse. */
const plain = (value: unknown) => JSON.parse(JSON.stringify(value)) as unknown;

describe("katalogen", () => {
  it("varje datakälla hör till exakt en plattform", () => {
    const providers = ["awish_grpc", "awish_csv", "awish_web", "awish_extension", "manual_csv"];
    for (const p of providers) {
      const owners = Object.values(PLATFORM_INFO).filter((i) =>
        (i.providers as readonly string[]).includes(p),
      );
      expect(owners, p).toHaveLength(1);
    }
    expect(platformIdOf("awish_grpc")).toBe("awish");
    expect(platformIdOf("manual_csv")).toBe("manual_csv");
    expect(platformIdOf("okänd")).toBeNull();
    expect(platformFor("okänd")).toBeNull();
  });

  it("filer och manuell uppladdning: samma regel som förut för Awish, plus manual_csv", () => {
    expect(providerAcceptsFiles("awish_csv")).toBe(true);
    expect(providerAcceptsFiles("manual_csv")).toBe(true);
    expect(providerAcceptsFiles("awish_grpc")).toBe(false);
    expect(isManualProvider("awish_csv")).toBe(true);
    expect(isManualProvider("manual_csv")).toBe(true);
    expect(isManualProvider("awish_grpc")).toBe(false);
    expect(isManualProvider("awish_web")).toBe(false);
  });

  it("förmågorna stämmer med implementationen", () => {
    for (const p of allPlatforms()) {
      expect(Boolean(p.parseFile), p.id).toBe(p.capabilities.acceptsFiles);
      expect(Boolean(p.connect), p.id).toBe(p.capabilities.automaticOrders);
      expect(Boolean(p.refill), p.id).toBe(p.capabilities.writeRefill);
    }
    expect(PLATFORM_INFO.manual_csv.capabilities).toMatchObject({
      automaticOrders: false,
      readSlots: false,
      writeRefill: false,
    });
  });
});

describe("filer genom plattformen", () => {
  it("Awish orderlista: exakt samma resultat som awish_csv-adaptern direkt", async () => {
    const direct = await awishCsvAdapter.fetch({
      context,
      file: { name: "a.csv", content: awishFile },
    });
    const viaPlatform = await parsePlatformFile({
      context,
      provider: "awish_csv",
      file: { name: "a.csv", content: awishFile },
    });
    expect(plain(viaPlatform)).toEqual(plain(direct));
    expect(direct.rows.length).toBeGreaterThan(0);
  });

  it("Annan automat: samma resultat som manual_csv-adaptern direkt", async () => {
    const ctx = { ...context, sourceTimezone: "Europe/Stockholm" };
    const direct = await manualCsvAdapter.fetch({
      context: ctx,
      file: { name: "m.csv", content: MANUAL_CSV_TEMPLATE },
    });
    const viaPlatform = await parsePlatformFile({
      context: ctx,
      provider: "manual_csv",
      file: { name: "m.csv", content: MANUAL_CSV_TEMPLATE },
    });
    expect(plain(viaPlatform)).toEqual(plain(direct));
  });

  it("en API-källa tar inte emot filer", async () => {
    await expect(
      parsePlatformFile({ context, provider: "awish_grpc", file: { name: "a.csv", content: "x" } }),
    ).rejects.toBeInstanceOf(ImportValidationError);
  });
});

describe("Awish som plattform mot låtsas-Awish (gRPC på 127.0.0.1)", () => {
  type Fake = Awaited<ReturnType<typeof startFakeAwish>>;
  let fake: Fake;
  beforeAll(async () => {
    fake = await startFakeAwish({
      machines: [
        { id: "2", name: "BL-001 Centrum", machine_no: "163271xx" },
        { id: "3", name: "BL-002 Väst", machine_no: "", is_online: false },
      ],
      orders: [fakeOrder(1), fakeOrder(2, { status: "PAY_NOTPAY", payTime: null }), fakeOrder(3)],
      products: {
        "2": [
          { channel: "A1", good: "Surging Sparks Booster", current: 4, capacity: 6 },
          { channel: "A2", good: null, current: 0, capacity: 6 },
        ],
      },
    });
  });
  afterAll(async () => {
    await fake.stop();
  });

  const creds = () => ({
    appId: fake.state.appId,
    appSecret: fake.state.appSecret,
    appKey: fake.state.appKey,
  });
  const options = () => ({ address: fake.address, tls: false, sleep: async () => {} });

  it("listMachines: id, namn, serienummer och anslutning", async () => {
    const conn = createAwishPlatform().connect!({ credentials: creds(), options: options() });
    try {
      expect(await conn.listMachines!()).toEqual([
        { externalId: "2", name: "BL-001 Centrum", deviceNo: "163271xx", online: true },
        { externalId: "3", name: "BL-002 Väst", deviceNo: null, online: false },
      ]);
    } finally {
      conn.close();
    }
  });

  it("readOrders: samma tolkning som synken (mapAwishOrders på samma sida)", async () => {
    const conn = createAwishPlatform().connect!({ credentials: creds(), options: options() });
    const api = createAwishClient(creds(), options());
    try {
      const page = await conn.readOrders({ page: 1, perPage: 50, sourceTimezone: "Asia/Shanghai" });
      const raw = await api.orders({ currentPage: 1, perPage: 50 });
      const expected = mapAwishOrders({
        orders: raw.items,
        machines: [
          { id: "2", name: "BL-001 Centrum", machineNo: "163271xx" },
          { id: "3", name: "BL-002 Väst", machineNo: "" },
        ],
        sourceTimezone: "Asia/Shanghai",
      });
      expect(plain(page.result)).toEqual(plain(expected));
      expect(page.hasMore).toBe(false);
      expect(page.result.rows.filter((r) => r.isPaid)).toHaveLength(2);
      expect(page.result.rows[0]?.sourceMachineName).toBe("BL-001 Centrum");
    } finally {
      conn.close();
      api.close();
    }
  });

  it("readSlots: fack, vara och antal", async () => {
    const conn = createAwishPlatform().connect!({ credentials: creds(), options: options() });
    try {
      expect(await conn.readSlots!("2")).toEqual([
        { channel: "A1", productName: "Surging Sparks Booster", units: 4, capacity: 6 },
        { channel: "A2", productName: null, units: 0, capacity: 6 },
      ]);
    } finally {
      conn.close();
    }
  });

  it("refill: anropar samma push som påfyllningen och översätter resultatet", async () => {
    const push = vi.fn(async () => ({
      status: "done" as const,
      machines: [
        {
          machineId: "m1",
          machineCode: "BL-001",
          status: "pushed" as const,
          slotsUpdated: 2,
          titlesWithoutSlot: [],
        },
        {
          machineId: "m2",
          machineCode: "BL-002",
          status: "error" as const,
          slotsUpdated: 0,
          titlesWithoutSlot: [],
          error: "Awish svarar inte.",
        },
      ],
    }));
    const platform = createAwishPlatform({ pushRefill: push });
    const result = await platform.refill!.pushRefill("org", ["m1", "m2"]);
    expect(push).toHaveBeenCalledWith("org", ["m1", "m2"]);
    expect(result).toEqual({
      status: "done",
      machines: [
        { machineId: "m1", ok: true, message: null },
        { machineId: "m2", ok: false, message: "Awish svarar inte." },
      ],
    });
  });
});
