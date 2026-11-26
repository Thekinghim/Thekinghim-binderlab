import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fetchPageTips, whenIdleAfterInteraction } from "./page-tips-client";

/** Förslagen hämtas med GET efter första trycket, aldrig vid start. */
describe("fetchPageTips", () => {
  it("läser förslagen ur GET /assistent/tips", async () => {
    const fetcher = vi.fn(async () => Response.json({ hem: { id: "t1" } }));
    await expect(fetchPageTips(undefined, fetcher as typeof fetch)).resolves.toEqual({
      hem: { id: "t1" },
    });
    expect(fetcher).toHaveBeenCalledWith(
      "/assistent/tips",
      expect.objectContaining({ cache: "no-store" }),
    );
  });

  it("inga förslag vid fel eller konstigt svar", async () => {
    const down = vi.fn(async () => new Response("nej", { status: 500 }));
    await expect(fetchPageTips(undefined, down as typeof fetch)).resolves.toEqual({});
    const list = vi.fn(async () => Response.json([1, 2]));
    await expect(fetchPageTips(undefined, list as typeof fetch)).resolves.toEqual({});
    const broken = vi.fn(async () => Promise.reject(new Error("nät")));
    await expect(fetchPageTips(undefined, broken as typeof fetch)).resolves.toEqual({});
  });
});

describe("whenIdleAfterInteraction", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function fakeWindow() {
    const target = new EventTarget();
    return Object.assign(target, {
      requestIdleCallback: (cb: () => void) => setTimeout(cb, 10) as unknown as number,
      cancelIdleCallback: (id: number) => clearTimeout(id),
    }) as unknown as Window;
  }

  it("väntar på första trycket och sedan på ledig tid", () => {
    const w = fakeWindow();
    const run = vi.fn();
    whenIdleAfterInteraction(run, { fallbackMs: 60_000 }, w);
    vi.advanceTimersByTime(5_000);
    expect(run).not.toHaveBeenCalled();
    w.dispatchEvent(new Event("pointerdown"));
    w.dispatchEvent(new Event("scroll"));
    vi.advanceTimersByTime(20);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it("utan tryck: efter reservtiden ändå, och kan avbrytas", () => {
    const w = fakeWindow();
    const run = vi.fn();
    whenIdleAfterInteraction(run, { fallbackMs: 1_000 }, w);
    vi.advanceTimersByTime(1_020);
    expect(run).toHaveBeenCalledTimes(1);

    const later = vi.fn();
    const stop = whenIdleAfterInteraction(later, { fallbackMs: 1_000 }, w);
    stop();
    w.dispatchEvent(new Event("keydown"));
    vi.advanceTimersByTime(2_000);
    expect(later).not.toHaveBeenCalled();
  });
});
