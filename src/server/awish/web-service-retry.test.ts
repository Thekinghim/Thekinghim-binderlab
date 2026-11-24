/**
 * Nya försök vid skrivningar till Awish (Om Awish krånglar): withWriteRetry och väntetiden för
 * den automatiska körningen. Ingen nätverk, ingen databas.
 */
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/db/client", () => ({ getServiceDb: () => ({}) }));

const { AwishApiError } = await import("./grpc-client");
const { isRetryableAwishError, nextPushRetryAt, withWriteRetry, WRITE_RETRY_WAITS_MS } =
  await import("./web-service");

const unavailable = () => new AwishApiError("unavailable", "Awish svarar inte just nu.");

function failing(times: number, error: () => Error = unavailable) {
  let calls = 0;
  const op = vi.fn(async () => {
    calls += 1;
    if (calls <= times) throw error();
    return "ok";
  });
  return op;
}

describe("withWriteRetry", () => {
  it("idempotent skrivning: 503 två gånger, sedan lyckas den (väntar 0,5 och 1,5 s)", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const op = failing(2);
    await expect(withWriteRetry(op, { idempotent: true, sleep })).resolves.toBe("ok");
    expect(op).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1_500]);
  });

  it("ger upp efter fyra försök (0,5, 1,5 och 4 s) och kastar sista felet", async () => {
    const sleep = vi.fn(async (_ms: number) => {});
    const op = failing(10);
    await expect(withWriteRetry(op, { idempotent: true, sleep })).rejects.toMatchObject({
      kind: "unavailable",
    });
    expect(op).toHaveBeenCalledTimes(1 + WRITE_RETRY_WAITS_MS.length);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([...WRITE_RETRY_WAITS_MS]);
  });

  it("tidsgräns från Awish försöks också igen", async () => {
    const op = failing(1, () => new AwishApiError("timeout", "Awish svarade inte inom 15 s."));
    await expect(withWriteRetry(op, { idempotent: true, sleep: async () => {} })).resolves.toBe(
      "ok",
    );
  });

  it("nekad inloggning, ändrat API och Awish nej försöks aldrig igen", async () => {
    for (const kind of ["auth", "changed", "server"] as const) {
      const op = failing(1, () => new AwishApiError(kind, "nej"));
      await expect(withWriteRetry(op, { idempotent: true, sleep: async () => {} })).rejects.toThrow(
        "nej",
      );
      expect(op).toHaveBeenCalledTimes(1);
    }
  });

  it("en skrivning som inte tål att göras om (CreateGood) körs en gång", async () => {
    const op = failing(1);
    await expect(
      withWriteRetry(op, { idempotent: false, sleep: async () => {} }),
    ).rejects.toThrow();
    expect(op).toHaveBeenCalledTimes(1);
  });

  it("inget nytt försök när tiden till deadline inte räcker", async () => {
    let clock = 0;
    const sleep = vi.fn(async (ms: number) => {
      clock += ms;
    });
    const op = failing(10);
    await expect(
      withWriteRetry(op, { idempotent: true, sleep, now: () => clock, deadlineAt: 3_500 }),
    ).rejects.toThrow();
    // 0 + 0,5 + 1 s ryms; 0,5 + 1,5 + 1 s ryms (3 000); 2 000 + 4 000 ryms inte.
    expect(op).toHaveBeenCalledTimes(3);
    expect(sleep.mock.calls.map((c) => c[0])).toEqual([500, 1_500]);
  });

  it("isRetryableAwishError: bara unavailable och timeout", () => {
    expect(isRetryableAwishError(unavailable())).toBe(true);
    expect(isRetryableAwishError(new AwishApiError("timeout", "t"))).toBe(true);
    expect(isRetryableAwishError(new AwishApiError("auth", "a"))).toBe(false);
    expect(isRetryableAwishError(new Error("x"))).toBe(false);
  });
});

describe("nextPushRetryAt (väntetid per organisation)", () => {
  const failedAt = new Date("2026-11-24T08:00:00Z");
  const min = (d: Date) => (d.getTime() - failedAt.getTime()) / 60_000;

  it("första försöket 5 min efter felet", () => {
    expect(min(nextPushRetryAt(failedAt, 0, null))).toBe(5);
  });

  it("sedan 10, 20, 40 och 60 min efter förra försöket, och 60 därefter", () => {
    const last = new Date(failedAt.getTime() + 30 * 60_000);
    const after = (attempts: number) =>
      (nextPushRetryAt(failedAt, attempts, last).getTime() - last.getTime()) / 60_000;
    expect([1, 2, 3, 4, 5, 9].map(after)).toEqual([10, 20, 40, 60, 60, 60]);
  });
});

describe("429 och tiden för en sändning", () => {
  it("429 (rate_limited) försöks aldrig igen", async () => {
    const op = failing(1, () => new AwishApiError("rate_limited", "för många"));
    await expect(withWriteRetry(op, { idempotent: true, sleep: async () => {} })).rejects.toThrow(
      "för många",
    );
    expect(op).toHaveBeenCalledTimes(1);
    expect(isRetryableAwishError(new AwishApiError("rate_limited", "x"))).toBe(false);
  });

  it("25 s för en automat, 5 s till per automat, högst 45 s", async () => {
    const { interactivePushBudgetMs } = await import("./web-service");
    expect(interactivePushBudgetMs(1)).toBe(25_000);
    expect(interactivePushBudgetMs(3)).toBe(35_000);
    expect(interactivePushBudgetMs(20)).toBe(45_000);
  });
});
