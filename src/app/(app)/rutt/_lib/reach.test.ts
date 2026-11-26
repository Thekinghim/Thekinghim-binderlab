import { describe, expect, it, vi } from "vitest";

import { NO_CONTACT, reach } from "./reach";

describe("reach (Rutt utan täckning)", () => {
  it("ger svaret vidare när servern svarar", async () => {
    await expect(reach(async () => ({ ok: true as const, data: 1 }))).resolves.toEqual({
      ok: true,
      data: 1,
    });
    await expect(reach(async () => ({ ok: false as const, error: "Nej" }))).resolves.toEqual({
      ok: false,
      error: "Nej",
    });
  });

  it("gör ett kastat fel (ingen täckning) till ett felsvar i stället för att krascha sidan", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const r = await reach<{ id: string }>(() => Promise.reject(new TypeError("Failed to fetch")));
    expect(r).toEqual({ ok: false, error: NO_CONTACT });
    spy.mockRestore();
  });
});
