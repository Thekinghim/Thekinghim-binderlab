import { describe, expect, it } from "vitest";

import { DENIED_PARAM, deniedHref, deniedNotice } from "./nav";

/**
 * requireRoute skickar den som saknar behörighet till rollens startsida med ?nekad=<rutt>,
 * och skalet förklarar det i en notis (DeniedNotice) i stället för en tyst omdirigering.
 */
describe("nekad sida", () => {
  it("skickar till rollens startsida med rutten i ?nekad=", () => {
    expect(DENIED_PARAM).toBe("nekad");
    expect(deniedHref("viewer", "datakallor")).toBe("/?nekad=datakallor");
    expect(deniedHref("refiller", "lonsamhet")).toBe("/att-gora?nekad=lonsamhet");
  });

  it("förklarar vem sidan är för och vart användaren kom", () => {
    expect(deniedNotice("viewer", "datakallor")).toEqual({
      title: "Du har inte tillgång till Datakällor.",
      description:
        "Sidan är för ägare och administratör. Du är inloggad som läsare och kom till Hem i stället.",
    });
    expect(deniedNotice("refiller", "lonsamhet")?.description).toMatch(
      /^Sidan är för ägare, administratör och läsare\. Du är inloggad som påfyllare och kom till Att göra i stället\.$/,
    );
  });

  it("visar ingenting för ett okänt värde eller en sida rollen får se", () => {
    expect(deniedNotice("viewer", null)).toBeNull();
    expect(deniedNotice("viewer", "<script>")).toBeNull();
    expect(deniedNotice("owner", "datakallor")).toBeNull();
  });
});
