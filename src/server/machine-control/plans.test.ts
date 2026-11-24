/**
 * Styr automaten: de rena planerna (strömschema, mata ut, skärm och reklam, fyll fullt).
 * Inget anrop till Awish.
 */

import { describe, expect, it, vi } from "vitest";

import type { AwishProductDetail } from "@/server/awish/control/types";

vi.mock("server-only", () => ({}));

const ps = await import("./power-schedule");
const sh = await import("./shipment");
const mc = await import("./machine-config");
const rp = await import("./replenish");
const common = await import("./common");

const MID = "6b2a4a8e-8f1c-4b8e-9c1d-2a6f0b7c9d10";

function product(over: Partial<AwishProductDetail> = {}): AwishProductDetail {
  return {
    id: "71",
    machineId: "123",
    status: true,
    floorStatus: "ERR_NORMAL",
    lockStatus: null,
    currentInventory: 4,
    capacity: 10,
    goodId: "9",
    goodName: "Mystery Pack",
    channel: { id: "5", name: "A3", addr: "1", motorId: "13", floorType: 2, total: 10 },
    ...over,
  };
}

describe("strömschema", () => {
  it("veckodagarna mån..sön som 1/0", () => {
    expect(ps.weekdaysOf("1111111")).toEqual([1, 1, 1, 1, 1, 1, 1]);
    expect(ps.weekdaysOf("1111100")).toEqual([1, 1, 1, 1, 1, 0, 0]);
    expect(() => ps.weekdaysOf("111")).toThrow();
  });

  it("dagarna i text", () => {
    expect(ps.daysText("1111111")).toBe("mån–sön");
    expect(ps.daysText("1111100")).toBe("mån–fre");
    expect(ps.daysText("1010100")).toBe("mån, ons, fre");
    expect(ps.daysText("0000011")).toBe("lör, sön");
    expect(ps.daysText("0000001")).toBe("sön");
  });

  it("HH:MM blir HH:MM:SS", () => {
    expect(ps.toAwishTime("09:05")).toBe("09:05:00");
    expect(() => ps.toAwishTime("24:00")).toThrow();
    expect(() => ps.toAwishTime("9:00")).toThrow();
  });

  it("butikens tider förifyller alla dagar", () => {
    expect(ps.storePrefill("10:00", "21:00")).toEqual({
      days: "1111111",
      on: "10:00",
      off: "21:00",
    });
    expect(ps.storePrefill("9:00:00", "21:30")).toEqual({
      days: "1111111",
      on: "09:00",
      off: "21:30",
    });
    expect(ps.storePrefill("10:00", "10:00")).toBeNull();
    expect(ps.storePrefill(null, "21:00")).toBeNull();
    expect(ps.storePrefill("25:00", "21:00")).toBeNull();
  });

  it("spärr när Awish räknar i en annan tidszon", () => {
    expect(ps.timezoneBlock("Europe/Stockholm", "Europe/Stockholm")).toBeNull();
    expect(ps.timezoneBlock(null, "Europe/Stockholm")).toBeNull();
    expect(ps.timezoneBlock("Asia/Shanghai", "Europe/Stockholm")).toBe(
      "Awish-kontot räknar tid i Asia/Shanghai. Byt tidszon under Inställningar → Awish först.",
    );
  });

  it("planen: rad, källa och begäran", () => {
    const plan = ps.planPowerSchedule({
      input: { days: "1111111", on: "10:00", off: "21:00" },
      merchantTimezone: "Europe/Stockholm",
      orgTimezone: "Europe/Stockholm",
      store: { on: "10:00", off: "21:00" },
    });
    expect(plan.lines).toEqual(["Awish slår på 10:00 och av 21:00, mån–sön (Europe/Stockholm)."]);
    expect(plan.warnings).toEqual([]);
    expect(plan.blocking).toBeNull();
    expect(plan.source).toBe("store");
    expect(plan.request).toEqual({
      weekdays: [1, 1, 1, 1, 1, 1, 1],
      powerOn: "10:00:00",
      powerOff: "21:00:00",
    });
  });

  it("av efter midnatt varnar, egna tider är custom, fel tidszon spärrar", () => {
    const plan = ps.planPowerSchedule({
      input: { days: "1111100", on: "18:00", off: "02:00" },
      merchantTimezone: "Asia/Shanghai",
      orgTimezone: "Europe/Stockholm",
      store: { on: "10:00", off: "21:00" },
    });
    expect(plan.warnings).toContain("Av efter midnatt: stängs av natten efter.");
    expect(plan.source).toBe("custom");
    expect(plan.blocking).toMatch(/Asia\/Shanghai/);
  });

  it("indata: minst en dag, giltiga och olika tider", () => {
    const ok = { machineId: MID, days: "1000000", on: "10:00", off: "21:00" };
    expect(ps.powerScheduleInputSchema.safeParse(ok).success).toBe(true);
    expect(ps.powerScheduleInputSchema.safeParse({ ...ok, days: "0000000" }).success).toBe(false);
    expect(ps.powerScheduleInputSchema.safeParse({ ...ok, off: "10:00" }).success).toBe(false);
    expect(ps.powerScheduleInputSchema.safeParse({ ...ok, on: "10:0" }).success).toBe(false);
  });
});

describe("mata ut", () => {
  it("parametrar ur kanalen; code bara när namnet är ett tal", () => {
    expect(sh.shipmentParams(product())).toEqual({ addr: "1", motorIds: ["13"], floorType: 2 });
    const numeric = product({
      channel: { id: "5", name: "12", addr: "2", motorId: "7", floorType: 1, total: 10 },
    });
    expect(sh.shipmentParams(numeric)).toEqual({
      addr: "2",
      motorIds: ["7"],
      floorType: 1,
      code: "12",
    });
    expect("isLp" in sh.shipmentParams(numeric)).toBe(false);
  });

  it("utan kanal eller motor går det inte", () => {
    expect(() => sh.shipmentParams(product({ channel: null }))).toThrow(/motoruppgifter/);
    expect(() =>
      sh.shipmentParams(
        product({
          channel: { id: "5", name: "A3", addr: "1", motorId: " ", floorType: 2, total: 10 },
        }),
      ),
    ).toThrow(/motoruppgifter/);
  });

  it("anledning krävs (minst 5 tecken, högst 300)", () => {
    expect(() => sh.cleanReason("")).toThrow(/minst 5/);
    expect(() => sh.cleanReason("  kort ")).toThrow(/minst 5/);
    expect(sh.cleanReason("  Pack  fastnade\n i facket ")).toBe("Pack fastnade i facket");
    expect(() => sh.cleanReason("x".repeat(301))).toThrow(/högst 300/);
  });

  it("offline spärrar; tomt fack varnar", () => {
    const plan = sh.planShipment({
      product: product({ currentInventory: 0 }),
      online: false,
      code: "BL-003",
    });
    expect(plan.blocking).toBe("Automaten är offline. Det går bara när den är online.");
    expect(plan.warnings).toContain("Fack A3 är tomt enligt Awish.");
    expect(plan.lines[0]).toBe("BL-003: ett pack Mystery Pack matas ut ur Fack A3.");
  });

  it("skriven kod: skiftläge och mellanslag spelar ingen roll", () => {
    expect(common.typedMatches("bl-003", "BL-003")).toBe(true);
    expect(common.typedMatches(" BL-003 ", "BL-003")).toBe(true);
    expect(common.typedMatches("BL-002", "BL-003")).toBe(false);
    expect(common.typedMatches(undefined, "BL-003")).toBe(false);
  });
});

describe("skärm och reklam", () => {
  const input = {
    machineId: MID,
    standbyAdsEnabled: true,
    standbyAdsAutoplay: false,
    carouselAdsEnabled: true,
    standbyAdsSwitchInterval: 10,
    carouselAdsSwitchInterval: 15,
  };

  it("bara ändrade fält skickas", () => {
    const plan = mc.planMachineConfig(
      {
        volume: 60,
        brightness: 80,
        language: null,
        appVersion: null,
        standbyAdsEnabled: true,
        standbyAdsAutoplay: true,
        carouselAdsEnabled: true,
        standbyAdsSwitchInterval: 10,
        carouselAdsSwitchInterval: 10,
        temperature: null,
        uptimeMinutesToday: null,
      },
      input,
    );
    expect(plan.change).toEqual({ standbyAdsAutoplay: false, carouselAdsSwitchInterval: 15 });
    expect(plan.lines).toEqual([
      "Spela upp automatiskt: på → av.",
      "Byt bild i bildspelet var: 10 s → 15 s.",
    ]);
    expect(plan.unchanged).toBe(false);
  });

  it("intervallen 5–300 s", () => {
    expect(mc.machineConfigInputSchema.safeParse(input).success).toBe(true);
    expect(
      mc.machineConfigInputSchema.safeParse({ ...input, standbyAdsSwitchInterval: 4 }).success,
    ).toBe(false);
    expect(
      mc.machineConfigInputSchema.safeParse({ ...input, carouselAdsSwitchInterval: 301 }).success,
    ).toBe(false);
    expect(
      mc.machineConfigInputSchema.safeParse({ ...input, carouselAdsSwitchInterval: 7.5 }).success,
    ).toBe(false);
  });
});

describe("fyll fullt", () => {
  it("rader, redan fulla hoppas över, varning om lagret", () => {
    const products = [
      product(),
      product({ id: "72", currentInventory: 10, channel: { ...product().channel!, name: "A4" } }),
      product({ id: "73", capacity: 0, channel: { ...product().channel!, name: "A5" } }),
    ];
    const plan = rp.planReplenish(products, ["71", "72", "73", "71"]);
    expect(plan.ids).toEqual(["71"]);
    expect(plan.added).toBe(6);
    expect(plan.lines).toEqual(["A3 4 → 10", "Fack A4 är redan fullt (10)."]);
    expect(plan.warnings[0]).toBe(rp.REPLENISH_WARNING);
    expect(plan.blocking).toBeNull();
  });

  it("allt fullt spärrar; okänt fack kastar", () => {
    expect(rp.planReplenish([product({ currentInventory: 10 })], ["71"]).blocking).toBe(
      "Facken är redan fulla.",
    );
    expect(() => rp.planReplenish([product()], ["99"])).toThrow(/finns inte/);
  });
});
