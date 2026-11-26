import { describe, expect, it } from "vitest";

import { shownTabId } from "./tab-bar";

const TABS = ["hem", "automater", "rutt", "lager", "mer"];

describe("bottenradens tända flik", () => {
  it("följer adressen utan tryck", () => {
    expect(shownTabId("rutt", null, "/rutt", TABS)).toBe("rutt");
  });

  it("tänder den tryckta fliken direkt, innan sidan bytts", () => {
    expect(shownTabId("hem", { id: "mer", from: "/" }, "/", TABS)).toBe("mer");
  });

  it("släpper trycket när man står på en annan sida än där man tryckte", () => {
    expect(shownTabId("rutt", { id: "mer", from: "/" }, "/rutt", TABS)).toBe("rutt");
  });

  it("Butiker och Pengar tänder Mer när de inte har en egen flik", () => {
    expect(shownTabId("pengar", null, "/pengar", TABS)).toBe("mer");
    expect(shownTabId("butiker", null, "/butiker", TABS)).toBe("mer");
    expect(shownTabId("butiker", null, "/butiker", [...TABS, "butiker"])).toBe("butiker");
  });
});
