import { describe, expect, it } from "vitest";

import {
  bpToInput,
  fiscalYearLabel,
  formatBp,
  logAside,
  PASSWORD_MIN_LENGTH,
  passwordFormErrors,
  parsePercentInput,
  settingsHeadline,
  settingsLog,
  shareGroups,
  shareSummary,
  type SettingsAuditEvent,
} from "./model";

const NBSP = " ";

describe("procent", () => {
  it("formatBp visar bara de decimaler som behövs", () => {
    expect(formatBp(0)).toBe(`0${NBSP}%`);
    expect(formatBp(250)).toBe(`2,5${NBSP}%`);
    expect(formatBp(1_234)).toBe(`12,34${NBSP}%`);
    expect(formatBp(2_500)).toBe(`25${NBSP}%`);
  });

  it("parsePercentInput tar komma, punkt och procenttecken; nekar för många decimaler och för höga satser", () => {
    expect(parsePercentInput("2,5", 2_000)).toEqual({ ok: true, bp: 250 });
    expect(parsePercentInput("2.25 %", 2_000)).toEqual({ ok: true, bp: 225 });
    expect(parsePercentInput("0", 2_000)).toEqual({ ok: true, bp: 0 });
    expect(parsePercentInput("", 2_000).ok).toBe(false);
    expect(parsePercentInput("2,555", 2_000).ok).toBe(false);
    expect(parsePercentInput("-1", 2_000).ok).toBe(false);
    expect(parsePercentInput("21", 2_000)).toEqual({ ok: false, message: `Högst 20${NBSP}%.` });
  });

  it("bpToInput är inversen för fältet", () => {
    for (const bp of [0, 5, 50, 250, 1_234, 2_500]) {
      const r = parsePercentInput(bpToInput(bp), 10_000);
      expect(r).toEqual({ ok: true, bp });
    }
    expect(bpToInput(250)).toBe("2,5");
  });
});

describe("rubriker", () => {
  it("moms 0 förklaras", () => {
    expect(settingsHeadline({ cardFeeBp: 0, vatRateBp: 0 })).toEqual({
      title: `Kortavgift 0${NBSP}%, moms 0${NBSP}%.`,
      aside: "Intäkten är hela det betalda beloppet.",
    });
    expect(settingsHeadline({ cardFeeBp: 0, vatRateBp: 2_500 }).aside).toBe(
      `Intäkten räknas exklusive 25${NBSP}% moms.`,
    );
  });

  it("räkenskapsår", () => {
    expect(fiscalYearLabel(1)).toBe("januari–december");
    expect(fiscalYearLabel(7)).toBe("juli–juni");
  });
});

describe("ägarandelar", () => {
  const rows = [
    { id: "1", memberUserId: null, holderName: "Bo", shareBp: 4_000, validFrom: "2026-01-01" },
    { id: "2", memberUserId: null, holderName: "Anna", shareBp: 6_000, validFrom: "2026-01-01" },
    { id: "3", memberUserId: null, holderName: "Anna", shareBp: 10_000, validFrom: "2026-12-01" },
  ];

  it("grupper per datum, senaste först, med vad som gäller i dag", () => {
    const g = shareGroups(rows, "2026-11-02");
    expect(g.map((x) => [x.validFrom, x.validTo, x.current, x.future])).toEqual([
      ["2026-12-01", null, false, true],
      ["2026-01-01", "2026-11-30", true, false],
    ]);
    expect(shareSummary(g[1])).toBe(`Anna 60${NBSP}%, Bo 40${NBSP}%.`);
    expect(shareSummary(undefined)).toBe("Inga ägarandelar inlagda.");
  });
});

describe("settingsLog", () => {
  const ev = (over: Partial<SettingsAuditEvent>): SettingsAuditEvent => ({
    id: "e",
    table: "organization_settings",
    rowId: "r",
    action: "update",
    actorId: "u",
    occurredAt: "2026-11-02T10:00:00.000Z",
    before: null,
    after: null,
    ...over,
  });

  it("visar bara ändrade fält, med formaterade värden", () => {
    const log = settingsLog(
      [
        ev({
          before: { card_fee_bp: 0, vat_rate_bp: 0, fiscal_year_start_month: 1, updated_at: "a" },
          after: { card_fee_bp: 250, vat_rate_bp: 0, fiscal_year_start_month: 1, updated_at: "b" },
        }),
      ],
      { u: "Ägare" },
      (d) => d,
    );
    expect(log).toEqual([
      {
        id: "e",
        occurredAt: "2026-11-02T10:00:00.000Z",
        actor: "Ägare",
        subject: "Avgifter och moms",
        verb: "Ändrade",
        changes: [{ label: "Kortavgift", before: `0${NBSP}%`, after: `2,5${NBSP}%` }],
      },
    ]);
  });

  it("konton som lagts in samtidigt blir en rad", () => {
    const at = "2026-11-02T09:00:00.000Z";
    const log = settingsLog(
      [
        ev({
          id: "a",
          table: "ledger_accounts",
          action: "insert",
          occurredAt: at,
          after: { key: "sales", bas_account: "3004", name: "F" },
        }),
        ev({
          id: "b",
          table: "ledger_accounts",
          action: "insert",
          occurredAt: at,
          after: { key: "rent", bas_account: "5010", name: "L" },
        }),
        ev({
          id: "c",
          table: "ledger_accounts",
          action: "insert",
          occurredAt: at,
          after: { key: "cogs", bas_account: "4010", name: "I" },
        }),
        ev({
          id: "d",
          table: "owner_shares",
          action: "insert",
          actorId: null,
          occurredAt: "2026-11-01T09:00:00.000Z",
          after: { holder_name: "Anna", share_bp: 10_000, valid_from: "2026-01-01" },
        }),
      ],
      { u: "Ägare" },
      (d) => d,
    );
    expect(log).toHaveLength(2);
    expect(log[0]!.subject).toBe("Kontoplan, 3 konton");
    expect(log[0]!.changes.map((c) => [c.label, c.after])).toEqual([
      ["Konto 3004", "Försäljning"],
      ["Konto 4010", "Inköp"],
      ["Konto 5010", "Hyra"],
    ]);
    expect(log[1]).toMatchObject({
      subject: "Ägarandel: Anna",
      actor: "Systemet",
      verb: "Lade till",
    });
    expect(logAside(log, () => "2 nov.")).toBe("2 ändringar, senast 2 nov. av Ägare.");
  });
});

describe("passwordFormErrors", () => {
  it("svenska fel per fält och samma minsta längd som servern", async () => {
    const { MIN_PASSWORD_LENGTH } = await import("@/server/auth/password");
    expect(PASSWORD_MIN_LENGTH).toBe(MIN_PASSWORD_LENGTH);
    expect(passwordFormErrors({ current: "", next: "", confirm: "" })).toEqual({
      current: "Fyll i nuvarande lösenord.",
      next: "Fyll i nytt lösenord.",
      confirm: "Fyll i nytt lösenord igen.",
    });
    expect(passwordFormErrors({ current: "x", next: "kort", confirm: "kort" })).toEqual({
      next: "Minst 12 tecken.",
    });
    expect(
      passwordFormErrors({ current: "x", next: "långt-lösenord-1", confirm: "långt-lösenord-2" }),
    ).toEqual({ confirm: "Lösenorden är inte lika." });
    expect(
      passwordFormErrors({ current: "x", next: "långt-lösenord-1", confirm: "långt-lösenord-1" }),
    ).toEqual({});
  });
});
