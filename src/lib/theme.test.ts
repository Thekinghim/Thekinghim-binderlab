import { describe, expect, it } from "vitest";

import { readCookie, THEME_COOKIE, themeCookie, themeFromCookie } from "./theme";

/** Temat renderas på servern ur cookien: rätt data-theme i första svaret, utan inline-skript. */
describe("temats cookie", () => {
  it("mörkt är standard; bara light ger ljust", () => {
    expect(themeFromCookie(undefined)).toBe("dark");
    expect(themeFromCookie("dark")).toBe("dark");
    expect(themeFromCookie("light")).toBe("light");
    expect(themeFromCookie("<script>")).toBe("dark");
  });

  it("sparas för hela sajten i ett år, Secure på https", () => {
    expect(themeCookie("light", true)).toBe(
      `${THEME_COOKIE}=light; Path=/; Max-Age=31536000; SameSite=Lax; Secure`,
    );
    expect(themeCookie("dark", false)).not.toContain("Secure");
  });

  it("läses ur document.cookie", () => {
    expect(readCookie(`a=1; ${THEME_COOKIE}=light; b=2`, THEME_COOKIE)).toBe("light");
    expect(readCookie("a=1", THEME_COOKIE)).toBeNull();
  });
});
