import { describe, expect, it } from "vitest";

import {
  createMachineSchema,
  decommissionSchema,
  moveMachineSchema,
  normalizeCode,
  placementBeforeStart,
  placementToReopen,
  planDecommission,
  planMove,
  updateMachineSchema,
  type PlacementSpan,
} from "./validation";

const day = (d: string) => d;
const names: Record<string, string> = { s1: "Centrum", s2: "Väst" };
const storeName = (id: string) => names[id] ?? id;
const ID = "11111111-1111-4111-8111-111111111111";
const STORE = "22222222-2222-4222-8222-222222222222";

describe("createMachineSchema", () => {
  it("gör koden till versaler och tomma fält till null", () => {
    const r = createMachineSchema.safeParse({
      code: " bl-004 ",
      name: " Automat 4 ",
      serial: "",
      activeFrom: "2026-11-02",
      storeId: "",
    });
    expect(r.success).toBe(true);
    if (!r.success) return;
    expect(r.data).toEqual({
      code: "BL-004",
      name: "Automat 4",
      serial: null,
      activeFrom: "2026-11-02",
      storeId: null,
    });
  });

  it("nekar ogiltig kod, tomt namn, ogiltigt datum och butik som inte är ett id", () => {
    const base = { code: "BL-004", name: "A", activeFrom: "2026-11-02" };
    expect(createMachineSchema.safeParse({ ...base, code: "BL 004" }).success).toBe(false);
    expect(createMachineSchema.safeParse({ ...base, code: "-BL" }).success).toBe(false);
    expect(createMachineSchema.safeParse({ ...base, code: "" }).success).toBe(false);
    expect(createMachineSchema.safeParse({ ...base, name: "  " }).success).toBe(false);
    expect(createMachineSchema.safeParse({ ...base, activeFrom: "2026-02-30" }).success).toBe(
      false,
    );
    expect(createMachineSchema.safeParse({ ...base, storeId: "butik" }).success).toBe(false);
    expect(createMachineSchema.safeParse({ ...base, storeId: STORE }).success).toBe(true);
  });

  it("normalizeCode trimmar och gör versaler", () => {
    expect(normalizeCode("  bl-9 ")).toBe("BL-9");
  });
});

describe("övriga scheman", () => {
  it("kräver id och datum", () => {
    expect(
      updateMachineSchema.safeParse({ machineId: "x", name: "A", activeFrom: "2026-10-01" })
        .success,
    ).toBe(false);
    expect(
      moveMachineSchema.safeParse({ machineId: ID, storeId: STORE, from: "1 nov" }).success,
    ).toBe(false);
    expect(decommissionSchema.safeParse({ machineId: ID, activeTo: "2026-11-02" }).success).toBe(
      true,
    );
  });
});

describe("planMove", () => {
  const current: PlacementSpan = { id: "p1", storeId: "s1", from: "2026-10-01", to: null };
  const args = {
    placements: [current],
    storeId: "s2",
    from: "2026-11-05",
    activeFrom: "2026-10-01",
    activeTo: null,
    code: "BL-001",
    day,
    storeName,
  };

  it("avslutar nuvarande placering dagen före och lägger till den nya", () => {
    expect(planMove(args)).toEqual({
      ok: true,
      close: { id: "p1", to: "2026-11-04" },
      insert: { storeId: "s2", from: "2026-11-05", to: null },
    });
  });

  it("nekar flytt till samma butik", () => {
    const r = planMove({ ...args, storeId: "s1" });
    expect(r).toEqual({ ok: false, error: "BL-001 står redan i Centrum." });
  });

  it("nekar flytt samma dag som eller före en befintlig placering", () => {
    expect(planMove({ ...args, from: "2026-10-01" }).ok).toBe(false);
    expect(planMove({ ...args, from: "2026-09-20", activeFrom: null }).ok).toBe(false);
  });

  it("nekar flytt före driftstart och efter avveckling", () => {
    expect(planMove({ ...args, placements: [], from: "2026-09-01" }).ok).toBe(false);
    const r = planMove({ ...args, activeTo: "2026-11-01" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("avvecklad");
  });

  it("utan placering: ny placering som slutar på sista driftdagen", () => {
    expect(planMove({ ...args, placements: [], activeTo: "2026-12-31" })).toEqual({
      ok: true,
      close: null,
      insert: { storeId: "s2", from: "2026-11-05", to: "2026-12-31" },
    });
  });

  it("efter en avslutad placering: ingen att stänga", () => {
    const ended = { ...current, to: "2026-10-20" };
    expect(planMove({ ...args, placements: [ended] })).toMatchObject({ ok: true, close: null });
  });
});

describe("planDecommission", () => {
  const args = {
    placements: [{ id: "p1", storeId: "s1", from: "2026-10-01", to: null }] as PlacementSpan[],
    activeTo: "2026-11-02",
    activeFrom: "2026-10-01",
    lastOrderDate: "2026-11-01",
    code: "BL-001",
    day,
  };

  it("avslutar pågående placering på sista dagen", () => {
    expect(planDecommission(args)).toEqual({ ok: true, close: [{ id: "p1", to: "2026-11-02" }] });
  });

  it("nekar sista dag före sista ordern eller driftstarten", () => {
    expect(planDecommission({ ...args, activeTo: "2026-10-31" }).ok).toBe(false);
    expect(planDecommission({ ...args, activeTo: "2026-09-30", lastOrderDate: null }).ok).toBe(
      false,
    );
  });

  it("nekar när en placering börjar efter sista dagen", () => {
    const later = [...args.placements, { id: "p2", storeId: "s2", from: "2026-11-10", to: null }];
    expect(planDecommission({ ...args, placements: later }).ok).toBe(false);
  });

  it("rör inte placeringar som redan slutat", () => {
    const ended = [{ id: "p1", storeId: "s1", from: "2026-10-01", to: "2026-10-15" }];
    expect(planDecommission({ ...args, placements: ended })).toEqual({ ok: true, close: [] });
  });
});

describe("sentences", () => {
  it("ingen dubbel punkt efter förkortat datum", async () => {
    const { sentences } = await import("./validation");
    expect(sentences("BL-001 har order till 1 nov.", "Välj senare.")).toBe(
      "BL-001 har order till 1 nov. Välj senare.",
    );
    expect(sentences("BL-001 startar 1 maj", "Välj senare.")).toBe(
      "BL-001 startar 1 maj. Välj senare.",
    );
  });
});

describe("driftstart och återaktivering", () => {
  const spans = [
    { id: "a", storeId: "s1", from: "2026-10-01", to: "2026-10-14" },
    { id: "b", storeId: "s2", from: "2026-10-15", to: "2026-10-31" },
  ];
  it("driftstarten får inte ligga efter första placeringen", () => {
    expect(placementBeforeStart(spans, "2026-10-13")).toBe("2026-10-01");
    expect(placementBeforeStart(spans, "2026-10-01")).toBeNull();
    expect(placementBeforeStart(spans, "2026-09-01")).toBeNull();
    expect(placementBeforeStart([], "2026-10-13")).toBeNull();
  });
  it("placeringen som avvecklingen avslutade öppnas igen", () => {
    expect(placementToReopen(spans, "2026-10-31")?.id).toBe("b");
    // Flyttades ut före sista dagen: ingen öppnas.
    expect(placementToReopen(spans, "2026-11-05")).toBeNull();
    expect(placementToReopen([], "2026-10-31")).toBeNull();
  });
});
