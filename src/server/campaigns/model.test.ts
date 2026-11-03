import { describe, expect, it } from "vitest";

import type { AwishBanner } from "../awish/grpc-client";

import {
  CampaignError,
  campaignInputSchema,
  campaignState,
  campaignWindow,
  findCreatedBanner,
  sniffCampaignImage,
  suggestCampaigns,
  unixSeconds,
} from "./model";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0]);
const WEBP = new Uint8Array([0x52, 0x49, 0x46, 0x46, 1, 2, 3, 4, 0x57, 0x45, 0x42, 0x50]);
const SVG = new TextEncoder().encode("<svg onload=alert(1)>");

describe("bilden", () => {
  it("typ ur innehållet, inte ur filnamnet", () => {
    expect(sniffCampaignImage(PNG)).toBe("image/png");
    expect(sniffCampaignImage(JPG)).toBe("image/jpeg");
    expect(sniffCampaignImage(WEBP)).toBe("image/webp");
    expect(sniffCampaignImage(SVG)).toBeNull();
    expect(sniffCampaignImage(new Uint8Array([0x25, 0x50, 0x44, 0x46]))).toBeNull();
  });
});

describe("indata", () => {
  const base = {
    title: "Nytt: Surging Sparks",
    machineIds: [],
    startsOn: null,
    endsOn: "2026-11-17",
    titleId: null,
    reuseImageFrom: null,
  };
  it("godtar en vanlig kampanj och trimmar texten", () => {
    expect(campaignInputSchema.parse({ ...base, title: "  Nytt  " }).title).toBe("Nytt");
  });
  it("nekar för lång text, radbrytning, okända fält och okänd automat", () => {
    expect(() => campaignInputSchema.parse({ ...base, title: "x".repeat(61) })).toThrow();
    expect(() => campaignInputSchema.parse({ ...base, title: "a\nb" })).toThrow();
    expect(() => campaignInputSchema.parse({ ...base, organizationId: "x" })).toThrow();
    expect(() => campaignInputSchema.parse({ ...base, machineIds: ["BL-001"] })).toThrow();
    expect(() => campaignInputSchema.parse({ ...base, endsOn: "17 nov" })).toThrow();
  });
});

describe("start och slut", () => {
  const ctx = {
    now: new Date("2026-11-03T10:00:00Z"),
    today: "2026-11-03" as const,
    timeZone: "Europe/Stockholm",
  };
  it("nu: från nu till slutdagens slut (midnatt svensk tid)", () => {
    const w = campaignWindow({ startsOn: null, endsOn: "2026-11-16" }, ctx);
    expect(w.startsNow).toBe(true);
    expect(w.startsAt.toISOString()).toBe("2026-11-03T10:00:00.000Z");
    expect(w.endsAt.toISOString()).toBe("2026-11-16T23:00:00.000Z");
    expect(unixSeconds(w.endsAt)).toBe(Date.parse("2026-11-16T23:00:00Z") / 1000);
  });
  it("senare: från startdagens början", () => {
    const w = campaignWindow({ startsOn: "2026-11-08", endsOn: "2026-11-10" }, ctx);
    expect(w.startsNow).toBe(false);
    expect(w.startsAt.toISOString()).toBe("2026-11-07T23:00:00.000Z");
  });
  it("ogiltiga intervall", () => {
    expect(() => campaignWindow({ startsOn: null, endsOn: "2026-11-02" }, ctx)).toThrow(
      CampaignError,
    );
    expect(() => campaignWindow({ startsOn: "2026-11-09", endsOn: "2026-11-08" }, ctx)).toThrow(
      /före startdatumet/,
    );
    expect(() => campaignWindow({ startsOn: null, endsOn: "2027-03-01" }, ctx)).toThrow(/90 dagar/);
  });
});

describe("läget", () => {
  const now = new Date("2026-11-03T10:00:00Z");
  const c = { startsAt: new Date("2026-11-01"), endsAt: new Date("2026-11-20"), stoppedAt: null };
  it("visas, delvis, planerad, misslyckad, slut, avstängd", () => {
    expect(campaignState(c, [{ status: "shown" }], now)).toBe("live");
    expect(campaignState(c, [{ status: "shown" }, { status: "failed" }], now)).toBe("partial");
    expect(campaignState(c, [{ status: "scheduled" }], now)).toBe("scheduled");
    expect(campaignState(c, [{ status: "failed" }], now)).toBe("failed");
    expect(
      campaignState({ ...c, endsAt: new Date("2026-11-02") }, [{ status: "shown" }], now),
    ).toBe("ended");
    expect(campaignState({ ...c, stoppedAt: now }, [{ status: "stopped" }], now)).toBe("stopped");
  });
});

describe("kampanjbilden i Awish", () => {
  const b = (id: string, over: Partial<AwishBanner> = {}): AwishBanner => ({
    id,
    isVisible: true,
    expiredAt: null,
    coverImage: "https://x/a.png",
    title: "Nytt",
    hitCount: 0,
    viewsCount: 0,
    mediaType: 1,
    ...over,
  });
  it("den nya med samma bild och text, nyaste först", () => {
    const before = [b("5")];
    const after = [b("5"), b("12"), b("9"), b("13", { title: "Annat" })];
    expect(
      findCreatedBanner(before, after, { coverImage: "https://x/a.png", title: "Nytt" })?.id,
    ).toBe("12");
    expect(
      findCreatedBanner(after, after, { coverImage: "https://x/a.png", title: "Nytt" }),
    ).toBeNull();
  });
});

describe("förslag", () => {
  const today = "2026-11-03" as const;
  it("en ny titel i en kopplad automat föreslås, en gammal eller kampanjad inte", () => {
    const s = suggestCampaigns({
      firstStocked: [
        { titleId: "t-ny", titleName: "Surging Sparks", machineId: "m1", firstOn: "2026-11-01" },
        { titleId: "t-ny", titleName: "Surging Sparks", machineId: "m2", firstOn: "2026-10-30" },
        {
          titleId: "t-ny",
          titleName: "Surging Sparks",
          machineId: "m-okopplad",
          firstOn: "2026-11-01",
        },
        // Fanns redan för länge sedan i en annan automat: inte ny i flottan.
        { titleId: "t-gammal", titleName: "Paradox Rift", machineId: "m1", firstOn: "2026-11-02" },
        { titleId: "t-gammal", titleName: "Paradox Rift", machineId: "m2", firstOn: "2026-06-01" },
        { titleId: "t-klar", titleName: "Black Bolt", machineId: "m1", firstOn: "2026-11-02" },
      ],
      campaigned: [{ titleId: "t-klar", createdOn: "2026-11-02" }],
      linkedMachineIds: ["m1", "m2"],
      today,
    });
    expect(s).toEqual([
      {
        titleId: "t-ny",
        titleName: "Surging Sparks",
        text: "Nytt: Surging Sparks",
        machineIds: ["m1", "m2"],
        since: "2026-10-30",
      },
    ]);
  });
  it("en kampanj före titelns ankomst hindrar inte förslaget", () => {
    const s = suggestCampaigns({
      firstStocked: [{ titleId: "t", titleName: "X", machineId: "m1", firstOn: "2026-11-02" }],
      campaigned: [{ titleId: "t", createdOn: "2026-10-01" }],
      linkedMachineIds: ["m1"],
      today,
    });
    expect(s).toHaveLength(1);
  });
});
