import { describe, expect, it } from "vitest";

import type { MachineHealth } from "@/analytics/health";

import { driftHeadline, figureText, firstSentence } from "./display";

function h(status: MachineHealth["status"], title = "Automat"): MachineHealth {
  return {
    machineId: title,
    status,
    label: status,
    source: "sales",
    since: null,
    title,
    detail: "",
    silence: null,
    signal: null,
    evidence: {
      rule: "",
      period: null,
      orderIds: [],
      dates: [],
      titleIds: [],
      machineIds: [],
      storeIds: [],
      recipientIds: [],
      figures: [],
    },
    link: "/",
  };
}

describe("rubriken på Drift", () => {
  it("alla i drift", () => {
    expect(driftHeadline([h("ok"), h("ok")]).title).toBe("Alla 2 automater är i drift.");
  });

  it("räknar bara automater i drift och nämner första problemet", () => {
    const r = driftHeadline([
      h("suspected_fault", "Automat 2 har inte sålt på 6 timmar"),
      h("ok"),
      h("inactive"),
      h("offline", "Automat 3"),
    ]);
    expect(r.title).toBe("1 av 3\u00a0automater i drift.");
    expect(r.aside).toBe("Automat 2 har inte sålt på 6 timmar. Och 1\u00a0automat till.");
  });

  it("inga automater", () => {
    expect(driftHeadline([]).title).toBe("Inga automater i drift.");
  });
});

describe("underlagets tal", () => {
  it("visar enheter men aldrig belopp", () => {
    expect(figureText({ value: 5, unit: "packs" })).toBe("5 pack");
    expect(figureText({ value: 62, unit: "tenths" })).toBe("6,2");
    expect(figureText({ value: 23, unit: "bp" })).toBe("0,23 %");
    expect(figureText({ value: 4900, unit: "ore" })).toBeNull();
    expect(firstSentence("Första. Andra.")).toBe("Första.");
  });
});
