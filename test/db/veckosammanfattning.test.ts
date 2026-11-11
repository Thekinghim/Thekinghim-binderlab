/**
 * Veckosammanfattningen (src/server/weekly) mot testdatabasen: måndagens notis.
 *
 * En organisation med en automat i en butik med 20 % provision, två titlar med inköpspris
 * och order i tre veckor: veckan innan (26 okt–1 nov 2026), förra veckan (2–8 nov) och
 * veckan som pågår (9 nov). Jobbet körs måndag 9 november 07:07 svensk tid.
 *
 *   1. Innehållet: sålda pack och vinst förra veckan mot veckan innan, bästa produkten och
 *      antalet i Att göra. Vinsten är FÖRE butikernas andel. Ägaren får svenska och sidan
 *      Veckan; delägaren med Enkel vy får engelska och Försäljning, utan Att göra (listan
 *      finns inte i den enkla vyn).
 *   2. En gång per vecka: en andra körning, och två samtidiga, skickar ingenting mer.
 *   3. Vem: bara ägare och admin, bara med en påslagen telefon, bara med knappen på
 *      (eller, när den inte är vald, "Notiser i mobilen" på). Aldrig från en demo, aldrig
 *      en annan dag än måndag, aldrig före 07:00, aldrig utan konfigurerad push.
 *   4. Knappen sparas under RLS i den egna profilen, också i den enkla vyn. Raderna i
 *      weekly_summaries skrivs bara av servern.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
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

import { weekPeriods } from "@/app/(app)/veckan/_lib/model";
import * as s from "@/db/schema";
import { profitability } from "@/domain";
import { listOrganizationsFor } from "@/server/access";
import { saveNoticeChange } from "@/server/alerts/notice-service";
import { loadDomainInputFor, type Viewer } from "@/server/data/core/loaders";
import { loadTodoCountFor } from "@/server/data/todos";
import type { PushOutcome, PushPayload, PushSender, PushTarget } from "@/server/notify/push";
import { runWeeklySummaries, weeklyEnabled } from "@/server/weekly/job";
import { loadWeeklyPref, saveWeeklyPref } from "@/server/weekly/prefs";
import { loadWeeklySummaryFor } from "@/server/weekly/summary";

import {
  asServiceRole,
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  rows,
  type TestUser,
} from "./helpers";

const NBSP = " ";
/** Måndag 9 november 2026 07:07 svensk tid (vintertid). */
const MONDAY = new Date("2026-11-09T06:07:00Z");
const WEEK = "2026-11-02";

interface Sent {
  readonly endpoint: string;
  readonly payload: PushPayload;
}

/** Push-adapter som minns vad som skickades. `fail`: adresser som inte tar emot. */
function fakeSender(options: { fail?: (endpoint: string) => "gone" | "error" | null } = {}) {
  const sent: Sent[] = [];
  const sender: PushSender = {
    kind: "outbox",
    async send(target: PushTarget, payload: PushPayload): Promise<PushOutcome> {
      const failure = options.fail?.(target.endpoint) ?? null;
      if (failure) return { ok: false, gone: failure === "gone", detail: failure };
      sent.push({ endpoint: target.endpoint, payload });
      return { ok: true, detail: "test" };
    },
  };
  return { sender, sent };
}

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

async function addDevice(orgId: string, user: TestUser): Promise<string> {
  const endpoint = `https://fcm.googleapis.com/fcm/send/${randomUUID()}`;
  await asUser(user, (tx) =>
    tx.insert(s.pushSubscriptions).values({
      organizationId: orgId,
      userId: user.id,
      endpoint,
      p256dh: "p".repeat(40),
      authSecret: "a".repeat(16),
    }),
  );
  return endpoint;
}

const setPref = (orgId: string, user: TestUser, on: boolean) =>
  asUser(user, (tx) => saveWeeklyPref(tx, { orgId, userId: user.id, email: user.email }, on));

async function summaryRows(orgId: string, week = WEEK) {
  return rows<{
    user_id: string;
    status: string;
    locale: string;
    title: string;
    body: string;
    url: string;
    devices: number;
    figures: {
      last: { packs: number; profitOre: number };
      previous: { packs: number; profitOre: number };
      best: { name: string; packs: number } | null;
      todos: number | null;
    };
  }>(
    db(),
    sql`select user_id::text as user_id, status, locale, title, body, url, devices, figures
        from public.weekly_summaries
        where organization_id = ${orgId}::uuid and week_start = ${week}::date
        order by created_at`,
  );
}

let orgId: string;
let owner: TestUser;
let partner: TestUser;
let admin: TestUser;
let viewer: TestUser;
let refiller: TestUser;
let ownerDevice: string;
let partnerDevice: string;

/** En order per rad: [dag, klockslag (UTC), titel]. */
async function seedOrders(titleA: string, titleB: string, ctx: Record<string, string>) {
  const plan: [string, string][] = [
    // Veckan innan (26 okt–1 nov): 3 pack av A.
    ["2026-10-26T10:00:00Z", titleA],
    ["2026-10-28T10:00:00Z", titleA],
    ["2026-11-01T10:00:00Z", titleA],
    // Förra veckan (2–8 nov): 2 pack av A och 3 av B.
    ["2026-11-02T10:00:00Z", titleA],
    ["2026-11-04T10:00:00Z", titleA],
    ["2026-11-03T10:00:00Z", titleB],
    ["2026-11-05T10:00:00Z", titleB],
    // Söndag 8 november 23:30 svensk tid hör till förra veckan.
    ["2026-11-08T22:30:00Z", titleB],
    // Veckan som pågår: måndag 9 november 00:30 svensk tid räknas inte.
    ["2026-11-08T23:30:00Z", titleB],
  ];
  await asUser(owner, (tx) =>
    tx.insert(s.orders).values(
      plan.map(([at, titleId], i) => ({
        organizationId: orgId,
        dataSourceId: ctx.source!,
        externalId: `V-${i}`,
        rawTitle: titleId === titleA ? "Prismatic Evolutions" : "Surging Sparks",
        titleId,
        orderedAt: new Date(at),
        amountOre: titleId === titleA ? 10_000 : 7_500,
        paymentMethod: "card",
        sourceMachineId: ctx.sourceMachine!,
        machineId: ctx.machine!,
        importId: ctx.import!,
        sourceHash: `vecka-${i}`,
      })),
    ),
  );
}

beforeAll(async () => {
  owner = await createUser();
  orgId = await createOrg(owner, "Veckan AB");
  partner = await createMember(orgId, "owner");
  admin = await createMember(orgId, "admin");
  viewer = await createMember(orgId, "viewer");
  refiller = await createMember(orgId, "refiller");
  await db().execute(
    sql`update public.memberships set view_mode = 'simple'
        where organization_id = ${orgId}::uuid and user_id = ${partner.id}::uuid`,
  );
  await db().execute(
    sql`update public.profiles set locale = 'en'
        where organization_id = ${orgId}::uuid and user_id = ${partner.id}::uuid`,
  );

  const ctx = await asUser(owner, async (tx) => {
    const org = { organizationId: orgId };
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: "ICA Lund" })
      .returning();
    const [contract] = await tx
      .insert(s.contracts)
      .values({ ...org, storeId: store!.id, validFrom: "2026-01-01" })
      .returning();
    await tx.insert(s.storeAgreements).values({
      ...org,
      storeId: store!.id,
      contractId: contract!.id,
      validFrom: "2026-01-01",
      commissionBp: 2000,
    });
    const [machine] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-001", name: "Automat 1", activeFrom: "2026-01-01" })
      .returning();
    await tx
      .insert(s.machinePlacements)
      .values({ ...org, machineId: machine!.id, storeId: store!.id, validFrom: "2026-01-01" });
    const [a, b] = await tx
      .insert(s.titles)
      .values([
        { ...org, name: "Prismatic Evolutions" },
        { ...org, name: "Surging Sparks" },
      ])
      .returning();
    await tx.insert(s.purchasePrices).values([
      { ...org, titleId: a!.id, unitCostOre: 5_000, validFrom: "2026-01-01" },
      { ...org, titleId: b!.id, unitCostOre: 5_000, validFrom: "2026-01-01" },
    ]);
    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
      .returning();
    const [sourceMachine] = await tx
      .insert(s.sourceMachines)
      .values({
        ...org,
        dataSourceId: source!.id,
        externalId: "AW-1",
        externalName: "Automat 1",
        machineId: machine!.id,
      })
      .returning();
    const [imp] = await tx
      .insert(s.imports)
      .values({
        ...org,
        dataSourceId: source!.id,
        trigger: "upload",
        fileName: "orders.csv",
        fileSha256: "b".repeat(64),
        storagePath: `${orgId}/imports/orders.csv`,
        parserVersion: "awish-csv@1",
        rowsTotal: 9,
        rowsNew: 9,
        status: "succeeded",
      })
      .returning();
    return {
      a: a!.id,
      b: b!.id,
      source: source!.id,
      sourceMachine: sourceMachine!.id,
      machine: machine!.id,
      import: imp!.id,
    };
  });
  await seedOrders(ctx.a, ctx.b, ctx);

  ownerDevice = await addDevice(orgId, owner);
  partnerDevice = await addDevice(orgId, partner);
  await setPref(orgId, owner, true);
  await setPref(orgId, partner, true);
}, 120_000);

describe("veckosammanfattningen: innehållet", () => {
  it("siffrorna: förra veckan mot veckan innan, bästa produkten, före butikernas andel", async () => {
    const v = await viewerFor(owner, orgId);
    const summary = await loadWeeklySummaryFor(v, weekPeriods(WEEK), MONDAY, {
      todos: () => loadTodoCountFor(v, MONDAY),
    });
    // Organisationen har ingen moms inlagd: 10 000 öre − 5 000 inköp = 5 000 per pack av A,
    // 7 500 − 5 000 = 2 500 per pack av B.
    expect(summary.lastFigures).toMatchObject({ packs: 5, profitOre: 2 * 5_000 + 3 * 2_500 });
    expect(summary.previousFigures).toMatchObject({ packs: 3, profitOre: 15_000 });
    // Mest vinst: A (10 000 öre på 2 pack), inte B (7 500 öre på 3 pack).
    expect(summary.best).toMatchObject({
      name: "Prismatic Evolutions",
      packs: 2,
      profitOre: 10_000,
    });
    expect(summary.todos).toBe(await loadTodoCountFor(v, MONDAY));

    // Samma period med butikernas andel dragen ger en lägre vinst: notisen visar inte den.
    const withShare = await loadDomainInputFor(
      v,
      { period: weekPeriods(WEEK).last, compare: null, storeShare: true },
      MONDAY,
    );
    const after = profitability(withShare.current, "title").totals;
    expect(after.profitBeforeShareOre).toBe(17_500);
    expect(after.profitOre).toBeLessThan(17_500);
  });

  it("måndag 07:07: ägaren får svenska och Veckan, delägaren engelska och Försäljning", async () => {
    const { sender, sent } = fakeSender();
    const result = await runWeeklySummaries(db(), MONDAY, { only: [orgId], sender });
    expect(result.organizations).toEqual([
      expect.objectContaining({
        organizationId: orgId,
        status: "ran",
        week: WEEK,
        sent: 2,
        failed: 0,
        already: 0,
        errors: 0,
      }),
    ]);
    expect(sent).toHaveLength(2);

    const toOwner = sent.find((x) => x.endpoint === ownerDevice)!.payload;
    const todos = await loadTodoCountFor(await viewerFor(owner, orgId), MONDAY);
    const todoSv =
      todos === 0 ? "" : todos === 1 ? " 1 sak att göra." : ` ${todos} saker att göra.`;
    expect(toOwner.title).toBe(`Förra veckan: 5${NBSP}pack, 175${NBSP}kr vinst`);
    expect(toOwner.body).toBe(
      `Veckan innan: 3${NBSP}pack, 150${NBSP}kr. Bäst: Prismatic Evolutions.${todoSv}`,
    );
    expect(toOwner.url).toBe(`/veckan?v=${WEEK}`);
    expect(toOwner.tag).toBe(`vecka-${WEEK}`);
    expect(toOwner.severity).toBe("info");
    expect(toOwner.lang).toBe("sv");

    const toPartner = sent.find((x) => x.endpoint === partnerDevice)!.payload;
    // Delägarens notis nämner inte Att göra (listan finns inte i den enkla vyn).
    expect(toPartner.title).toBe(`Last week: 5${NBSP}packs, 175${NBSP}kr profit`);
    expect(toPartner.body).toBe(
      `Week before: 3${NBSP}packs, 150${NBSP}kr. Best: Prismatic Evolutions.`,
    );
    expect(toPartner.url).toBe(`/?vecka=${WEEK}`);
    expect(toPartner.lang).toBe("en");
    // Inget svenskt i delägarens notis.
    expect(`${toPartner.title} ${toPartner.body}`).not.toMatch(/vecka|vinst|sålt|göra/i);

    const saved = await summaryRows(orgId);
    expect(saved).toHaveLength(2);
    const ownerRow = saved.find((r) => r.user_id === owner.id)!;
    expect(ownerRow).toMatchObject({
      status: "sent",
      locale: "sv",
      title: toOwner.title,
      body: toOwner.body,
      url: toOwner.url,
      devices: 1,
    });
    expect(ownerRow.figures).toMatchObject({
      last: { packs: 5, profitOre: 17_500 },
      previous: { packs: 3, profitOre: 15_000 },
      best: { name: "Prismatic Evolutions", packs: 2 },
      todos,
    });
    expect(saved.find((r) => r.user_id === partner.id)).toMatchObject({
      status: "sent",
      locale: "en",
      url: `/?vecka=${WEEK}`,
    });
    expect(saved.find((r) => r.user_id === partner.id)!.figures.todos).toBeNull();
  });
});

describe("veckosammanfattningen: en gång per vecka", () => {
  it("en andra körning samma måndag (och senare samma dag) skickar ingenting", async () => {
    for (const now of [MONDAY, new Date("2026-11-09T15:00:00Z")]) {
      const { sender, sent } = fakeSender();
      const result = await runWeeklySummaries(db(), now, { only: [orgId], sender });
      expect(sent).toEqual([]);
      expect(result.organizations[0]).toMatchObject({ status: "ran", sent: 0, already: 2 });
    }
    expect(await summaryRows(orgId)).toHaveLength(2);
  });

  it("två samtidiga körningar för en ny vecka skickar en notis per person", async () => {
    const next = new Date("2026-11-16T06:07:00Z");
    const a = fakeSender();
    const b = fakeSender();
    const [ra, rb] = await Promise.all([
      runWeeklySummaries(db(), next, { only: [orgId], sender: a.sender }),
      runWeeklySummaries(db(), next, { only: [orgId], sender: b.sender }),
    ]);
    const all = [...a.sent, ...b.sent];
    expect(all).toHaveLength(2);
    expect(new Set(all.map((x) => x.endpoint))).toEqual(new Set([ownerDevice, partnerDevice]));
    expect((ra.organizations[0]!.sent ?? 0) + (rb.organizations[0]!.sent ?? 0)).toBe(2);
    expect(await summaryRows(orgId, "2026-11-09")).toHaveLength(2);
    // Databasen stoppar en andra rad för samma person och vecka.
    const dup = await asServiceRole((tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.weekly_summaries
                (organization_id, user_id, week_start, locale, title, body, url)
              values (${orgId}::uuid, ${owner.id}::uuid, '2026-11-09', 'sv', 'x', 'y', '/veckan')`,
        ),
      ),
    );
    expect(dup.ok).toBe(false);
  });

  it("en vecka där ingen telefon fick notisen provas igen, och skickas då en gång", async () => {
    const week3 = new Date("2026-11-23T06:07:00Z");
    const down = fakeSender({ fail: () => "error" });
    const first = await runWeeklySummaries(db(), week3, { only: [orgId], sender: down.sender });
    expect(first.organizations[0]).toMatchObject({ sent: 0, failed: 2 });
    expect((await summaryRows(orgId, "2026-11-16")).map((r) => r.status)).toEqual([
      "failed",
      "failed",
    ]);
    const up = fakeSender();
    const second = await runWeeklySummaries(db(), week3, { only: [orgId], sender: up.sender });
    expect(second.organizations[0]).toMatchObject({ sent: 2, failed: 0 });
    expect(up.sent).toHaveLength(2);
    const third = fakeSender();
    await runWeeklySummaries(db(), week3, { only: [orgId], sender: third.sender });
    expect(third.sent).toEqual([]);
    expect((await summaryRows(orgId, "2026-11-16")).map((r) => r.status)).toEqual(["sent", "sent"]);
  });
});

describe("veckosammanfattningen: vem och när", () => {
  /** En ny organisation per test: en ägare med order saknas inte för reglerna här. */
  async function freshOrg(name: string) {
    const o = await createUser();
    const id = await createOrg(o, name);
    return { owner: o, orgId: id };
  }
  const run = (id: string, now = MONDAY, sender = fakeSender()) =>
    runWeeklySummaries(db(), now, { only: [id], sender: sender.sender }).then((result) => ({
      result,
      sent: sender.sent,
    }));

  it("skickas inte en annan dag än måndag, och inte före 07:00", async () => {
    const f = await freshOrg("När");
    await addDevice(f.orgId, f.owner);
    await setPref(f.orgId, f.owner, true);
    const sunday = await run(f.orgId, new Date("2026-11-08T10:00:00Z"));
    expect(sunday.sent).toEqual([]);
    expect(sunday.result.organizations[0]).toMatchObject({
      status: "skipped",
      reason: "not_monday",
    });
    const early = await run(f.orgId, new Date("2026-11-09T05:07:00Z"));
    expect(early.sent).toEqual([]);
    expect(early.result.organizations[0]).toMatchObject({ status: "skipped", reason: "not_yet" });
    const tuesday = await run(f.orgId, new Date("2026-11-10T06:07:00Z"));
    expect(tuesday.sent).toEqual([]);
    expect(await summaryRows(f.orgId)).toEqual([]);
    // Måndag 07:07 går den (utan försäljning: "inget sålt").
    const monday = await run(f.orgId);
    expect(monday.sent).toHaveLength(1);
    expect(monday.sent[0]!.payload.title).toBe("Förra veckan: inget sålt");
  });

  it("utan telefon med notiser skickas och sparas ingenting", async () => {
    const f = await freshOrg("Ingen telefon");
    await setPref(f.orgId, f.owner, true);
    const none = await run(f.orgId);
    expect(none.sent).toEqual([]);
    expect(none.result.organizations).toEqual([]);
    // En avstängd telefon (push-tjänsten känner inte igen den) räknas inte.
    await addDevice(f.orgId, f.owner);
    await db().execute(
      sql`update public.push_subscriptions set disabled_at = now()
          where organization_id = ${f.orgId}::uuid`,
    );
    expect((await run(f.orgId)).sent).toEqual([]);
    expect(await summaryRows(f.orgId)).toEqual([]);
  });

  it("knappen av: ingenting. Inte vald: följer Notiser i mobilen", async () => {
    const f = await freshOrg("Knappen");
    const ctx = { orgId: f.orgId, userId: f.owner.id, role: "owner" };
    await addDevice(f.orgId, f.owner);
    // Inte vald och inga notiser i mobilen: av.
    expect((await run(f.orgId)).sent).toEqual([]);
    expect(await summaryRows(f.orgId)).toEqual([]);
    expect(weeklyEnabled(null, null)).toBe(false);
    expect(weeklyEnabled(null, true)).toBe(true);
    expect(weeklyEnabled(false, true)).toBe(false);
    expect(weeklyEnabled(true, false)).toBe(true);

    // Uttryckligen av slår "Notiser i mobilen" på.
    await asUser(f.owner, (tx) => saveNoticeChange(tx, ctx, { on: true }));
    await setPref(f.orgId, f.owner, false);
    expect((await run(f.orgId)).sent).toEqual([]);
    expect(await summaryRows(f.orgId)).toEqual([]);
    const off = await asUser(f.owner, (tx) => loadWeeklyPref(tx, f.orgId, f.owner.id));
    expect(off).toMatchObject({ on: false, chosen: false });
    expect(off.endpoints).toHaveLength(1);

    // Inte vald (null) och Notiser i mobilen på: skickas.
    await db().execute(
      sql`update public.profiles set weekly_summary = null
          where organization_id = ${f.orgId}::uuid and user_id = ${f.owner.id}::uuid`,
    );
    expect(await asUser(f.owner, (tx) => loadWeeklyPref(tx, f.orgId, f.owner.id))).toMatchObject({
      on: true,
      chosen: null,
    });
    expect((await run(f.orgId)).sent).toHaveLength(1);
  });

  it("bara ägare och admin: läsaren och påfyllaren får ingenting, inte ens med knappen på", async () => {
    await addDevice(orgId, viewer);
    await addDevice(orgId, refiller);
    const adminDevice = await addDevice(orgId, admin);
    // Knappen på direkt i databasen (servern släpper inte in läsaren och påfyllaren).
    await db().execute(
      sql`update public.profiles set weekly_summary = true
          where organization_id = ${orgId}::uuid
            and user_id in (${viewer.id}::uuid, ${refiller.id}::uuid, ${admin.id}::uuid)`,
    );
    const { result, sent } = await run(orgId, new Date("2026-11-30T06:07:00Z"));
    expect(new Set(sent.map((x) => x.endpoint))).toEqual(
      new Set([ownerDevice, partnerDevice, adminDevice]),
    );
    expect(result.organizations[0]).toMatchObject({ sent: 3 });
    const got = await summaryRows(orgId, "2026-11-23");
    expect(got.map((r) => r.user_id).sort()).toEqual([owner.id, partner.id, admin.id].sort());
  });

  it("en telefon som push-tjänsten inte känner igen stängs av; de andra får notisen", async () => {
    const f = await freshOrg("Gammal telefon");
    const old = await addDevice(f.orgId, f.owner);
    const fresh = await addDevice(f.orgId, f.owner);
    await setPref(f.orgId, f.owner, true);
    const out = await run(
      f.orgId,
      MONDAY,
      fakeSender({ fail: (e) => (e === old ? "gone" : null) }),
    );
    expect(out.sent.map((x) => x.endpoint)).toEqual([fresh]);
    const devices = await rows<{ endpoint: string; disabled: boolean }>(
      db(),
      sql`select endpoint, disabled_at is not null as disabled from public.push_subscriptions
          where organization_id = ${f.orgId}::uuid`,
    );
    expect(devices.find((d) => d.endpoint === old)?.disabled).toBe(true);
    expect(devices.find((d) => d.endpoint === fresh)?.disabled).toBe(false);
    expect((await summaryRows(f.orgId))[0]).toMatchObject({ status: "sent", devices: 1 });
  });

  it("en demo och en arkiverad organisation skickar ingenting", async () => {
    const f = await freshOrg("Demo");
    await addDevice(f.orgId, f.owner);
    await setPref(f.orgId, f.owner, true);
    await db().execute(
      sql`update public.organizations set is_demo = true where id = ${f.orgId}::uuid`,
    );
    expect((await run(f.orgId)).sent).toEqual([]);
    await db().execute(
      sql`update public.organizations set is_demo = false, archived_at = now()
          where id = ${f.orgId}::uuid`,
    );
    expect((await run(f.orgId)).sent).toEqual([]);
    expect(await summaryRows(f.orgId)).toEqual([]);
  });

  it("ett fel i en organisation stoppar inte de andra", async () => {
    // Postgres godtar tidszonen "Factory", Node gör det inte: den organisationens körning
    // går fel. Nästa organisation ska få sin notis ändå.
    const bad = await freshOrg("Trasig tidszon");
    await addDevice(bad.orgId, bad.owner);
    await setPref(bad.orgId, bad.owner, true);
    await db().execute(
      sql`update public.organizations set timezone = 'Factory' where id = ${bad.orgId}::uuid`,
    );
    const good = await freshOrg("Hel");
    await addDevice(good.orgId, good.owner);
    await setPref(good.orgId, good.owner, true);
    const { sender, sent } = fakeSender();
    const result = await runWeeklySummaries(db(), MONDAY, {
      only: [bad.orgId, good.orgId],
      sender,
    });
    expect(sent).toHaveLength(1);
    expect(result.organizations.find((o) => o.organizationId === good.orgId)).toMatchObject({
      status: "ran",
      sent: 1,
    });
    expect(result.organizations.find((o) => o.organizationId === bad.orgId)).toMatchObject({
      status: "ran",
      errors: 1,
    });
    expect(await summaryRows(bad.orgId)).toEqual([]);
  });

  it("utan konfigurerad push skickas och sparas ingenting", async () => {
    const f = await freshOrg("Push av");
    await addDevice(f.orgId, f.owner);
    await setPref(f.orgId, f.owner, true);
    const result = await runWeeklySummaries(db(), MONDAY, { only: [f.orgId], sender: null });
    expect(result.organizations).toEqual([
      { organizationId: f.orgId, status: "skipped", reason: "push_off" },
    ]);
    expect(await summaryRows(f.orgId)).toEqual([]);
  });
});

describe("veckosammanfattningen: behörighet (RLS)", () => {
  it("var och en sparar sin egen knapp, också delägaren i den enkla vyn", async () => {
    await setPref(orgId, partner, false);
    expect(await asUser(partner, (tx) => loadWeeklyPref(tx, orgId, partner.id))).toMatchObject({
      on: false,
      chosen: false,
    });
    // Ägarens knapp rördes inte.
    expect(await asUser(owner, (tx) => loadWeeklyPref(tx, orgId, owner.id))).toMatchObject({
      on: true,
      chosen: true,
    });
    await setPref(orgId, partner, true);
  });

  it("profilen skapas om den saknas", async () => {
    const o = await createUser();
    const id = await createOrg(o, "Utan profil");
    await db().execute(
      sql`delete from public.push_subscriptions where organization_id = ${id}::uuid`,
    );
    const before = await rows(
      db(),
      sql`select 1 from public.profiles where organization_id = ${id}::uuid and user_id = ${o.id}::uuid`,
    );
    await setPref(id, o, true);
    const after = await rows<{ weekly_summary: boolean; display_name: string }>(
      db(),
      sql`select weekly_summary, display_name from public.profiles
          where organization_id = ${id}::uuid and user_id = ${o.id}::uuid`,
    );
    expect(after).toHaveLength(1);
    expect(after[0]!.weekly_summary).toBe(true);
    if (before.length > 0) expect(after[0]!.display_name.length).toBeGreaterThan(0);
  });

  it("delägaren med Enkel vy kan inte ändra någon annans knapp", async () => {
    const out = await asUser(partner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.profiles set weekly_summary = false
              where organization_id = ${orgId}::uuid and user_id = ${owner.id}::uuid`,
        ),
      ),
    );
    const [row] = await rows<{ weekly_summary: boolean }>(
      db(),
      sql`select weekly_summary from public.profiles
          where organization_id = ${orgId}::uuid and user_id = ${owner.id}::uuid`,
    );
    expect(out.ok && row!.weekly_summary === false).toBe(false);
    expect(row!.weekly_summary).toBe(true);
  });

  it("ingen användare skriver i weekly_summaries; läsaren och påfyllaren ser inte andras", async () => {
    for (const u of [owner, admin, viewer, refiller]) {
      const ins = await asUser(u, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`insert into public.weekly_summaries
                  (organization_id, user_id, week_start, locale, title, body, url)
                values (${orgId}::uuid, ${u.id}::uuid, '2026-01-05', 'sv', 'x', 'y', '/veckan')`,
          ),
        ),
      );
      expect(ins.ok, u.email).toBe(false);
      const upd = await asUser(u, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`update public.weekly_summaries set title = 'ändrad'
                where organization_id = ${orgId}::uuid`,
          ),
        ),
      );
      expect(upd.ok, u.email).toBe(false);
    }
    const seen = (u: TestUser) =>
      asUser(u, (tx) =>
        rows<{ n: number }>(
          tx,
          sql`select count(*)::int as n from public.weekly_summaries
              where organization_id = ${orgId}::uuid`,
        ),
      ).then((r) => r[0]!.n);
    expect(await seen(owner)).toBeGreaterThan(0);
    expect(await seen(viewer)).toBe(0);
    expect(await seen(refiller)).toBe(0);
    // En utomstående ser ingenting.
    const outsider = await createUser();
    await createOrg(outsider, "Annan");
    expect(await seen(outsider)).toBe(0);
  });

  it("påfyllaren kan inte läsa siffrorna (ingen ekonomi)", async () => {
    const v = await viewerFor(refiller, orgId);
    await expect(loadWeeklySummaryFor(v, weekPeriods(WEEK), MONDAY)).rejects.toThrow();
  });
});
