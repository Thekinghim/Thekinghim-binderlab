import { describe, expect, it } from "vitest";

import {
  formatMobile,
  generateQrToken,
  generateStartPin,
  hashQrToken,
  isQrToken,
  maskMobile,
  normalizeSwedishMobile,
  validateNewPin,
} from "./phone";

describe("normalizeSwedishMobile", () => {
  it.each([
    ["070-123 45 67", "+46701234567"],
    ["0701234567", "+46701234567"],
    ["+46 70 123 45 67", "+46701234567"],
    ["0046 70-123 45 67", "+46701234567"],
    ["46701234567", "+46701234567"],
    ["(073) 123.45.67", "+46731234567"],
  ])("%s → %s", (input, out) => {
    expect(normalizeSwedishMobile(input)).toBe(out);
  });

  it.each(["08-123 456 78", "031-12 34 56", "070123", "07012345678", "+4570123456", "", "abc"])(
    "%s nekas",
    (input) => {
      expect(normalizeSwedishMobile(input)).toBeNull();
    },
  );

  it("maskerar och formaterar", () => {
    expect(maskMobile("+46701234567")).toBe("070-123 45 ··");
    expect(formatMobile("+46701234567")).toBe("070-123 45 67");
  });
});

describe("PIN-koder", () => {
  it.each(["111111", "123456", "654321", "121212", "123123", "12345", "1234567", "abcdef"])(
    "%s nekas",
    (pin) => {
      expect(validateNewPin(pin)).not.toBeNull();
    },
  );

  it.each(["482915", "507193", "908172"])("%s duger", (pin) => {
    expect(validateNewPin(pin)).toBeNull();
  });

  it("start-PIN:en är 6 siffror och klarar reglerna", () => {
    for (let i = 0; i < 200; i += 1) {
      const pin = generateStartPin();
      expect(pin).toMatch(/^\d{6}$/);
      expect(validateNewPin(pin)).toBeNull();
    }
  });
});

describe("QR-nyckeln", () => {
  it("är 43 tecken base64url, slumpad, och bara hashen jämförs", () => {
    const a = generateQrToken();
    const b = generateQrToken();
    expect(isQrToken(a)).toBe(true);
    expect(a).not.toBe(b);
    expect(hashQrToken(a)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashQrToken(a)).toBe(hashQrToken(a));
    expect(isQrToken("kort")).toBe(false);
    expect(isQrToken(`${a.slice(0, 42)}/`)).toBe(false);
    expect(isQrToken(undefined)).toBe(false);
  });
});
