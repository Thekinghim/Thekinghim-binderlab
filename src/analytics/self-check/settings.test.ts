import { describe, expect, it } from "vitest";

import {
  CARD_FEE_LINK,
  VAT_LINK,
  cardFeeEffectOre,
  daysToVatLimit,
  roughWhen,
  settingsCheck,
  settingsCheckHeadline,
  settingsHomeNotice,
  settingsIssues,
  stillValid,
  vatAckValid,
  type SettingsCheckInput,
} from "./settings";
import { homeLine, homeLink, summarize } from "./summary";

const plain = (s: string) => s.replace(/ /g, " ");

const base: SettingsCheckInput = {
  cardFeeBp: 150,
  vatRateBp: 2500,
  vatLimitOre: 12_000_000,
  vatAcknowledged: false,
  yearSalesOre: 9_784_600,
  yearCardSalesOre: 9_784_600,
  recentSalesOre: 9_000_000,
  daysLeftInYear: 50,
};

describe("kortavgiften", () => {
  it("0 % med kortköp ger varningen med kronor", () => {
    const [issue] = settingsIssues({ ...base, cardFeeBp: 0 });
    expect(issue?.kind).toBe("card_fee");
    // 1,5 % av 97 846 kr = 1 467,69 kr → ca 1 470 kr.
    expect(plain(issue!.text)).toBe(
      "Kortavgiften står på 0 %. Med 1,5 % är vinsten i år ca 1 470 kr lägre. Kolla din utbetalning.",
    );
    expect(issue!.link).toBe(CARD_FEE_LINK);
    expect(cardFeeEffectOre(9_784_600)).toBe(146_769);
  });

  it("1,5 % ger ingen varning, och 0 % utan kortköp ger ingen", () => {
    expect(settingsIssues(base)).toEqual([]);
    expect(settingsIssues({ ...base, cardFeeBp: 0, yearCardSalesOre: 0 })).toEqual([]);
  });
});

describe("momsgränsen", () => {
  const vat0: SettingsCheckInput = { ...base, vatRateBp: 0 };

  it("97 846 kr i år i nuvarande takt: passerar 120 000 kr om ungefär en vecka", () => {
    // 22 154 kr kvar, 3 000 kr per dag → 8 dagar.
    expect(daysToVatLimit(vat0)).toBe(8);
    const [issue] = settingsIssues(vat0);
    expect(issue?.kind).toBe("vat");
    expect(plain(issue!.text)).toBe(
      "Du har sålt för 97 846 kr i år. Om ungefär en vecka passerar du 120 000 kr. Då kan du behöva momsregistrera dig. Fråga din revisor.",
    );
    expect(issue!.link).toBe(VAT_LINK);
  });

  it("efter Revisorn har koll kommer ingen momsrad", () => {
    expect(settingsIssues({ ...vat0, vatAcknowledged: true })).toEqual([]);
  });

  it("redan över gränsen", () => {
    const [issue] = settingsIssues({ ...vat0, yearSalesOre: 13_000_000 });
    expect(plain(issue!.text)).toBe(
      "Du har sålt för 130 000 kr i år. Det är över 120 000 kr. Då kan du behöva momsregistrera dig. Fråga din revisor.",
    );
  });

  it("ingen rad när gränsen inte nås före årets slut, utan takt eller med moms inställd", () => {
    expect(settingsIssues({ ...vat0, daysLeftInYear: 5 })).toEqual([]);
    expect(settingsIssues({ ...vat0, recentSalesOre: 0 })).toEqual([]);
    expect(settingsIssues({ ...vat0, yearSalesOre: 0 })).toEqual([]);
    expect(settingsIssues({ ...vat0, vatRateBp: 600 })).toEqual([]);
    expect(daysToVatLimit({ ...vat0, recentSalesOre: 0 })).toBeNull();
  });

  it("egen gräns används i texten", () => {
    const [issue] = settingsIssues({ ...vat0, vatLimitOre: 10_000_000 });
    expect(plain(issue!.text)).toContain("I morgon passerar du 100 000 kr.");
  });

  it("roughWhen", () => {
    expect(roughWhen(1)).toBe("I morgon");
    expect(roughWhen(3)).toBe("Om några dagar");
    expect(roughWhen(8)).toBe("Om ungefär en vecka");
    expect(plain(roughWhen(21))).toBe("Om ungefär 3 veckor");
    expect(plain(roughWhen(60))).toBe("Om ungefär 2 månader");
  });
});

describe("kontrollen och rubriken", () => {
  it("allt inställt: går igenom, rubriken säger Allt är inställt.", () => {
    const r = settingsCheck(base);
    expect(r.id).toBe("installningar");
    expect(r.status).toBe("pass");
    expect(r.findings).toEqual([]);
    expect(settingsCheckHeadline([])).toEqual({ title: "Allt är inställt.", line: null, ok: true });
  });

  it("bara varningar: aldrig fel, så inget larm och inget 'Kontrollen hittade fel'", () => {
    const r = settingsCheck({ ...base, cardFeeBp: 0, vatRateBp: 0 });
    expect(r.status).toBe("warn");
    expect(r.findings.map((f) => f.level)).toEqual(["warn", "warn"]);
    expect(r.summary).toBe("Två inställningar att kolla.");
    expect(summarize([r])).toEqual({ status: "warning", failed: 0, warnings: 1 });
    const head = settingsCheckHeadline(settingsIssues({ ...base, cardFeeBp: 0, vatRateBp: 0 }));
    expect(plain(head.title)).toBe("Kortavgiften står på 0 %.");
    expect(head.ok).toBe(false);
  });

  it("raden på Hem: gäller bara så länge inställningen står kvar", () => {
    const r = settingsCheck({ ...base, cardFeeBp: 0, vatRateBp: 0 });
    const now = { cardFeeBp: 0, vatRateBp: 0, vatAcknowledged: false };
    expect(plain(settingsHomeNotice(r.findings, now)!)).toBe("Kortavgiften står på 0 %");
    expect(settingsHomeNotice(r.findings, { ...now, cardFeeBp: 150 })).toBe(
      "Du närmar dig momsgränsen",
    );
    expect(
      settingsHomeNotice(r.findings, { cardFeeBp: 150, vatRateBp: 0, vatAcknowledged: true }),
    ).toBeNull();
    expect(stillValid(r.findings[1]!, { ...now, vatRateBp: 2500 })).toBe(false);
  });

  it("Hem säger över gränsen när årets försäljning redan passerat den", () => {
    const over = settingsCheck({ ...base, vatRateBp: 0, yearSalesOre: 13_000_000 });
    expect(
      settingsHomeNotice(over.findings, { cardFeeBp: 150, vatRateBp: 0, vatAcknowledged: false }),
    ).toBe("Du är över momsgränsen");
  });

  it("Revisorn har koll gäller bara räkenskapsåret det trycktes i", () => {
    expect(vatAckValid("2026-03-04T09:00:00.000Z", "2026-01-01")).toBe(true);
    expect(vatAckValid("2026-01-01 00:00:00+00", "2026-01-01")).toBe(true);
    expect(vatAckValid("2025-12-01T10:00:00.000Z", "2026-01-01")).toBe(false);
    // Brutet räkenskapsår (juli–juni): tryckt i maj gäller inte året som börjar i juli.
    expect(vatAckValid("2026-05-20T10:00:00.000Z", "2026-07-01")).toBe(false);
    expect(vatAckValid(null, "2026-01-01")).toBe(false);
  });

  it("Hem: fel går före varningen, och länken följer raden", () => {
    const notice = "Du närmar dig momsgränsen";
    expect(homeLine({ status: "warning", failed: 0, notice })).toBe(notice);
    expect(homeLink({ status: "warning", failed: 0, notice })).toBe("/installningar");
    expect(plain(homeLine({ status: "failed", failed: 2, notice })!)).toBe(
      "Kontrollen hittade 2 fel",
    );
    expect(homeLink({ status: "failed", failed: 2, notice })).toBe("/installningar/kontroll");
    expect(homeLine({ status: "ok", failed: 0, notice: null })).toBeNull();
    expect(homeLink(null)).toBe("/installningar/kontroll");
  });
});
