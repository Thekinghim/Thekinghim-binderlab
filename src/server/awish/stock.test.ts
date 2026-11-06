import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { createAwishClient, toProduct } = await import("./grpc-client");
const { groupProducts, goodKey, STOCK_SYNC_INTERVAL_MS } = await import("./stock");
const { parseState, stockDue } = await import("./sync");
const { startFakeAwish } = await import("./testing/fake-server");

type Fake = Awaited<ReturnType<typeof startFakeAwish>>;

const product = (channel: string, goodName: string | null, current: number, capacity = 10) => ({
  id: channel,
  machineId: "2",
  channel,
  goodId: goodName === null ? null : "1",
  goodName,
  currentInventory: current,
  capacity,
});

describe("toProduct", () => {
  it("läser kanal, vara, antal och kapacitet (uint64 som text)", () => {
    expect(
      toProduct({
        id: "7",
        machine_id: "2",
        current_inventory: "4",
        inventory: "8",
        channel: { name: " A3 " },
        good: { id: "55", name: " Surging Sparks " },
      }),
    ).toEqual({
      id: "7",
      machineId: "2",
      channel: "A3",
      goodId: "55",
      goodName: "Surging Sparks",
      currentInventory: 4,
      capacity: 8,
    });
  });

  it("fack utan vara och konstiga tal", () => {
    expect(toProduct({ id: "1", current_inventory: "-3", inventory: "x" })).toMatchObject({
      channel: "",
      goodId: null,
      goodName: null,
      currentInventory: 0,
      capacity: 0,
    });
  });
});

describe("groupProducts", () => {
  it("summerar fack med samma vara (samma namnregel som orderimporten)", () => {
    const groups = groupProducts([
      product("A3", "Surging Sparks", 4),
      product("A10", "surging  sparks", 2),
      product("A2", "Surging Sparks".normalize("NFD"), 1),
      product("B1", "Black Bolt", 0, 6),
      product("B2", null, 5),
      product("B3", "   ", 5),
    ]);
    expect(groups).toEqual([
      {
        name: "Black Bolt",
        key: "black bolt",
        units: 0,
        capacity: 6,
        slotCount: 1,
        emptySlots: 1,
        channels: ["B1"],
      },
      {
        name: "Surging Sparks",
        key: "surging sparks",
        units: 7,
        capacity: 30,
        slotCount: 3,
        emptySlots: 0,
        channels: ["A2", "A3", "A10"],
      },
    ]);
    expect(goodKey("Pokémon".normalize("NFD"))).toBe(goodKey("POKÉMON"));
  });

  it("tom lista ger inga grupper", () => {
    expect(groupProducts([])).toEqual([]);
  });
});

describe("stockDue", () => {
  const now = new Date("2026-11-03T12:00:00Z");
  it("Synka nu läser alltid; cron var femte minut", () => {
    expect(STOCK_SYNC_INTERVAL_MS).toBe(5 * 60_000);
    expect(stockDue({ stockSyncedAt: null }, "schedule", now)).toBe(true);
    expect(stockDue({ stockSyncedAt: "2026-11-03T11:59:00Z" }, "manual", now)).toBe(true);
    // Strax efter "Synka nu" läser cron inte om.
    expect(stockDue({ stockSyncedAt: "2026-11-03T11:59:00Z" }, "schedule", now)).toBe(false);
    expect(stockDue({ stockSyncedAt: "2026-11-03T11:58:00Z" }, "schedule", now)).toBe(false);
    expect(stockDue({ stockSyncedAt: "2026-11-03T11:55:00Z" }, "schedule", now)).toBe(true);
    expect(stockDue({ stockSyncedAt: "2026-11-03T11:30:00Z" }, "schedule", now)).toBe(true);
    expect(stockDue({ stockSyncedAt: "trasig" }, "schedule", now)).toBe(true);
  });

  /**
   * Simulerar ticks var femte minut i två timmar. Varje körning startar 0–20 s efter
   * utsatt tid (pg_net, kallstart) och facken är lästa (stockSyncedAt) 5–60 s efter
   * starten (maxDuration 60 s). Saldot ska läsas i varje tick: ingen hoppas över.
   */
  it("cron var femte minut: varje tick läser saldot, även med ojämn takt", () => {
    const t0 = Date.parse("2026-11-03T10:00:00Z");
    // Fasta "slumpvärden" som täcker ytterlägena: snabb efter långsam och tvärtom.
    const startDelay = [0, 20, 0, 19, 1, 20, 0, 0, 20, 5, 0, 20];
    const readTime = [60, 5, 60, 60, 5, 60, 5, 60, 5, 60, 60, 5];
    let stockSyncedAt: string | null = null;
    let reads = 0;
    const ticks = 24;
    for (let i = 0; i < ticks; i++) {
      const started = new Date(t0 + i * STOCK_SYNC_INTERVAL_MS + startDelay[i % 12]! * 1000);
      if (stockDue({ stockSyncedAt }, "schedule", started)) {
        reads++;
        stockSyncedAt = new Date(started.getTime() + readTime[i % 12]! * 1000).toISOString();
      }
    }
    expect(reads).toBe(ticks);
  });

  it("två körningar inom samma femminutersperiod läser inte saldot två gånger", () => {
    const tick = new Date("2026-11-03T12:00:00Z");
    // Förra ticken läste klart 12:00:40; en extra körning 12:02 (t.ex. ett nytt försök) läser inte.
    const after = { stockSyncedAt: "2026-11-03T12:00:40Z" };
    expect(stockDue(after, "schedule", new Date(tick.getTime() + 2 * 60_000))).toBe(false);
    // Nästa ordinarie tick 12:05 läser.
    expect(stockDue(after, "schedule", new Date(tick.getTime() + 5 * 60_000))).toBe(true);
  });

  it("läget kommer ihåg senaste saldoläsningen", () => {
    expect(
      parseState(JSON.stringify({ stockSyncedAt: "2026-11-03T11:00:00Z" })).stockSyncedAt,
    ).toBe("2026-11-03T11:00:00Z");
    expect(parseState("{}").stockSyncedAt).toBeNull();
  });
});

describe("Products mot låtsas-Awish", () => {
  let fake: Fake;
  beforeAll(async () => {
    fake = await startFakeAwish({
      products: {
        "2": [
          { channel: "A1", good: "Surging Sparks", current: 3, capacity: 8 },
          { channel: "A2", good: null, current: 0, capacity: 8 },
        ],
      },
    });
  });
  afterAll(async () => {
    await fake.stop();
  });

  it("skickar machine_id och tolkar facken", async () => {
    const api = createAwishClient(
      { appId: fake.state.appId, appSecret: fake.state.appSecret, appKey: fake.state.appKey },
      { address: fake.address, tls: false, sleep: async () => {} },
    );
    try {
      const list = await api.products("2");
      expect(list).toHaveLength(2);
      expect(list[0]).toMatchObject({
        channel: "A1",
        goodName: "Surging Sparks",
        currentInventory: 3,
        capacity: 8,
      });
      expect(list[1]).toMatchObject({ channel: "A2", goodName: null });
      expect(fake.state.calls.at(-1)).toMatchObject({
        method: "Products",
        request: { machine_id: "2" },
      });
      expect(await api.products("999")).toEqual([]);
    } finally {
      api.close();
    }
  });
});
