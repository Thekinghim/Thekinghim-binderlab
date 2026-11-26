import { beforeEach, describe, expect, it } from "vitest";

import { canGoBackInApp, nextHistory, recordPath, resetHistoryForTests } from "./back-history";

describe("appens historik för tillbaka-pilen", () => {
  beforeEach(() => resetHistoryForTests());

  it("ny sida läggs till, samma sida två gånger räknas en gång", () => {
    expect(nextHistory([], "/")).toEqual(["/"]);
    expect(nextHistory(["/"], "/")).toEqual(["/"]);
    expect(nextHistory(["/"], "/mer")).toEqual(["/", "/mer"]);
  });

  it("sidan före den senaste räknas som ett steg bakåt", () => {
    expect(nextHistory(["/", "/mer", "/pengar"], "/mer")).toEqual(["/", "/mer"]);
  });

  it("direkt öppnad sida har inget att backa till", () => {
    recordPath("/pengar");
    expect(canGoBackInApp()).toBe(false);
    recordPath("/pengar/utbetalningar");
    expect(canGoBackInApp()).toBe(true);
    recordPath("/pengar");
    expect(canGoBackInApp()).toBe(false);
  });
});
