import { describe, expect, it } from "vitest";

import { newSubmitId, submitIds } from "./use-submit-ids";

describe("submitIds", () => {
  it("samma innehåll ger samma id tills svaret kommit, sedan ett nytt", () => {
    let n = 0;
    const ids = submitIds(() => `id-${++n}`);
    expect(ids.idFor("36|hemma")).toBe("id-1");
    // Nytt försök efter ett svar som aldrig kom fram: samma id.
    expect(ids.idFor("36|hemma")).toBe("id-1");
    // Ändrat antal är ett annat inskick.
    expect(ids.idFor("40|hemma")).toBe("id-2");
    ids.done();
    expect(ids.idFor("36|hemma")).toBe("id-3");
  });

  it("newSubmitId ger ett v4-id", () => {
    expect(newSubmitId()).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
