import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { FILL_READ_INTERVAL_MS, fillReadDue, parseState } = await import("./sync");

describe("Uppdatera i Fyll på: spärren per organisation", () => {
  const now = new Date("2026-11-06T13:52:00Z");
  it("aldrig läst: får läsa", () => {
    expect(fillReadDue({ fillReadAt: null }, now)).toBe(true);
  });
  it("högst en läsning per 20 s", () => {
    expect(FILL_READ_INTERVAL_MS).toBe(20_000);
    expect(fillReadDue({ fillReadAt: "2026-11-06T13:51:59Z" }, now)).toBe(false);
    expect(fillReadDue({ fillReadAt: "2026-11-06T13:51:41Z" }, now)).toBe(false);
    expect(fillReadDue({ fillReadAt: "2026-11-06T13:51:40Z" }, now)).toBe(true);
  });
  it("en egen gräns kan ges", () => {
    expect(fillReadDue({ fillReadAt: "2026-11-06T13:51:00Z" }, now, 120_000)).toBe(false);
  });
  it("trasig eller framtida tidpunkt spärrar inte", () => {
    expect(fillReadDue({ fillReadAt: "inte en tid" }, now)).toBe(true);
    expect(fillReadDue({ fillReadAt: "2026-11-06T14:52:00Z" }, now)).toBe(true);
  });
  it("läget sparar tidpunkten (och saknas den i ett gammalt läge blir den null)", () => {
    expect(parseState(JSON.stringify({ fillReadAt: "2026-11-06T13:51:00Z" })).fillReadAt).toBe(
      "2026-11-06T13:51:00Z",
    );
    expect(parseState("{}").fillReadAt).toBeNull();
  });
});
