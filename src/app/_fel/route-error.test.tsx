import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { RouteError } from "./route-error";

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
});
