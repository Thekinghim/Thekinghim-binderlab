import { describe, expect, it } from "vitest";

import { awishExpiryNotice, expiryDateText, merchantCheckDue, parseMerchantExpiry } from "./expiry";

const TZ = "Europe/Stockholm";
const nbsp = (s: string | undefined) => (s ?? "").replace(/ /g, " ");

describe("parseMerchantExpiry", () => {
  it("Awish tid i kontots tidszon (Shanghai)", () => {
    expect(parseMerchantExpiry("2027-04-18 23:48:54", "Asia/Shanghai")?.toISOString()).toBe(
      "2027-04-18T15:48:54.000Z",
    );
  });
  it("datum utan tid är slutet av dagen; Unix-sekunder och millisekunder", () => {
    expect(parseMerchantExpiry("2027-04-18", "UTC")?.toISOString()).toBe(
      "2027-04-18T23:59:59.000Z",
    );
    expect(parseMerchantExpiry("1807833600", "UTC")?.toISOString()).toBe(
      "2027-04-16T00:00:00.000Z",
    );
    expect(parseMerchantExpiry("1807833600000", "UTC")?.toISOString()).toBe(
      "2027-04-16T00:00:00.000Z",
    );
  });
  it("saknas eller går inte att tolka: null", () => {
    expect(parseMerchantExpiry(null, TZ)).toBeNull();
    expect(parseMerchantExpiry("", TZ)).toBeNull();
    expect(parseMerchantExpiry("snart", TZ)).toBeNull();
  });
});

describe("merchantCheckDue", () => {
  const now = new Date("2026-11-05T12:00:00Z");
  it("aldrig läst eller ett dygn sedan: ja; tidigare samma dygn: nej", () => {
    expect(merchantCheckDue(null, now)).toBe(true);
    expect(merchantCheckDue(new Date("2026-11-04T12:00:00Z"), now)).toBe(true);
    expect(merchantCheckDue(new Date("2026-11-04T12:10:00Z"), now)).toBe(false);
  });
});

describe("awishExpiryNotice: 30 och 7 dagar", () => {
  const expires = new Date("2027-04-18T15:48:54Z"); // 18 apr. 17:48 i Stockholm
  const at = (iso: string) => awishExpiryNotice(expires, new Date(iso), TZ);

  it("mer än 30 dagar kvar: ingen påminnelse", () => {
    expect(at("2027-03-18T10:00:00Z")).toBeNull();
  });
  it("30 dagar kvar: påminnelse (inte brådskande) med datum", () => {
    const n = at("2027-03-19T10:00:00Z");
    expect(n?.level).toBe("soon");
    expect(n?.daysLeft).toBe(30);
    expect(nbsp(n?.text)).toBe("Awish-kontot går ut 18 apr. 2027 – förläng hos Awish");
  });
  it("8 dagar kvar: fortfarande 'soon'; 7 dagar: brådskande", () => {
    expect(at("2027-04-10T10:00:00Z")?.level).toBe("soon");
    expect(at("2027-04-11T10:00:00Z")?.level).toBe("now");
    expect(at("2027-04-18T10:00:00Z")?.level).toBe("now");
  });
  it("utgånget: brådskande, 'gick ut'", () => {
    const n = at("2027-04-20T10:00:00Z");
    expect(n?.level).toBe("now");
    expect(n?.daysLeft).toBe(-2);
    expect(nbsp(n?.text)).toBe("Awish-kontot gick ut 18 apr. 2027 – förläng hos Awish");
  });
  it("okänd slutdag: null", () => {
    expect(awishExpiryNotice(null, new Date(), TZ)).toBeNull();
  });
  it("datumtext", () => {
    expect(nbsp(expiryDateText("2027-04-18"))).toBe("18 apr. 2027");
  });
});
