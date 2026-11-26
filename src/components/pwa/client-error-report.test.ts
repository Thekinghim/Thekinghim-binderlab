import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Det lilla av webbläsaren som rapporten läser (testerna kör i node). */
function fakeBrowser(): EventTarget {
  const win = Object.assign(new EventTarget(), {
    location: { pathname: "/drift", search: "?x=1" },
    matchMedia: () => ({ matches: false }),
  });
  vi.stubGlobal("window", win);
  vi.stubGlobal("navigator", { userAgent: "Testtelefon", onLine: true });
  vi.stubGlobal("document", { visibilityState: "visible" });
  return win;
}

describe("klientfel: rapporten från webbläsaren", () => {
  let fetchMock: ReturnType<typeof vi.fn>;
  let win: EventTarget;

  beforeEach(() => {
    vi.resetModules();
    fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
    vi.stubGlobal("fetch", fetchMock);
    win = fakeBrowser();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("skickar en gång per fel, med sökvägen utan frågesträng", async () => {
    const { reportClientError } = await import("./client-error-report");
    const e = new TypeError("undefined is not an object");
    reportClientError(e, "boundary");
    reportClientError(e, "boundary");
    reportClientError(e, "error");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/klientfel");
    const body = JSON.parse(String(init.body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      path: "/drift",
      message: "TypeError: undefined is not an object",
      extra: { source: "boundary", online: true, standalone: false, visibility: "visible" },
    });
    expect(typeof body.buildId).toBe("string");
  });

  it("högst 5 fel utan felruta per sidladdning, felrutan räknas inte dit", async () => {
    const { reportClientError } = await import("./client-error-report");
    for (let i = 0; i < 10; i += 1) reportClientError(new Error(`w${i}`), "unhandledrejection");
    expect(fetchMock).toHaveBeenCalledTimes(5);
    reportClientError(new Error("b"), "boundary");
    expect(fetchMock).toHaveBeenCalledTimes(6);
  });

  it("ViewportPin: mått skickas högst en gång per tio minuter, även utan sessionStorage", async () => {
    const { reportViewportSample } = await import("./client-error-report");
    const { reportDue } = await import("@/components/v2/shell/viewport-pin-telemetry");
    const vp = { cols: "ev,inner", screen: 852, rows: ["visible,793"] };
    reportViewportSample("shift", vp, reportDue);
    reportViewportSample("shift", vp, reportDue);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const body = JSON.parse(String((fetchMock.mock.calls[0] as [string, RequestInit])[1].body));
    expect(body).toMatchObject({
      path: "/drift",
      message: "ViewportPin: shift",
      stack: "ev,inner\nvisible,793",
      extra: { source: "viewport", vp },
    });
    // sessionStorage som kastar: tiden i minnet gäller, och inget kastas.
    Object.assign(window, {
      sessionStorage: {
        getItem: () => {
          throw new Error("nej");
        },
      },
    });
    expect(() => reportViewportSample("shift", vp, reportDue)).not.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("kastar aldrig, inte ens när fetch kastar eller nätet är nere", async () => {
    vi.stubGlobal("fetch", () => {
      throw new Error("offline");
    });
    const { reportClientError } = await import("./client-error-report");
    expect(() => reportClientError(new Error("x"), "boundary")).not.toThrow();
    vi.stubGlobal("fetch", () => Promise.reject(new Error("offline")));
    expect(() => reportClientError(new Error("y"), "boundary")).not.toThrow();
  });

  it("lyssnar på ohanterade fel och avvisade löften en gång", async () => {
    const { listenForUncaughtErrors } = await import("./client-error-report");
    listenForUncaughtErrors();
    listenForUncaughtErrors();
    const error = Object.assign(new Event("error"), {
      error: new Error("ohanterat"),
      message: "ohanterat",
    });
    win.dispatchEvent(error);
    // En bild som inte kunde hämtas: inget fel och inget meddelande, skickas inte.
    win.dispatchEvent(new Event("error"));
    const rejection = Object.assign(new Event("unhandledrejection"), {
      reason: new Error("avvisat"),
    });
    win.dispatchEvent(rejection);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    const sources = fetchMock.mock.calls.map(
      (c) =>
        (JSON.parse(String((c[1] as RequestInit).body)) as { extra: { source: string } }).extra
          .source,
    );
    expect(sources).toEqual(["error", "unhandledrejection"]);
  });
});
