import { describe, expect, it } from "vitest";
import { businessDateAt, clockTimeAt, parseInstant } from "./time";

describe("parseInstant", () => {
  it("tar Date, ms och ISO med Z eller offset", () => {
    expect(parseInstant("2026-11-01T16:17:00Z")).toBe(Date.UTC(2026, 10, 1, 16, 17));
    expect(parseInstant("2026-11-02T00:17:00+08:00")).toBe(Date.UTC(2026, 10, 1, 16, 17));
    expect(parseInstant(new Date(Date.UTC(2026, 0, 1)))).toBe(Date.UTC(2026, 0, 1));
    expect(parseInstant(5)).toBe(5);
  });

  it("avvisar tidpunkter utan tidszon och ogiltiga värden", () => {
    expect(() => parseInstant("2026-11-01T17:17:00")).toThrow(/tidszon/);
    expect(() => parseInstant("2026-11-01")).toThrow();
    expect(() => parseInstant("nonsens")).toThrow();
    expect(() => parseInstant(NaN)).toThrow();
    expect(() => parseInstant(new Date("x"))).toThrow();
  });
});

describe("businessDateAt", () => {
  it("order 42780: betald 1 nov. 17:17 svensk tid", () => {
    expect(businessDateAt("2026-11-01T16:17:00Z")).toBe("2026-11-01");
    expect(clockTimeAt("2026-11-01T16:17:00Z")).toBe("17:17");
  });

  it("dygnsgränsen följer svensk tid, vinter (+1) och sommar (+2)", () => {
    expect(businessDateAt("2026-10-31T23:30:00Z")).toBe("2026-11-01");
    expect(businessDateAt("2026-10-31T22:59:59Z")).toBe("2026-10-31");
    expect(businessDateAt("2026-07-01T22:30:00Z")).toBe("2026-07-02");
    expect(businessDateAt("2026-07-01T21:59:00Z")).toBe("2026-07-01");
    expect(clockTimeAt("2026-07-01T22:00:00Z")).toBe("00:00");
  });

  it("sommartidens slut 25 okt. 2026", () => {
    expect(clockTimeAt("2026-10-25T00:30:00Z")).toBe("02:30");
    expect(clockTimeAt("2026-10-25T01:30:00Z")).toBe("02:30");
    expect(businessDateAt("2026-10-25T22:59:00Z")).toBe("2026-10-25");
  });

  it("annan tidszon kan anges", () => {
    expect(businessDateAt("2026-11-01T16:17:00Z", "Asia/Shanghai")).toBe("2026-11-02");
    expect(businessDateAt("2026-11-01T16:17:00Z", "UTC")).toBe("2026-11-01");
  });
});
