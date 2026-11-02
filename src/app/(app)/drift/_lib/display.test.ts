import { describe, expect, it } from "vitest";

import type { MachineHealth } from "@/analytics/health";

import { alertHeadline, driftHeadline, figureText, firstSentence, sortAlerts } from "./display";

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
    expect(firstSentence("Senaste försäljning sön 1 nov. 17:09. Under tystnaden.")).toBe(
      "Senaste försäljning sön 1 nov. 17:09.",
    );
  });
});

describe("larmen på Drift", () => {
  const a = (
    id: string,
    over: Partial<{
      kind: string;
      severity: string;
      machineId: string;
      dates: string[];
      openedAt: string;
    }> = {},
  ) => ({
    id,
    kind: over.kind ?? "low_stock",
    severity: over.severity ?? "warning",
    machineId: over.machineId ?? "m1",
    title: `Larm ${id}`,
    openedAt: over.openedAt ?? "2026-11-02T10:00:00Z",
    evidence: { dates: over.dates ?? [] },
  });

  it("sorterar kritiska först och sedan på beräknat slutdatum", () => {
    const sorted = sortAlerts([
      a("tor", { dates: ["2026-11-05"] }),
      a("ons", { dates: ["2026-11-04"] }),
      a("utan"),
      a("slut", { severity: "critical" }),
    ]);
    expect(sorted.map((x) => x.id)).toEqual(["slut", "ons", "tor", "utan"]);
  });

  it("rubriken säger vad som tar slut och när", () => {
    expect(
      alertHeadline([
        a("1", { machineId: "m1", dates: ["2026-11-04"] }),
        a("2", { machineId: "m2", dates: ["2026-11-05"] }),
        a("3", { machineId: "m2", dates: ["2026-11-04"] }),
      ]),
    ).toBe("3\u00a0titlar i 2\u00a0automater tar slut senast tor 5\u00a0nov.");
    expect(alertHeadline([a("1", { severity: "critical" })])).toBe(
      "1\u00a0titel är slut i 1\u00a0automat.",
    );
    expect(alertHeadline([a("1", { kind: "import_failed" })])).toBe("1\u00a0öppet larm: Larm 1.");
    expect(alertHeadline([])).toBeNull();
  });
});
