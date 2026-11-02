import { describe, expect, it } from "vitest";

import { localToUtc, utcToLocalInput, validateIncident, type IncidentInput } from "./model";

const M = "11111111-1111-4111-8111-111111111111";
const U = "22222222-2222-4222-8222-222222222222";
const BASE: IncidentInput = {
  machineId: M,
  kind: "not_delivered",
  occurredAt: "2026-11-01T17:17",
  orderId: "",
  titleId: "",
  description: " Kunden fick inget pack. ",
  customerContact: "",
  status: "open",
  assigneeId: U,
  actionTaken: "",
  refunded: "",
  refundedOn: "2026-11-02",
};
const CTX = {
  timeZone: "Europe/Stockholm",
  now: new Date("2026-11-02T10:00:00Z"),
  machineIds: [M],
  memberIds: [U],
};

describe("kundärende: tid och belopp", () => {
  it("svensk tid i formuläret blir UTC och tillbaka", () => {
    expect(localToUtc("2026-11-01T17:17", "Europe/Stockholm")?.toISOString()).toBe(
      "2026-11-01T16:17:00.000Z",
    );
    expect(utcToLocalInput("2026-11-01T16:17:00Z", "Europe/Stockholm")).toBe("2026-11-01T17:17");
    expect(localToUtc("2026-11-01 17:17", "Europe/Stockholm")).toBeNull();
  });

  it("återbetalt belopp i kronor sparas i öre och kräver dag", () => {
    const r = validateIncident({ ...BASE, refunded: "49,50" }, CTX);
    expect(r.ok && r.values.refundedOre).toBe(4950);
    expect(r.ok && r.values.refundedOn).toBe("2026-11-02");
    expect(r.ok && r.values.description).toBe("Kunden fick inget pack.");
    const noDay = validateIncident({ ...BASE, refunded: "49", refundedOn: "" }, CTX);
    expect(noDay.ok).toBe(false);
    const bad = validateIncident({ ...BASE, refunded: "49.5.0" }, CTX);
    expect(bad.ok).toBe(false);
  });

  it("utan belopp sparas ingen återbetalningsdag", () => {
    const r = validateIncident(BASE, CTX);
    expect(r.ok && r.values.refundedOre).toBe(0);
    expect(r.ok && r.values.refundedOn).toBeNull();
  });

  it("löst kräver åtgärd; framtida tid, okänd automat och okänd ansvarig avvisas", () => {
    expect(validateIncident({ ...BASE, status: "resolved" }, CTX).ok).toBe(false);
    expect(
      validateIncident({ ...BASE, status: "resolved", actionTaken: "Swishade 49 kr." }, CTX).ok,
    ).toBe(true);
    expect(validateIncident({ ...BASE, occurredAt: "2026-11-03T10:00" }, CTX).ok).toBe(false);
    expect(validateIncident({ ...BASE, machineId: U }, CTX).ok).toBe(false);
    expect(validateIncident({ ...BASE, assigneeId: M }, CTX).ok).toBe(false);
  });
});

describe("kundärende: innehåll", () => {
  const O = "33333333-3333-4333-8333-333333333333";

  it("ett ärende utan beskrivning och order sparas inte", () => {
    const r = validateIncident({ ...BASE, description: "   " }, CTX);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors.description).toMatch(/Beskriv/);
    expect(validateIncident({ ...BASE, description: "", orderId: O }, CTX).ok).toBe(true);
  });

  it("återbetalning större än orderns belopp avvisas", () => {
    const input = { ...BASE, orderId: O, refunded: "59", refundedOn: "2026-11-02" };
    const over = validateIncident(input, { ...CTX, orderAmountOre: 4900 });
    expect(over.ok).toBe(false);
    if (!over.ok) expect(over.errors.refunded).toMatch(/orderns belopp/);
    expect(
      validateIncident({ ...input, refunded: "49" }, { ...CTX, orderAmountOre: 4900 }).ok,
    ).toBe(true);
  });
});
