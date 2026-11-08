import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { APP_REDIRECTS } from "./redirects";

describe("APP_REDIRECTS", () => {
  it("/kontrakt skickas vidare till /avtal utan en egen sida (inget extra varv)", () => {
    expect(APP_REDIRECTS).toContainEqual({
      source: "/kontrakt",
      destination: "/avtal",
      permanent: false,
    });
    const page = fileURLToPath(new URL("../app/(app)/kontrakt/page.tsx", import.meta.url));
    expect(existsSync(page)).toBe(false);
  });

  it("/ekonomi/bokforing skickas vidare till fliken Bokföring på Ekonomi", () => {
    expect(APP_REDIRECTS).toContainEqual({
      source: "/ekonomi/bokforing",
      destination: "/ekonomi?vy=bokforing",
      permanent: false,
    });
  });
});
