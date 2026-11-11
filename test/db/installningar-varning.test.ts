/**
 * T5-1, "Inställningar säger till", mot testdatabasen: kortavgift 0 % trots kortköp och
 * moms 0 % nära momsgränsen. Talen läses ur riktiga order, "Revisorn har koll" och
 * momsgränsen sparas på organization_settings (ägare och admin, loggas), den dagliga
 * kontrollen får en sjunde kontroll som bara varnar (inget larm), och raden på Hem
 * försvinner i samma stund som inställningen ändras.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_noStore: vi.fn(),
  unstable_cache: <T>(fn: T) => fn,
}));

import { homeLine, homeLink, settingsIssues } from "@/analytics/self-check";
import {
  loadSettingsIssuesFor,
  loadSettingsPageFor,
  setVatAcknowledgedFor,
  updateSettingsFor,
} from "@/app/(app)/installningar/_lib/data";
import { SETTINGS_MESSAGES, settingsLog } from "@/app/(app)/installningar/_lib/model";
import type { IsoDate } from "@/domain";
import { AuthorizationError, type SessionUser } from "@/server/access";
import { fiscalYearAround, querySettingsFacts } from "@/server/self-check/queries";
import { checkViewerFor, runSelfCheck } from "@/server/self-check/run";
import { latestSelfCheckFor } from "@/server/self-check/service";

import { asUser, attempt, createMember, db, rows, type TestUser } from "./helpers";
import { seedPriceFixture, type PriceFixture } from "./inkopspriser-fixture";

const su = (u: TestUser): SessionUser => ({ userId: u.id, email: u.email });
const plain = (s: string) => s.replace(/ /g, " ");

const TODAY = "2026-11-11" as IsoDate;
const NOW = new Date("2026-11-11T12:00:00Z");

let fx: PriceFixture;
let owner: SessionUser;
let admin: SessionUser;
let viewer: SessionUser;
let refiller: TestUser;
let otherOwner: SessionUser;

async function addOrder(day: string, amountOre: number, method: string | null, n: number) {
  await db().execute(sql`
    insert into public.orders
      (organization_id, data_source_id, external_id, raw_title, title_id, ordered_at,
       amount_ore, payment_method, source_hash)
    select ${fx.orgId}::uuid, d.id, ${`t5-${n}`}, 'Pokemon 151', ${fx.titleId}::uuid,
           ${`${day}T10:00:00Z`}::timestamptz, ${amountOre}, ${method}, ${`t5-h${n}`}
    from public.data_sources d where d.organization_id = ${fx.orgId}::uuid limit 1`);
}

const save = (u: SessionUser, v: { cardFeeBp: number; vatRateBp: number; vatLimitOre?: number }) =>
  updateSettingsFor(u, { organizationId: fx.orgId, fiscalYearStartMonth: 1, ...v });

beforeAll(async () => {
  fx = await seedPriceFixture();
  owner = su(fx.owner);
  admin = su(await createMember(fx.orgId, "admin"));
  viewer = su(await createMember(fx.orgId, "viewer"));
  refiller = await createMember(fx.orgId, "refiller");
  otherOwner = su((await seedPriceFixture()).owner);
  // 97 846 kr i år: 7 846 kr i februari (kontant) och 9 × 10 000 kr de senaste dagarna.
  await addOrder("2026-02-10", 784_600, "cash", 0);
  for (let i = 1; i <= 9; i++) {
    await addOrder(`2026-11-${String(i).padStart(2, "0")}`, 1_000_000, i === 1 ? "card" : null, i);
  }
}, 120_000);

describe("talen bakom varningen", () => {
  it("årets försäljning, kortdelen och takten läses ur order", async () => {
    const facts = await querySettingsFacts(db(), fx.orgId, TODAY);
    expect(facts).toEqual({
      cardFeeBp: 0,
      vatRateBp: 0,
      vatLimitOre: 12_000_000,
      vatAcknowledged: false,
      yearSalesOre: 9_784_600,
      // Kontantköpet räknas inte som kortköp; okänt betalsätt gör det (en automat tar kort).
      yearCardSalesOre: 9_000_000,
      recentSalesOre: 9_000_000,
      daysLeftInYear: 50,
    });
  });

  it("räkenskapsåret följer startmånaden", () => {
    expect(fiscalYearAround(TODAY, 1)).toEqual({ start: "2026-01-01", daysLeft: 50 });
    expect(fiscalYearAround(TODAY, 7)).toEqual({ start: "2026-07-01", daysLeft: 231 });
    expect(fiscalYearAround("2026-03-05" as IsoDate, 7).start).toBe("2025-07-01");
  });

  it("testköp räknas inte", async () => {
    await addOrder("2026-11-09", 50_000_000, "card", 99);
    await db().execute(sql`update public.orders set test_purchase_at = now()
      where organization_id = ${fx.orgId}::uuid and external_id = 't5-99'`);
    expect((await querySettingsFacts(db(), fx.orgId, TODAY)).yearSalesOre).toBe(9_784_600);
  });
});

describe("Inställningar: det som behöver kollas", () => {
  it("kortavgift 0 % med kortköp och moms 0 % nära gränsen: två rader med talen", async () => {
    const issues = await loadSettingsIssuesFor(owner, fx.orgId, TODAY);
    expect(issues.map((i) => plain(i.text))).toEqual([
      "Kortavgiften står på 0 %. Med 1,5 % är vinsten i år ca 1 350 kr lägre. Kolla din utbetalning.",
      "Du har sålt för 97 846 kr i år. Om ungefär en vecka passerar du 120 000 kr. Då kan du behöva momsregistrera dig. Fråga din revisor.",
    ]);
  });

  it("läsare, påfyllare och andra organisationer ser inget", async () => {
    for (const u of [viewer, su(refiller), otherOwner]) {
      await expect(loadSettingsIssuesFor(u, fx.orgId, TODAY)).rejects.toBeInstanceOf(
        AuthorizationError,
      );
    }
  });

  it("kortavgift 1,5 %: kortraden försvinner, momsraden står kvar", async () => {
    expect(await save(admin, { cardFeeBp: 150, vatRateBp: 0 })).toEqual({
      ok: true,
      data: { changed: true },
    });
    const issues = await loadSettingsIssuesFor(owner, fx.orgId, TODAY);
    expect(issues.map((i) => i.kind)).toEqual(["vat"]);
    await save(owner, { cardFeeBp: 0, vatRateBp: 0 });
  });

  it("momsgränsen går att ändra och loggas; orimliga belopp och fel roller nekas", async () => {
    expect(await save(owner, { cardFeeBp: 0, vatRateBp: 0, vatLimitOre: 50_000_000 })).toEqual({
      ok: true,
      data: { changed: true },
    });
    // 500 000 kr nås inte före årets slut i den här takten: ingen momsrad.
    expect((await loadSettingsIssuesFor(owner, fx.orgId, TODAY)).map((i) => i.kind)).toEqual([
      "card_fee",
    ]);
    const page = await loadSettingsPageFor(owner, fx.orgId);
    expect(page.settings?.vatLimitOre).toBe(50_000_000);
    const log = settingsLog(page.events, page.actorNames, (d) => d);
    const change = log.flatMap((e) => e.changes ?? []).find((c) => c.label === "Momsgräns");
    expect([plain(change!.before ?? ""), plain(change!.after ?? "")]).toEqual([
      "120 000 kr",
      "500 000 kr",
    ]);

    expect((await save(owner, { cardFeeBp: 0, vatRateBp: 0, vatLimitOre: 50 })).ok).toBe(false);
    expect(await save(viewer, { cardFeeBp: 0, vatRateBp: 0, vatLimitOre: 9_000_000 })).toEqual({
      ok: false,
      error: SETTINGS_MESSAGES.forbidden,
    });
    // Utan gräns i anropet behålls den sparade.
    await save(owner, { cardFeeBp: 150, vatRateBp: 0 });
    expect((await loadSettingsPageFor(owner, fx.orgId)).settings?.vatLimitOre).toBe(50_000_000);
    await save(owner, { cardFeeBp: 0, vatRateBp: 0, vatLimitOre: 12_000_000 });
  });

  it("påfyllaren kan inte stänga varningen direkt i databasen (RLS)", async () => {
    await asUser(refiller, async (tx) => {
      const r = await attempt(tx, (sp) =>
        sp.execute(sql`update public.organization_settings set vat_ok_at = now()
                       where organization_id = ${fx.orgId}::uuid returning id`),
      );
      expect(r.ok ? Array.from(r.value as Iterable<unknown>).length : 0).toBe(0);
    });
    expect((await querySettingsFacts(db(), fx.orgId, TODAY)).vatAcknowledged).toBe(false);
  });
});

describe("den dagliga kontrollen och Hem", () => {
  it("sjunde kontrollen varnar, larmar inte, och Hem visar raden", async () => {
    const r = await runSelfCheck(
      { db: db(), now: NOW },
      {
        organizationId: fx.orgId,
        trigger: "schedule",
      },
    );
    expect(r.checks).toHaveLength(7);
    const check = r.checks.find((c) => c.id === "installningar")!;
    expect(check.status).toBe("warn");
    expect(check.findings.map((f) => f.level)).toEqual(["warn", "warn"]);
    expect(plain(check.findings[1]!.text)).toMatch(/^Du har sålt för 97 846 kr i år\. /);
    // Varningen räknas aldrig som fel och ger inget eget larm.
    const failedIds = r.checks.filter((c) => c.status === "fail").map((c) => c.id);
    expect(failedIds).not.toContain("installningar");
    const alerts = await rows(
      db(),
      sql`select incident_key from public.alerts
          where organization_id = ${fx.orgId}::uuid and kind = 'self_check'
            and incident_key like '%installningar%'`,
    );
    expect(alerts).toEqual([]);

    const v = (await checkViewerFor(db(), fx.orgId))!;
    const latest = await latestSelfCheckFor(v);
    expect(plain(latest!.notice!)).toBe("Kortavgiften står på 0 %");
    if (latest!.failed === 0) {
      expect(plain(homeLine(latest)!)).toBe("Kortavgiften står på 0 %");
      expect(homeLink(latest)).toBe("/installningar");
    }
  }, 120_000);

  it("kortavgiften rättad: Hem byter till momsraden utan ny körning", async () => {
    await save(owner, { cardFeeBp: 150, vatRateBp: 0 });
    const v = (await checkViewerFor(db(), fx.orgId))!;
    expect((await latestSelfCheckFor(v))!.notice).toBe("Du närmar dig momsgränsen");
  });

  it("Revisorn har koll: bara ägare och admin, raden försvinner och stannar borta", async () => {
    expect(
      await setVatAcknowledgedFor(viewer, { organizationId: fx.orgId, acknowledged: true }),
    ).toEqual({ ok: false, error: SETTINGS_MESSAGES.forbidden });
    expect(
      await setVatAcknowledgedFor(otherOwner, { organizationId: fx.orgId, acknowledged: true }),
    ).toEqual({ ok: false, error: SETTINGS_MESSAGES.forbidden });
    expect(
      await setVatAcknowledgedFor(admin, { organizationId: fx.orgId, acknowledged: true }),
    ).toEqual({ ok: true, data: { changed: true } });
    expect(
      await setVatAcknowledgedFor(owner, { organizationId: fx.orgId, acknowledged: true }),
    ).toEqual({ ok: true, data: { changed: false } });

    const v = (await checkViewerFor(db(), fx.orgId))!;
    expect((await latestSelfCheckFor(v))!.notice).toBeNull();
    expect(await loadSettingsIssuesFor(owner, fx.orgId, TODAY)).toEqual([]);
    expect(settingsIssues(await querySettingsFacts(db(), fx.orgId, TODAY))).toEqual([]);

    // En ny körning går igenom, och momssatsen är orörd: appen ändrar ingenting själv.
    const r = await runSelfCheck(
      { db: db(), now: NOW },
      {
        organizationId: fx.orgId,
        trigger: "schedule",
      },
    );
    expect(r.checks.find((c) => c.id === "installningar")!.status).toBe("pass");
    const page = await loadSettingsPageFor(owner, fx.orgId);
    expect(page.settings).toMatchObject({ vatRateBp: 0, cardFeeBp: 150 });
    expect(page.settings?.vatOkAt).not.toBeNull();
  }, 120_000);

  it("Revisorn har koll gäller året det trycktes: ett gammalt varnar igen", async () => {
    // Tryckt förra året: i år räknas försäljningen om från noll mot gränsen.
    await db().execute(sql`update public.organization_settings
      set vat_ok_at = '2025-12-01T10:00:00Z' where organization_id = ${fx.orgId}::uuid`);
    expect((await loadSettingsIssuesFor(owner, fx.orgId, TODAY)).map((i) => i.kind)).toEqual([
      "vat",
    ]);
    await runSelfCheck({ db: db(), now: NOW }, { organizationId: fx.orgId, trigger: "schedule" });
    const v = (await checkViewerFor(db(), fx.orgId))!;
    expect((await latestSelfCheckFor(v))!.notice).toBe("Du närmar dig momsgränsen");
    // Knappen sparar på nytt (ett gammalt "har koll" räknas inte som redan tryckt).
    expect(
      await setVatAcknowledgedFor(owner, {
        organizationId: fx.orgId,
        acknowledged: true,
        today: TODAY,
      }),
    ).toEqual({ ok: true, data: { changed: true } });
    expect(await loadSettingsIssuesFor(owner, fx.orgId, TODAY)).toEqual([]);
    expect((await latestSelfCheckFor(v))!.notice).toBeNull();
  }, 120_000);

  it("Varna igen slår på momsraden igen", async () => {
    expect(
      await setVatAcknowledgedFor(owner, { organizationId: fx.orgId, acknowledged: false }),
    ).toEqual({ ok: true, data: { changed: true } });
    expect((await loadSettingsIssuesFor(owner, fx.orgId, TODAY)).map((i) => i.kind)).toEqual([
      "vat",
    ]);
  });
});
