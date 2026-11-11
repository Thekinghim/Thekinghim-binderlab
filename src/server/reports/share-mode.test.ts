import { describe, expect, it } from "vitest";

import { reportShareMode, shareHeadline } from "./share-mode";

describe("reportShareMode", () => {
  it("riktig e-post: inget dela-läge", () => {
    expect(
      reportShareMode({ MAIL_PROVIDER: "resend", RESEND_API_KEY: "k", MAIL_FROM: "a@b.se" }),
    ).toBe(false);
  });

  it("e-post vald men inte inställd: dela", () => {
    expect(reportShareMode({ MAIL_PROVIDER: "resend" })).toBe(true);
    expect(reportShareMode({ MAIL_PROVIDER: "konstig" })).toBe(true);
  });

  it("inget valt: dela (mejlen skulle bara hamna i serverns utkorg)", () => {
    expect(reportShareMode({})).toBe(true);
    expect(reportShareMode({ MAIL_PROVIDER: "" })).toBe(true);
  });

  it("utkorgen uttryckligen vald lokalt: mejlflödet som förut; på Vercel: dela", () => {
    expect(reportShareMode({ MAIL_PROVIDER: "outbox" })).toBe(false);
    expect(reportShareMode({ MAIL_PROVIDER: "outbox", VERCEL: "1" })).toBe(true);
  });
});

describe("shareHeadline", () => {
  const base = {
    type: "butik",
    label: "oktober",
    custom: false,
    storeName: "Sega gubben",
  } as const;

  it("butiksrapporten: månaden med stor bokstav och butiken", () => {
    expect(shareHeadline({ ...base, shared: false })).toBe(
      "Oktober-rapporten till Sega gubben är klar.",
    );
    expect(shareHeadline({ ...base, shared: true })).toBe(
      "Oktober-rapporten till Sega gubben är skickad.",
    );
  });

  it("eget datum, bokföring och delägare", () => {
    expect(shareHeadline({ ...base, label: "15–31 okt. 2026", custom: true, shared: false })).toBe(
      "Rapporten för 15–31 okt. 2026 till Sega gubben är klar.",
    );
    expect(shareHeadline({ ...base, type: "bokforing", storeName: null, shared: false })).toBe(
      "Bokföringsunderlaget för oktober är klart.",
    );
    expect(shareHeadline({ ...base, type: "delagare", storeName: null, shared: true })).toBe(
      "Delägarrapporten för oktober är skickad.",
    );
  });
});
