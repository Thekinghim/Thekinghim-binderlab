/**
 * Abonnemang (20261111010000_abonnemang.sql, src/server/subscriptions) mot testdatabasen:
 *  - bara ägare och admin i en plattformsorganisation är plattformsoperatörer,
 *  - kunder (alla roller), en utomstående, service_role och anon kommer aldrig åt
 *    plattformens data eller någon annans plan, och kan inte skriva planer,
 *  - tabellerna i private är stängda för alla klientroller,
 *  - en kund ser sin egen plan och sitt underlag (ägare, admin), utan interna anteckningar,
 *  - planens perioder: ändring från ett datum stänger den förra, bakåtdatering nekas,
 *  - automaternas aktiva perioder (active_from/created_at, active_to, arkivering, exempel).
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { invoiceBasis, mrrOn } from "@/analytics/subscriptions/billing";
import * as s from "@/db/schema";
import type { SessionUser } from "@/server/access";
import {
  isPlatformOperatorFor,
  loadMySubscriptionFor,
  loadPlatformCustomersFor,
  loadPlatformFor,
  savePlanFor,
  type SavePlanInput,
} from "@/server/subscriptions/service";

import {
  asAnon,
  asPostgres,
  asServiceRole,
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const user = (u: TestUser): SessionUser => ({ userId: u.id, email: u.email });

let platformOwner: TestUser;
let platformAdmin: TestUser;
let platformViewer: TestUser;
let platformOrg: string;
let customerOwner: TestUser;
let customerAdmin: TestUser;
let customerViewer: TestUser;
let customerRefiller: TestUser;
let customerOrg: string;
let otherOwner: TestUser;
let otherOrg: string;
let stranger: TestUser;

function plan(organizationId: string, extra: Partial<SavePlanInput> = {}): SavePlanInput {
  return {
    organizationId,
    effectiveFrom: "2026-10-01",
    status: "active",
    price: "499",
    currency: "SEK",
    trialEndsOn: "",
    countryCode: "SE",
    vatNumber: "",
    note: "Intern: rabatt första kvartalet",
    ...extra,
  };
}

beforeAll(async () => {
  platformOwner = await createUser(`plattform-${uniqueSuffix()}@test.binderlab.se`);
  platformOrg = await createOrg(platformOwner, `Plattform ${uniqueSuffix()}`);
  platformAdmin = await createMember(platformOrg, "admin");
  platformViewer = await createMember(platformOrg, "viewer");
  await asPostgres((tx) =>
    tx.execute(
      sql`insert into private.platform_operators (organization_id, note) values (${platformOrg}, 'test')`,
    ),
  );

  customerOwner = await createUser(`kund-${uniqueSuffix()}@test.binderlab.se`);
  customerOrg = await createOrg(customerOwner, `Kund ${uniqueSuffix()}`);
  customerAdmin = await createMember(customerOrg, "admin");
  customerViewer = await createMember(customerOrg, "viewer");
  customerRefiller = await createMember(customerOrg, "refiller");

  otherOwner = await createUser(`annan-${uniqueSuffix()}@test.binderlab.se`);
  otherOrg = await createOrg(otherOwner, `Annan kund ${uniqueSuffix()}`);
  stranger = await createUser(`ingen-${uniqueSuffix()}@test.binderlab.se`);

  // Kundens automater: en aktiv sedan 1 okt., en som slutar 15 nov., en arkiverad 21 okt.
  // (sista dag 20 okt.), en exempelautomat (räknas aldrig) och en utan active_from.
  await asUser(customerOwner, async (tx) => {
    const org = { organizationId: customerOrg };
    await tx.insert(s.machines).values([
      { ...org, code: "K-1", name: "Automat 1", activeFrom: "2026-10-01" },
      { ...org, code: "K-2", name: "Automat 2", activeFrom: "2026-10-01", activeTo: "2026-11-15" },
      { ...org, code: "K-3", name: "Automat 3", activeFrom: "2026-10-01" },
      { ...org, code: "K-4", name: "Exempel", activeFrom: "2026-10-01", isExample: true },
    ]);
  });
  await asPostgres(async (tx) => {
    await tx.execute(
      sql`update public.machines set archived_at = '2026-10-21 08:00+02'
          where organization_id = ${customerOrg} and code = 'K-3'`,
    );
  });
  await asUser(otherOwner, (tx) =>
    tx.insert(s.machines).values({
      organizationId: otherOrg,
      code: "A-1",
      name: "Annans automat",
      activeFrom: "2026-01-01",
    }),
  );
});

describe("vem är plattformsoperatör", () => {
  it("ägare och admin i plattformsorganisationen, inte läsare och inte kunder", async () => {
    expect(await isPlatformOperatorFor(user(platformOwner))).toBe(true);
    expect(await isPlatformOperatorFor(user(platformAdmin))).toBe(true);
    expect(await isPlatformOperatorFor(user(platformViewer))).toBe(false);
    for (const u of [customerOwner, customerAdmin, customerViewer, otherOwner, stranger]) {
      expect(await isPlatformOperatorFor(user(u))).toBe(false);
    }
    expect(await isPlatformOperatorFor(null)).toBe(false);
  });
});

describe("plattformens data och planer är stängda för kunder", () => {
  it("platform_overview_data nekas för alla utom plattformsoperatörer", async () => {
    for (const u of [
      platformViewer,
      customerOwner,
      customerAdmin,
      customerViewer,
      otherOwner,
      stranger,
    ]) {
      const outcome = await asUser(u, (tx) =>
        attempt(tx, (sp) => sp.execute(sql`select public.platform_overview_data()`)),
      );
      expect(outcome.code, u.email).toBe("42501");
    }
    const anon = await asAnon((tx) =>
      attempt(tx, (sp) => sp.execute(sql`select public.platform_overview_data()`)),
    );
    expect(anon.code).toBe("42501");
  });

  it("platform_save_plan nekas för kunder och ändrar inget", async () => {
    for (const u of [customerOwner, customerAdmin, otherOwner, stranger, platformViewer]) {
      const outcome = await asUser(u, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(sql`select public.platform_save_plan(${customerOrg}::uuid, '2026-10-01'::date,
                 'active', 0::bigint, 'SEK', null::date, null, null, null)`),
        ),
      );
      expect(outcome.code, u.email).toBe("42501");
      const result = await savePlanFor(user(u), plan(customerOrg, { price: "0" }));
      expect(result).toEqual({ ok: false, error: "Du har inte behörighet till plattformen." });
    }
    const left = await asPostgres((tx) =>
      rows(
        tx,
        sql`select 1 from private.subscription_plans where organization_id = ${customerOrg}`,
      ),
    );
    expect(left).toEqual([]);
  });

  it("tabellerna i private går inte att läsa eller skriva för någon klientroll", async () => {
    for (const table of ["platform_operators", "subscription_plans", "subscription_customers"]) {
      const rel = sql.raw(`private.${table}`);
      const asCustomer = await asUser(customerOwner, (tx) =>
        attempt(tx, (sp) => sp.execute(sql`select count(*) from ${rel}`)),
      );
      expect(asCustomer.code, table).toBe("42501");
      const asOperator = await asUser(platformOwner, (tx) =>
        attempt(tx, (sp) => sp.execute(sql`select count(*) from ${rel}`)),
      );
      expect(asOperator.code, table).toBe("42501");
      const asService = await asServiceRole((tx) =>
        attempt(tx, (sp) => sp.execute(sql`select count(*) from ${rel}`)),
      );
      expect(asService.code, table).toBe("42501");
    }
    // En kund kan inte göra sig själv till plattformsoperatör.
    const selfPromote = await asUser(customerOwner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into private.platform_operators (organization_id) values (${customerOrg})`,
        ),
      ),
    );
    expect(selfPromote.code).toBe("42501");
    const promoteService = await asServiceRole((tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into private.platform_operators (organization_id) values (${customerOrg})`,
        ),
      ),
    );
    expect(promoteService.code).toBe("42501");
  });
});

describe("planer och fakturaunderlag", () => {
  it("operatören sätter en plan; kunden ser sin egen (ägare, admin) utan anteckning", async () => {
    expect(await savePlanFor(user(platformOwner), plan(customerOrg))).toEqual({ ok: true });
    expect(
      await savePlanFor(
        user(platformAdmin),
        plan(otherOrg, { price: "999", countryCode: "DK", vatNumber: "dk 1234 5678" }),
      ),
    ).toEqual({ ok: true });

    for (const u of [customerOwner, customerAdmin]) {
      const mine = await loadMySubscriptionFor(user(u), customerOrg);
      expect(mine.periods).toEqual([
        {
          validFrom: "2026-10-01",
          validTo: null,
          status: "active",
          pricePerMachineOre: 49_900,
          currency: "SEK",
        },
      ]);
      expect(JSON.stringify(mine)).not.toContain("Intern");
    }
    // Läsare, påfyllare, andra kunder och utomstående nekas.
    for (const u of [customerViewer, customerRefiller, otherOwner, stranger]) {
      const outcome = await asUser(u, (tx) =>
        attempt(tx, (sp) => sp.execute(sql`select public.my_subscription(${customerOrg}::uuid)`)),
      );
      expect(outcome.code, u.email).toBe("42501");
    }
    // Den andra kunden ser bara sin egen plan.
    const other = await loadMySubscriptionFor(user(otherOwner), otherOrg);
    expect(other.periods.map((p) => p.pricePerMachineOre)).toEqual([99_900]);
    expect(other.customer).toEqual({
      countryCode: "DK",
      vatNumber: "DK12345678",
      trialEndsOn: null,
    });
    expect(other.machines.length).toBe(1);
  });

  it("automaternas aktiva perioder: exempel räknas aldrig, arkivering stänger dagen före", async () => {
    const mine = await loadMySubscriptionFor(user(customerOwner), customerOrg);
    const ranges = mine.machines.map((m) => [m.activeFrom, m.activeTo]).sort();
    expect(ranges).toEqual([
      ["2026-10-01", null],
      ["2026-10-01", "2026-10-20"],
      ["2026-10-01", "2026-11-15"],
    ]);
    // Oktober: 31 + 31 + 20 = 82 automatdagar × 499 kr / 31.
    const oct = invoiceBasis(mine, "2026-10");
    expect(oct.activeMachines).toBe(3);
    expect(oct.billableMachineDays).toBe(82);
    expect(oct.totals[0]).toEqual({
      currency: "SEK",
      netOre: Math.round((49_900 * 82) / 31),
      vatOre: Math.round((Math.round((49_900 * 82) / 31) * 25) / 100),
      totalOre:
        Math.round((49_900 * 82) / 31) + Math.round((Math.round((49_900 * 82) / 31) * 25) / 100),
    });
    expect(mrrOn(mine, "2026-11-05")).toEqual({ currency: "SEK", amountOre: 99_800 });
  });

  it("ändring från ett datum stänger förra perioden; bakåtdatering nekas", async () => {
    expect(
      await savePlanFor(
        user(platformOwner),
        plan(customerOrg, { effectiveFrom: "2026-11-16", price: "599" }),
      ),
    ).toEqual({ ok: true });
    expect(
      await savePlanFor(
        user(platformOwner),
        plan(customerOrg, { effectiveFrom: "2026-11-01", price: "1" }),
      ),
    ).toEqual({
      ok: false,
      error: "Datumet ligger före den nuvarande planen. Välj samma dag eller senare.",
    });
    // Samma dag som senaste perioden: skrivs över.
    expect(
      await savePlanFor(
        user(platformOwner),
        plan(customerOrg, { effectiveFrom: "2026-11-16", price: "549,50" }),
      ),
    ).toEqual({ ok: true });
    // Oförändrat pris och status: ingen ny period.
    expect(
      await savePlanFor(
        user(platformOwner),
        plan(customerOrg, { effectiveFrom: "2026-12-01", price: "549,50" }),
      ),
    ).toEqual({ ok: true });
    const mine = await loadMySubscriptionFor(user(customerAdmin), customerOrg);
    expect(mine.periods).toEqual([
      {
        validFrom: "2026-10-01",
        validTo: "2026-11-15",
        status: "active",
        pricePerMachineOre: 49_900,
        currency: "SEK",
      },
      {
        validFrom: "2026-11-16",
        validTo: null,
        status: "active",
        pricePerMachineOre: 54_950,
        currency: "SEK",
      },
    ]);
  });

  it("ogiltiga värden nekas med tydliga fel", async () => {
    const op = user(platformOwner);
    expect((await savePlanFor(op, plan(customerOrg, { price: "abc" }))).error).toMatch(/pris/);
    expect(
      (await savePlanFor(op, plan(customerOrg, { effectiveFrom: "2026-13-01" }))).error,
    ).toMatch(/datum/);
    expect((await savePlanFor(op, plan(customerOrg, { countryCode: "Sverige" }))).error).toMatch(
      /två bokstäver/,
    );
    expect((await savePlanFor(op, plan(customerOrg, { vatNumber: "x" }))).error).toMatch(
      /Momsnumret/,
    );
    expect((await savePlanFor(op, plan(customerOrg, { status: "gratis" }))).ok).toBe(false);
    expect((await savePlanFor(op, plan(customerOrg, { currency: "USD" }))).ok).toBe(false);
    expect((await savePlanFor(op, plan("00000000-0000-4000-8000-000000000000"))).error).toBe(
      "Kunden finns inte.",
    );
  });

  it("plattformen: kunderna med planer, anteckningar och totaler", async () => {
    const customers = await loadPlatformCustomersFor(user(platformAdmin));
    const kund = customers.find((c) => c.id === customerOrg)!;
    expect(kund.periods.length).toBe(2);
    expect(kund.notes.map((n) => n.note)).toContain("Intern: rabatt första kvartalet");
    expect(kund.machines.length).toBe(3);
    expect(customers.find((c) => c.id === platformOrg)?.operator).toBe(true);
    const data = await loadPlatformFor(user(platformOwner), "2026-11-05", 3);
    const row = data.rows.find((r) => r.customer.id === customerOrg)!;
    expect(row.summary.state).toBe("active");
    expect(row.summary.machinesNow).toBe(2);
    expect(data.history.map((h) => h.month)).toEqual(["2026-09", "2026-10", "2026-11"]);
    expect(data.totals.mrr.find((m) => m.currency === "SEK")!.amountOre).toBeGreaterThanOrEqual(
      99_800 + 99_900,
    );
  });

  it("en plattformsoperatör som tas bort ur plattformsorganisationen förlorar åtkomsten", async () => {
    const temp = await createMember(platformOrg, "admin");
    expect(await isPlatformOperatorFor(user(temp))).toBe(true);
    await asPostgres((tx) =>
      tx.execute(
        sql`delete from public.memberships where organization_id = ${platformOrg} and user_id = ${temp.id}`,
      ),
    );
    expect(await isPlatformOperatorFor(user(temp))).toBe(false);
  });
});
