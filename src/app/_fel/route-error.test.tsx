import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RouteError, clientErrorText } from "./route-error";

describe("RouteError (app/error.tsx, (app)/error.tsx, global-error.tsx)", () => {
  it("säger neutralt att ett fel stoppade sidan, aldrig serverns felmeddelande", () => {
    const error = Object.assign(new Error("Failed query: select * from orders"), {
      digest: "42",
    });
    const html = renderToStaticMarkup(<RouteError error={error} retry={() => {}} />);
    expect(html).toContain("Sidan kunde inte laddas.");
    expect(html).toContain("Ett fel stoppade sidan");
    // Felet kan vara ett programfel lika väl som en databas som inte svarar.
    expect(html).not.toContain("Servern fick inget svar");
    expect(html).not.toContain("Failed query");
  });

  it("clientErrorText: telefonens eget fel visas, serverns aldrig", () => {
    const server = Object.assign(new Error("Failed query"), { digest: "42" });
    expect(clientErrorText(server)).toBeNull();
    const e = new TypeError("undefined is not an object (evaluating 'a.b')");
    e.stack =
      "TypeError: undefined is not an object (evaluating 'a.b')\nrender@https://x/_next/static/chunks/a.js:1:200\nmore@b";
    expect(clientErrorText(e)).toBe(
      "TypeError: undefined is not an object (evaluating 'a.b') · render@https://x/_next/static/chunks/a.js:1:200",
    );
    const safari = new Error("boom");
    safari.stack = "render@https://x/a.js:1:2";
    expect(clientErrorText(safari)).toBe("Error: boom · render@https://x/a.js:1:2");
    expect(clientErrorText("x".repeat(500))).toHaveLength(300);
    expect(clientErrorText(null)).toBeNull();
  });
});
