/**
 * Inställningar mot testdatabasen: laddaren, avgifter och moms, ägarandelar och loggen.
 */

import { beforeAll, describe, expect, it } from "vitest";

import {
  loadSettingsPageFor,
  saveOwnerSharesFor,
  updateSettingsFor,
} from "../../src/app/(app)/installningar/_lib/data";
import { SETTINGS_MESSAGES, settingsLog } from "../../src/app/(app)/installningar/_lib/model";
import { AuthorizationError, type SessionUser } from "../../src/server/access";
import { createMember, type TestUser } from "./helpers";
import { seedPriceFixture, type PriceFixture } from "./inkopspriser-fixture";

const su = (u: TestUser): SessionUser => ({ userId: u.id, email: u.email });

let fx: PriceFixture;
let owner: SessionUser;
let admin: SessionUser;
let viewer: SessionUser;
let refiller: SessionUser;
let otherOwner: SessionUser;

beforeAll(async () => {
  fx = await seedPriceFixture();
  owner = su(fx.owner);
  admin = su(await createMember(fx.orgId, "admin"));
  viewer = su(await createMember(fx.orgId, "viewer"));
  refiller = su(await createMember(fx.orgId, "refiller"));
  otherOwner = su((await seedPriceFixture()).owner);
});

describe("loadSettingsPageFor", () => {
  it("ägare och admin får sidan; läsare, påfyllare och andra organisationer nekas", async () => {
    expect((await loadSettingsPageFor(owner, fx.orgId)).role).toBe("owner");
    expect((await loadSettingsPageFor(admin, fx.orgId)).role).toBe("admin");
    for (const u of [viewer, refiller, otherOwner]) {
      await expect(loadSettingsPageFor(u, fx.orgId)).rejects.toBeInstanceOf(AuthorizationError);
    }
  });
});

describe("updateSettingsFor", () => {
  it("admin ändrar kortavgiften; ändringen loggas med före och efter", async () => {
    const r = await updateSettingsFor(admin, {
      organizationId: fx.orgId,
      cardFeeBp: 250,
      vatRateBp: 0,
      fiscalYearStartMonth: 7,
    });
    expect(r).toEqual({ ok: true, data: { changed: true } });

    const page = await loadSettingsPageFor(owner, fx.orgId);
    expect(page.settings).toMatchObject({ cardFeeBp: 250, vatRateBp: 0, fiscalYearStartMonth: 7 });
    const log = settingsLog(page.events, page.actorNames, (d) => d);
    const entry = log.find((e) => e.subject === "Avgifter och moms" && e.verb === "Ändrade");
    expect(entry?.changes).toEqual([
      { label: "Kortavgift", before: "0 %", after: "2,5 %" },
      { label: "Räkenskapsåret börjar", before: "januari", after: "juli" },
    ]);
    expect(
      page.events.find((e) => e.table === "organization_settings" && e.action === "update")
        ?.actorId,
    ).toBe(admin.userId);
  });

  it("samma värden igen ändrar ingenting", async () => {
    expect(
      await updateSettingsFor(owner, {
        organizationId: fx.orgId,
        cardFeeBp: 250,
        vatRateBp: 0,
        fiscalYearStartMonth: 7,
      }),
    ).toEqual({ ok: true, data: { changed: false } });
  });

  it("läsare och påfyllare nekas, orimliga värden avvisas", async () => {
    const input = { organizationId: fx.orgId, cardFeeBp: 0, vatRateBp: 0, fiscalYearStartMonth: 1 };
    for (const u of [viewer, refiller, otherOwner]) {
      expect(await updateSettingsFor(u, input)).toEqual({
        ok: false,
        error: SETTINGS_MESSAGES.forbidden,
      });
    }
    expect(await updateSettingsFor(owner, { ...input, vatRateBp: 5_000 })).toEqual({
      ok: false,
      error: SETTINGS_MESSAGES.invalid,
    });
    expect(await updateSettingsFor(owner, { ...input, fiscalYearStartMonth: 13 })).toEqual({
      ok: false,
      error: SETTINGS_MESSAGES.invalid,
    });
  });
});

describe("saveOwnerSharesFor", () => {
  const shares = [
    { holderName: "Anna", shareBp: 6_000 },
    { holderName: "Bo", shareBp: 4_000 },
  ];

  it("bara ägaren; admin och läsare nekas", async () => {
    for (const u of [admin, viewer]) {
      expect(
        await saveOwnerSharesFor(u, { organizationId: fx.orgId, validFrom: "2025-01-01", shares }),
      ).toEqual({ ok: false, error: SETTINGS_MESSAGES.ownerOnly });
    }
  });

  it("andelarna måste summera till 100 % och namnen vara unika", async () => {
    expect(
      await saveOwnerSharesFor(owner, {
        organizationId: fx.orgId,
        validFrom: "2025-01-01",
        shares: [{ holderName: "Anna", shareBp: 6_000 }],
      }),
    ).toEqual({ ok: false, error: SETTINGS_MESSAGES.sharesSum(6_000) });
    expect(
      await saveOwnerSharesFor(owner, {
        organizationId: fx.orgId,
        validFrom: "2025-01-01",
        shares: [
          { holderName: "Anna", shareBp: 5_000 },
          { holderName: "anna", shareBp: 5_000 },
        ],
      }),
    ).toEqual({ ok: false, error: SETTINGS_MESSAGES.sharesDuplicate });
  });

  it("ägaren sparar en fördelning, kopplad till en medlem, och den loggas", async () => {
    const r = await saveOwnerSharesFor(owner, {
      organizationId: fx.orgId,
      validFrom: "2025-01-01",
      shares: [{ holderName: "Anna", shareBp: 6_000, memberUserId: owner.userId }, shares[1]!],
    });
    expect(r).toEqual({ ok: true, data: { validFrom: "2025-01-01" } });
    const page = await loadSettingsPageFor(admin, fx.orgId);
    expect(page.shares.map((s) => [s.holderName, s.shareBp, s.memberUserId])).toEqual([
      ["Anna", 6_000, owner.userId],
      ["Bo", 4_000, null],
    ]);
    const log = settingsLog(page.events, page.actorNames, (d) => d);
    expect(
      log
        .filter((e) => e.subject.startsWith("Ägarandel:"))
        .map((e) => e.subject)
        .sort(),
    ).toEqual(["Ägarandel: Anna", "Ägarandel: Bo"]);
  });

  it("samma datum en gång till avvisas; ett nytt datum går bra", async () => {
    expect(
      await saveOwnerSharesFor(owner, {
        organizationId: fx.orgId,
        validFrom: "2025-01-01",
        shares,
      }),
    ).toEqual({ ok: false, error: SETTINGS_MESSAGES.sharesDateTaken });
    expect(
      await saveOwnerSharesFor(owner, {
        organizationId: fx.orgId,
        validFrom: "2025-07-01",
        shares: [{ holderName: "Anna", shareBp: 10_000 }],
      }),
    ).toEqual({ ok: true, data: { validFrom: "2025-07-01" } });
  });
});
