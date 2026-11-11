/**
 * Beskedet efter Klar i Fyll på: det gäller automaterna som just fylldes på. En annan automat
 * som väntade sedan förut och försöktes igen i samma körning ändrar inte beskedet, men står
 * kvar bland de som inte gick fram.
 */
import { describe, expect, it } from "vitest";

import { summariseAwishPush } from "./push-status";
import type { MachinePushResult, WebPushResult } from "./web-service";

const machine = (
  machineId: string,
  status: MachinePushResult["status"],
  slotsUpdated = 0,
): MachinePushResult => ({
  machineId,
  machineCode: machineId,
  status,
  slotsUpdated,
  titlesWithoutSlot: [],
  ...(status === "error" ? { error: "Awish svarar inte" } : {}),
});
const done = (...machines: MachinePushResult[]): WebPushResult => ({ status: "done", machines });

describe("summariseAwishPush", () => {
  it("push avstängd: inget besked", () => {
    expect(summariseAwishPush({ status: "off", reason: "disabled", machines: [] })).toBeUndefined();
  });

  it("den påfyllda automaten gick fram, en annan väntar fortfarande: 'skickat', inte 'gick inte'", () => {
    const out = summariseAwishPush(done(machine("a", "pushed", 2), machine("b", "error")), ["a"]);
    expect(out).toMatchObject({ state: "sent", kind: "sent", slots: 2 });
    expect(out?.message).toBe("Sparat och skickat till Awish (2 fack).");
    // Raden på den andra automaten ligger kvar.
    expect(out?.failedMachineIds).toEqual(["b"]);
  });

  it("den påfyllda automaten gick inte fram: felet, och alla som väntar", () => {
    const out = summariseAwishPush(done(machine("a", "error"), machine("b", "error")), ["a"]);
    expect(out).toMatchObject({ state: "partial", kind: "partial" });
    expect(out?.message).toContain("Till Awish gick det inte: Awish svarar inte.");
    expect(out?.message).toContain("Tryck Försök igen på automaten.");
    expect(out?.failedMachineIds).toEqual(["a", "b"]);
  });

  it("fack från en automat som väntade räknas inte in i den påfylldas antal", () => {
    const out = summariseAwishPush(done(machine("a", "nothing"), machine("b", "pushed", 3)), ["a"]);
    expect(out).toMatchObject({ state: "sent", kind: "alreadyRight" });
    expect(out?.failedMachineIds).toBeUndefined();
  });

  it("utan urval gäller beskedet alla automater i körningen (Försök igen)", () => {
    const out = summariseAwishPush(done(machine("a", "pushed", 1), machine("b", "error")));
    expect(out).toMatchObject({ state: "partial", failedMachineIds: ["b"] });
  });
});
