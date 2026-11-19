import { describe, expect, it } from "vitest";

import { channelReach, reachAside } from "./channel-reach";

const NO_MAIL = { email: false, push: true, sms: false };
const ALL = { email: true, push: true, sms: true };

describe("vilka kanaler når fram", () => {
  it("produktionens läge: push och e-post valda, ingen telefon, ingen e-postleverantör", () => {
    const reach = channelReach({
      channels: ["push", "email"],
      devices: 0,
      hasPhone: false,
      works: NO_MAIL,
    });
    expect(reach.working).toEqual([]);
    expect(reachAside(reach, "22:00–07:00")).toBe(
      "Ingen telefon har notiser påslagna. E-post är inte påslagen. Slå på notiser på din telefon här nedanför.",
    );
  });

  it("push fungerar: e-posten som inte går att skicka visas aldrig som en kanal", () => {
    const reach = channelReach({
      channels: ["push", "email"],
      devices: 1,
      hasPhone: false,
      works: NO_MAIL,
    });
    expect(reach.working).toEqual(["push"]);
    expect(reachAside(reach, "22:00–07:00")).toBe(
      "Via push, tyst 22:00–07:00. E-post är inte påslagen.",
    );
  });

  it("allt fungerar: som förut", () => {
    const reach = channelReach({
      channels: ["push", "email"],
      devices: 2,
      hasPhone: false,
      works: ALL,
    });
    expect(reachAside(reach, null)).toBe("Via push och e-post.");
  });

  it("sms utan leverantör eller nummer når inte fram", () => {
    expect(
      channelReach({ channels: ["sms"], devices: 0, hasPhone: true, works: NO_MAIL }).broken,
    ).toEqual([{ channel: "sms", reason: "Sms är inte påslaget" }]);
    expect(
      channelReach({ channels: ["sms"], devices: 0, hasPhone: false, works: ALL }).broken,
    ).toEqual([{ channel: "sms", reason: "Telefonnummer saknas" }]);
  });
});
