import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { pushErrorReason } from "./push";

describe("pushErrorReason", () => {
  it("läser Apples orsakskod ur JSON-svaret", () => {
    expect(pushErrorReason({ statusCode: 403, body: '{"reason":"BadJwtToken"}' })).toBe(
      "BadJwtToken",
    );
  });
  it("läser första ordet ur ett textsvar", () => {
    expect(pushErrorReason({ statusCode: 400, body: "UnauthorizedRegistration\n" })).toBe(
      "UnauthorizedRegistration",
    );
  });
  it("släpper inte igenom annat än ett kort ord", () => {
    expect(pushErrorReason({ body: '{"reason":"<script>alert(1)</script>"}' })).toBeNull();
    expect(pushErrorReason({ body: "x".repeat(80) })).toBeNull();
    expect(pushErrorReason({ body: "" })).toBeNull();
    expect(pushErrorReason(new Error("nät"))).toBeNull();
    expect(pushErrorReason(null)).toBeNull();
  });
});
