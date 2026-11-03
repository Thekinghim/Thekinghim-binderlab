import { describe, expect, it } from "vitest";

import {
  discoveredMachineAlerts,
  discoveredMachineKey,
  matchesSubscription,
  type AlertNotification,
} from "@/analytics/alerts";

import { applyNoticeChange, noticeState, noticeTypesFor, NOTICE_TYPES } from "./notices";
import { defaultSubscription, rowToSubscription, type SubscriptionRow } from "./subscriptions";

const OWNER = { userId: "u1", role: "owner" };
const REFILLER = { userId: "u2", role: "refiller" };

function apply(
  row: SubscriptionRow | null,
  change: Parameters<typeof applyNoticeChange>[1],
  ctx = OWNER,
) {
  const r = applyNoticeChange(row, change, ctx);
  if (!r.ok) throw new Error(r.error);
  return r.row;
}

describe("notiser: typer per roll", () => {
  it("ägaren ser fyra typer, påfyllaren två", () => {
    expect(noticeTypesFor("owner").map((t) => t.value)).toEqual([
      "empty",
      "silent",
      "stopped",
      "discovered",
    ]);
    expect(noticeTypesFor("admin")).toHaveLength(4);
    expect(noticeTypesFor("refiller").map((t) => t.value)).toEqual(["empty", "silent"]);
    expect(noticeTypesFor("viewer").map((t) => t.value)).toEqual(["empty", "silent"]);
  });

  it("varje typ har minst en larmtyp och inga dubbletter", () => {
    const all = NOTICE_TYPES.flatMap((t) => t.kinds);
    expect(new Set(all).size).toBe(all.length);
    expect(NOTICE_TYPES.every((t) => t.kinds.length > 0)).toBe(true);
  });
});

describe("notiser: läge", () => {
  it("inget sparat: av, alla typer förvalda", () => {
    expect(noticeState(null, "owner")).toEqual({
      on: false,
      types: ["empty", "silent", "stopped", "discovered"],
    });
  });

  it("standardraden är på (push och e-post, alla larm)", () => {
    expect(noticeState(defaultSubscription("u1", "owner"), "owner").on).toBe(true);
  });

  it("av när push saknas eller prenumerationen är avstängd", () => {
    const base = defaultSubscription("u1", "owner");
    expect(noticeState({ ...base, channels: ["email"] }, "owner").on).toBe(false);
    expect(noticeState({ ...base, active: false }, "owner").on).toBe(false);
  });

  it("en typ är vald bara om alla dess larmtyper är valda", () => {
    const base = defaultSubscription("u1", "owner");
    const s = noticeState({ ...base, kinds: ["low_stock", "machine_offline"] }, "owner");
    expect(s.types).toEqual(["empty"]);
  });
});

describe("notiser: på/av", () => {
  it("på utan sparad rad ger standardraden med push", () => {
    const row = apply(null, { on: true });
    expect(row.active).toBe(true);
    expect(row.channels).toEqual(["push", "email"]);
    expect(row.kinds).toBeNull();
  });

  it("på lägger till push först och behåller övriga kanaler", () => {
    const base = { ...defaultSubscription("u1", "owner"), channels: ["email"], active: false };
    const row = apply(base, { on: true });
    expect(row.channels).toEqual(["push", "email"]);
    expect(row.active).toBe(true);
  });

  it("av tar bort push men behåller e-post och resten", () => {
    const base = { ...defaultSubscription("u1", "owner"), quietStart: "21:00", quietEnd: "06:00" };
    const row = apply(base, { on: false });
    expect(row.channels).toEqual(["email"]);
    expect(row.active).toBe(true);
    expect(row.quietStart).toBe("21:00");
    expect(noticeState(row, "owner").on).toBe(false);
  });

  it("av när push är enda kanalen stänger av prenumerationen", () => {
    const base = { ...defaultSubscription("u1", "owner"), channels: ["push"] };
    const row = apply(base, { on: false });
    expect(row.active).toBe(false);
    expect(row.channels).toEqual(["push"]);
    expect(noticeState(row, "owner").on).toBe(false);
    // På igen.
    expect(noticeState(apply(row, { on: true }), "owner").on).toBe(true);
  });
});

describe("notiser: typer", () => {
  it("alla typer = alla larm", () => {
    const base = { ...defaultSubscription("u1", "owner"), kinds: ["low_stock"] };
    expect(apply(base, { types: ["empty", "silent", "stopped", "discovered"] }).kinds).toBeNull();
  });

  it("en del av typerna behåller avvikande dag (syns inte i det enkla läget)", () => {
    const row = apply(defaultSubscription("u1", "owner"), { types: ["empty", "discovered"] });
    expect(row.kinds).toEqual(["low_stock", "machine_discovered", "day_anomaly"]);
    expect(noticeState(row, "owner").types).toEqual(["empty", "discovered"]);
  });

  it("en uttryckligt bortvald avvikande dag kommer inte tillbaka", () => {
    const base = { ...defaultSubscription("u1", "owner"), kinds: ["low_stock", "import_failed"] };
    expect(apply(base, { types: ["stopped"] }).kinds).toEqual(["import_failed"]);
  });

  it("ingen typ vald ger fel", () => {
    const r = applyNoticeChange(defaultSubscription("u1", "owner"), { types: [] }, OWNER);
    expect(r).toEqual({ ok: false, error: "Välj minst en typ." });
  });

  it("okända typer och typer rollen inte får ignoreras", () => {
    const r = applyNoticeChange(null, { types: ["discovered", "hack"] }, REFILLER);
    expect(r.ok).toBe(false);
    const row = apply(null, { types: ["silent", "discovered"] }, REFILLER);
    expect(row.kinds).toEqual(["machine_suspected_fault", "machine_offline", "machine_fault"]);
  });

  it("påfyllaren med alla sina typer får en uttrycklig lista (krav i databasen)", () => {
    const row = apply(null, { types: ["empty", "silent"] }, REFILLER);
    expect(row.kinds).toEqual([
      "low_stock",
      "machine_suspected_fault",
      "machine_offline",
      "machine_fault",
    ]);
  });
});

describe("larm: ny automat hittad", () => {
  it("ger en varning per automat med stabil nyckel och länk till Att göra", () => {
    const [c, d] = discoveredMachineAlerts([
      { id: "s1", name: "Automat 8812", orders: 3 },
      { id: "s2", name: "  ", orders: 0 },
    ]);
    expect(c).toMatchObject({
      key: discoveredMachineKey("s1"),
      kind: "machine_discovered",
      severity: "warning",
      machineId: null,
      title: "Ny automat hittad: Automat 8812",
      detail: "3\u00a0köp väntar. Välj butik.",
      link: "/att-gora",
    });
    expect(d?.title).toBe("Ny automat hittad: utan namn");
    expect(d?.detail).toBe("Välj butik.");
  });

  it("når den som valt typen och inte den som valt bort den", () => {
    const [c] = discoveredMachineAlerts([{ id: "s1", name: "X", orders: 1 }]);
    const n: AlertNotification = {
      incidentId: "i1",
      key: c!.key,
      kind: c!.kind,
      severity: c!.severity,
      reason: "new",
      machineId: null,
      titleId: null,
      title: c!.title,
      detail: c!.detail,
      at: "2026-11-03T10:00:00Z",
      evidence: c!.evidence,
      link: c!.link,
    };
    const on = rowToSubscription(apply(null, { on: true }));
    const off = rowToSubscription(
      apply(defaultSubscription("u1", "owner"), { types: ["empty", "silent"] }),
    );
    expect(matchesSubscription(n, on)).toBe(true);
    expect(matchesSubscription(n, off)).toBe(false);
  });
});
