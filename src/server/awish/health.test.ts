import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { breakerMinutes, describeError, safeErrorText } = await import("./health");
const { AwishApiError } = await import("./grpc-client");
const { sameSlotIds } = await import("./stock");
const { stockStep } = await import("./sync");

describe("hälsan per Awish-väg", () => {
  it("brytarens tid: 15 min för internt fel/nere/tidsgräns, 6 h för inloggning och ändrat API", () => {
    expect(breakerMinutes("server")).toBe(15);
    expect(breakerMinutes("unavailable")).toBe(15);
    expect(breakerMinutes("timeout")).toBe(15);
    expect(breakerMinutes("auth")).toBe(360);
    expect(breakerMinutes("changed")).toBe(360);
    expect(breakerMinutes("budget")).toBeNull();
    expect(breakerMinutes("not_found")).toBeNull();
  });

  it("feltexten kortas och visar aldrig token, lösenord eller frågesträngar", () => {
    const text = safeErrorText(
      "fel https://dash.awish.vip/graphql?token=abc123&x=1 Bearer eyJhbGciOiJIUzI1NiJ9.abcdefghijklmnopqrstuvwxyz password=hemligt " +
        "x".repeat(400),
    );
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text).not.toMatch(/abc123|eyJhbGci|hemligt/);
    expect(text).toContain("https://dash.awish.vip/graphql");
  });

  it("felets art och gRPC-kod", () => {
    expect(
      describeError(new AwishApiError("server", "Awish svarade med ett fel", 13)),
    ).toMatchObject({ kind: "server", code: 13 });
    expect(describeError(new Error("x")).kind).toBe("internal");
  });

  it("id-kontrollen: samma fack-id och kanal i båda listorna", () => {
    const p = (id: string, channel: string) => ({
      id,
      machineId: "2",
      channel,
      goodId: null,
      goodName: "X",
      currentInventory: 1,
      capacity: 8,
    });
    expect(sameSlotIds([p("1", "A1"), p("2", "A2")], [p("2", "A2"), p("1", "A1")])).toBe(true);
    expect(sameSlotIds([p("1", "A1")], [p("101", "A1")])).toBe(false);
    expect(sameSlotIds([p("1", "A1")], [p("1", "A2")])).toBe(false);
    expect(sameSlotIds([], [])).toBe(false);
  });

  it("facksteget i lastRun", () => {
    const base = { machines: 2, counts: 0, titlesCreated: 0, deferred: 0, at: "x" };
    expect(stockStep({ ...base, read: 2, failed: 0 })).toEqual({ ok: true, via: "open_api" });
    expect(stockStep({ ...base, read: 2, failed: 0, viaWeb: 1 })).toEqual({
      ok: true,
      via: "webbpanelen",
    });
    expect(stockStep({ ...base, read: 0, failed: 2, error: "awish: server 13 x" })).toEqual({
      ok: false,
      via: "senast_kanda",
      errorKind: "server",
    });
  });
});
