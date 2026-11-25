import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getSessionUser = vi.fn();
const saveClientErrorFor = vi.fn();

vi.mock("@/server/session", () => ({ getSessionUser: () => getSessionUser() }));
vi.mock("@/server/client-errors/report", () => ({
  saveClientErrorFor: (...args: unknown[]) => saveClientErrorFor(...args),
}));
vi.mock("@/server/auth/flows", () => ({ ACTIVE_ORG_COOKIE: "bl_org" }));

const { POST } = await import("./route");

const BODY = JSON.stringify({ path: "/", message: "TypeError: x" });

function post(headers: Record<string, string>, body = BODY): NextRequest {
  // Next bakom Vercel: adressen kan ha en annan värd än den som telefonen ser.
  return new NextRequest("http://intern.local/api/klientfel", {
    method: "POST",
    headers: { host: "app.example.se", "content-type": "application/json", ...headers },
    body,
  });
}

describe("POST /api/klientfel", () => {
  beforeEach(() => {
    getSessionUser.mockReset().mockResolvedValue({ id: "u1" });
    saveClientErrorFor.mockReset().mockResolvedValue(true);
  });

  it("godtar appens eget ursprung (värden, inte den interna adressen)", async () => {
    const res = await POST(
      post({
        origin: "https://app.example.se",
        "sec-fetch-site": "same-origin",
        cookie: "bl_org=o1",
      }),
    );
    expect(res.status).toBe(204);
    expect(saveClientErrorFor).toHaveBeenCalledWith({ id: "u1" }, "o1", {
      path: "/",
      message: "TypeError: x",
    });
  });

  it("x-forwarded-host vinner över host", async () => {
    const res = await POST(
      post({ origin: "https://binderlab.se", "x-forwarded-host": "binderlab.se" }),
    );
    expect(res.status).toBe(204);
    expect(saveClientErrorFor).toHaveBeenCalledTimes(1);
  });

  it("avvisar andra webbplatser och okänt ursprung", async () => {
    const cases: Record<string, string>[] = [
      { origin: "https://ond.example" },
      { origin: "null" },
      { "sec-fetch-site": "cross-site" },
      { "sec-fetch-site": "same-site", origin: "https://app.example.se" },
    ];
    for (const headers of cases) {
      const res = await POST(post(headers));
      expect(res.status).toBe(403);
    }
    expect(saveClientErrorFor).not.toHaveBeenCalled();
  });

  it("utloggad, för stor kropp eller ogiltig JSON: 204 utan rad", async () => {
    getSessionUser.mockResolvedValueOnce(null);
    expect((await POST(post({}))).status).toBe(204);
    expect((await POST(post({}, "x".repeat(20_000)))).status).toBe(204);
    expect((await POST(post({}, "{inte json"))).status).toBe(204);
    expect(saveClientErrorFor).not.toHaveBeenCalled();
  });

  it("kastar aldrig, även när sparandet kastar", async () => {
    saveClientErrorFor.mockRejectedValueOnce(new Error("db"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect((await POST(post({}))).status).toBe(204);
    spy.mockRestore();
  });
});
