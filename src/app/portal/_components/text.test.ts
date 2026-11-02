import { describe, expect, it } from "vitest";

import { INCIDENT_KINDS, KIND_LABEL } from "@/app/(app)/inkorg/_lib/model";
import { ROLE_LABEL, ROLE_SUMMARY } from "@/app/(app)/installningar/anvandare/model";
import { FAULT_KINDS } from "@/server/portal/faults";

import { dateTimeText } from "./text";

describe("tider i portalen", () => {
  it("visas i organisationens tidszon, inte serverns", () => {
    const now = new Date("2026-11-02T12:00:00Z");
    // Vintertid: UTC+1.
    expect(dateTimeText("2026-11-02T10:35:00Z", "Europe/Stockholm", now)).toBe(
      "2 nov. 11:35".replace(" 11", " 11"),
    );
    // Sommartid: UTC+2.
    expect(dateTimeText("2026-07-01T10:35:00Z", "Europe/Stockholm", now)).toContain("12:35");
    // 23:30 UTC på nyårsafton är redan nyårsdagen i Stockholm: året avgörs i samma zon.
    const newYearsEve = new Date("2025-12-31T12:00:00Z");
    expect(dateTimeText("2025-12-31T23:30:00Z", "Europe/Stockholm", newYearsEve)).toBe(
      "1\u00a0jan.\u00a02026 00:30",
    );
  });
});

describe("felanmälan i Inkorgen", () => {
  it("varje typ butiken kan anmäla går att välja och har en svensk etikett i Inkorgen", () => {
    for (const k of FAULT_KINDS) {
      expect(INCIDENT_KINDS as readonly string[]).toContain(k);
      expect(KIND_LABEL[k]).toMatch(/^Butiken: /);
    }
  });
});

describe("butiksinbjudan", () => {
  it("rollen store har etikett och beskrivning på inbjudningssidan", () => {
    expect(ROLE_LABEL.store).toBe("Butik");
    expect(ROLE_SUMMARY.store).toContain("butiksportalen");
  });
});
