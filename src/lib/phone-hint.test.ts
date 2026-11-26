import { describe, expect, it } from "vitest";

import { isPhoneRequest } from "./phone-hint";

const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Mobile/15E148 Safari/604.1";
const ANDROID_PHONE =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Mobile Safari/537.36";
const ANDROID_TABLET =
  "Mozilla/5.0 (Linux; Android 14; Tab) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36";
const IPAD =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.1 Safari/605.1.15";

/** Servern hoppar över sidomenyn i första svaret på telefoner (CSS döljer den ändå). */
describe("isPhoneRequest", () => {
  it("iPhone och Android-telefon", () => {
    expect(isPhoneRequest(IPHONE)).toBe(true);
    expect(isPhoneRequest(ANDROID_PHONE)).toBe(true);
  });

  it("dator, iPad och surfplatta är inte telefoner", () => {
    expect(isPhoneRequest(IPAD)).toBe(false);
    expect(isPhoneRequest(ANDROID_TABLET)).toBe(false);
    expect(isPhoneRequest(null)).toBe(false);
  });

  it("klienttipset går före användaragenten", () => {
    expect(isPhoneRequest(IPAD, "?1")).toBe(true);
    expect(isPhoneRequest(ANDROID_PHONE, "?0")).toBe(false);
  });
});
