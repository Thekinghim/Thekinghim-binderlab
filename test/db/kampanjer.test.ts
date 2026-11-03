/**
 * Kampanjer och gratis-pack mot testdatabasen och låtsas-Awish (aldrig riktiga Awish):
 *
 * - kampanj "nu" skickas till alla kopplade automater; Awish id sparas; bilden lagras;
 * - planerad kampanj skickas först av den schemalagda körningen när starten passerat;
 * - Awish nej → misslyckad med Awish text; Försök igen; Stäng av sätter utgångstiden nu;
 * - gratis-pack: koder läses tillbaka, kostnaden = inköpspris × antal och syns i Lönsamhetens
 *   avdrag; misslyckat försök kostar inget; läsaren ser listan men inte koderna;
 * - behörighet: läsaren och påfyllaren kan inte skapa; en annan organisation kan inte se,
 *   stänga av eller läsa bilder; klientroller kan inte skriva i tabellerna.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { LocalFileStore } from "../../src/import/file-store";
import { AuthorizationError, listOrganizationsFor } from "../../src/server/access";
import { AwishApiError, createAwishClient } from "../../src/server/awish/grpc-client";
import { saveAwishCredentialsFor } from "../../src/server/awish/manage";
import type { MarketingConnect } from "../../src/server/awish/marketing";
import {
  createCampaignFor,
  loadCampaignPageFor,
  publishAllDueCampaigns,
  readCampaignImageFor,
  retryCampaignFor,
  stopCampaignFor,
} from "../../src/server/campaigns/service";
import { loadProfitAdjustmentsFor } from "../../src/server/data/adjustments";
import type { Viewer } from "../../src/server/data/core/loaders";
import {
  createFreePacksFor,
  freePackChoicesFor,
  loadFreePackPageFor,
} from "../../src/server/free-packs/service";
import { startFakeAwish, type FakeAwish } from "../../src/server/awish/testing/fake-server";

import {
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  rows,
  type TestUser,
} from "./helpers";

vi.mock("server-only", () => ({}));

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
const SVG = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>');

let fake: FakeAwish;
let store: LocalFileStore;
const env = { CAMPAIGN_STORAGE: "local", APP_URL: "https://app.test" };
const connect = (creds: { appId: string; appSecret: string; appKey: string }) =>
  createAwishClient(creds, { address: fake.address, tls: false, sleep: async () => {} });
let now = new Date("2026-11-03T09:00:00Z");
const deps = () => ({ connect, store, env, now: () => now });

let owner: TestUser;
let viewerUser: TestUser;
let refiller: TestUser;
let orgId: string;
let m1: string;
let m2: string;
let m3: string;
let titleId: string;

beforeAll(async () => {
  store = new LocalFileStore(await mkdtemp(path.join(tmpdir(), "kampanjer-")));
  fake = await startFakeAwish({
    machines: [
      { id: "2", name: "Sega gubben", machine_no: "1" },
      { id: "3", name: "Centrum", machine_no: "2" },
    ],
    products: {
      "2": [
        { channel: "A1", good: "Surging Sparks", current: 4, capacity: 8 },
        { channel: "A2", good: "Black Bolt", current: 0, capacity: 8 },
      ],
      "3": [{ channel: "A1", good: "Surging Sparks", current: 6, capacity: 8 }],
    },
  });
  owner = await createUser();
  orgId = await createOrg(owner);
  viewerUser = await createMember(orgId, "viewer");
  refiller = await createMember(orgId, "refiller");
  const machines = await asUser(owner, (tx) =>
    tx
      .insert(s.machines)
      .values([
        { organizationId: orgId, code: "BL-001", name: "Sega gubben", activeFrom: "2026-10-01" },
        { organizationId: orgId, code: "BL-002", name: "Centrum", activeFrom: "2026-10-01" },
        { organizationId: orgId, code: "BL-003", name: "Okopplad", activeFrom: "2026-10-01" },
      ])
      .returning(),
  );
  [m1, m2, m3] = machines.map((m) => m.id) as [string, string, string];
  const { dataSourceId } = await saveAwishCredentialsFor(await viewerFor(owner, orgId), {
    appId: fake.state.appId,
    appSecret: fake.state.appSecret,
    appKey: fake.state.appKey,
  });
  await db().execute(
    sql`insert into public.source_machines (organization_id, data_source_id, external_id, external_name, machine_id)
        values (${orgId}::uuid, ${dataSourceId}::uuid, '2', 'Sega gubben', ${m1}::uuid),
               (${orgId}::uuid, ${dataSourceId}::uuid, '3', 'Centrum', ${m2}::uuid)`,
  );
  titleId = (
    await one<{ id: string }>(
      db(),
      sql`insert into public.titles (organization_id, name) values (${orgId}::uuid, 'Surging Sparks') returning id`,
    )
  ).id;
  await db().execute(
    sql`insert into public.title_aliases (organization_id, title_id, alias)
        values (${orgId}::uuid, ${titleId}::uuid, 'Surging Sparks')`,
  );
  await db().execute(
    sql`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
        values (${orgId}::uuid, ${titleId}::uuid, 4500, '2026-01-01')`,
  );
  await db().execute(
    sql`insert into public.machine_slots (organization_id, machine_id, title_id, slots, valid_from)
        values (${orgId}::uuid, ${m1}::uuid, ${titleId}::uuid, 2, '2026-11-01')`,
  );
});
afterAll(async () => {
  await fake.stop();
});

const campaignInput = (over: Record<string, unknown> = {}) => ({
  title: "Nytt: Surging Sparks",
  machineIds: [] as string[],
  startsOn: null as string | null,
  endsOn: "2026-11-16",
  titleId: null as string | null,
  reuseImageFrom: null as string | null,
  ...over,
});

describe("kampanjer", () => {
  it("förslag: den nya titeln i en kopplad automat", async () => {
    const page = await loadCampaignPageFor(await viewerFor(owner, orgId), deps());
    expect(page.connected).toBe(true);
    expect(page.linked.map((m) => m.code)).toEqual(["BL-001", "BL-002"]);
    expect(page.suggestions).toEqual([
      expect.objectContaining({ titleId, text: "Nytt: Surging Sparks", machineIds: [m1] }),
    ]);
  });

  let liveId: string;
  it("nu: skickas till alla kopplade automater med bildens adress och utgångstiden", async () => {
    const r = await createCampaignFor(
      await viewerFor(owner, orgId),
      campaignInput({ titleId }),
      PNG,
      deps(),
    );
    liveId = r.campaignId;
    expect(r).toMatchObject({ machines: 2, shown: 2, failed: 0, scheduled: false });
    const created = fake.state.calls.filter((c) => c.method === "CreateBanner");
    expect(created.map((c) => c.request.machine_id).sort()).toEqual(["2", "3"]);
    expect(created[0]!.request.cover_image).toBe(`https://app.test/kampanjer/bild/${liveId}`);
    expect(created[0]!.request.expired_at).toBe(String(Date.parse("2026-11-16T23:00:00Z") / 1000));
    const machines = await rows<{ status: string; awish_banner_id: string | null }>(
      db(),
      sql`select status, awish_banner_id from public.campaign_machines where campaign_id = ${liveId}::uuid`,
    );
    expect(machines.every((m) => m.status === "shown" && m.awish_banner_id !== null)).toBe(true);
    const image = await readCampaignImageFor(await viewerFor(viewerUser, orgId), liveId, deps());
    expect(image?.type).toBe("image/png");
    expect(Buffer.from(image!.bytes).equals(Buffer.from(PNG))).toBe(true);
    // Förslaget är använt.
    const page = await loadCampaignPageFor(await viewerFor(viewerUser, orgId), deps());
    expect(page.suggestions).toEqual([]);
    expect(page.current.map((c) => [c.id, c.state])).toEqual([[liveId, "live"]]);
  });

  it("nekar fel bildtyp, okopplad automat och en annan organisations bild", async () => {
    const v = await viewerFor(owner, orgId);
    await expect(createCampaignFor(v, campaignInput(), SVG, deps())).rejects.toThrow(/PNG, JPG/);
    await expect(
      createCampaignFor(v, campaignInput(), new Uint8Array(3 * 1024 * 1024 + 1), deps()),
    ).rejects.toThrow(/för stor/);
    await expect(
      createCampaignFor(v, campaignInput({ machineIds: [m3] }), PNG, deps()),
    ).rejects.toThrow(/inte kopplad/);
    const otherOwner = await createUser();
    const otherOrg = await createOrg(otherOwner);
    await expect(
      createCampaignFor(
        await viewerFor(otherOwner, otherOrg),
        campaignInput({ reuseImageFrom: liveId }),
        null,
        deps(),
      ),
    ).rejects.toThrow(/Ingen automat|finns inte/);
  });

  let scheduledId: string;
  it("senare start: inget till Awish förrän den schemalagda körningen efter starten", async () => {
    const before = fake.state.calls.filter((c) => c.method === "CreateBanner").length;
    const r = await createCampaignFor(
      await viewerFor(owner, orgId),
      campaignInput({
        title: "Helgdeal",
        machineIds: [m2],
        startsOn: "2026-11-07",
        endsOn: "2026-11-09",
        reuseImageFrom: liveId,
      }),
      null,
      deps(),
    );
    scheduledId = r.campaignId;
    expect(r.scheduled).toBe(true);
    expect(fake.state.calls.filter((c) => c.method === "CreateBanner").length).toBe(before);
    expect(
      (await publishAllDueCampaigns({ db: db(), connect, now: new Date("2026-11-05T12:00:00Z") }))
        .shown,
    ).toBe(0);
    const due = await publishAllDueCampaigns({
      db: db(),
      connect,
      now: new Date("2026-11-07T06:00:00Z"),
    });
    expect(due.shown).toBeGreaterThanOrEqual(1);
    const [row] = await rows<{ status: string }>(
      db(),
      sql`select status from public.campaign_machines where campaign_id = ${scheduledId}::uuid`,
    );
    expect(row?.status).toBe("shown");
    // En andra körning skickar den inte igen.
    const again = fake.state.calls.filter((c) => c.method === "CreateBanner").length;
    await publishAllDueCampaigns({ db: db(), connect, now: new Date("2026-11-07T06:10:00Z") });
    expect(fake.state.calls.filter((c) => c.method === "CreateBanner").length).toBe(again);
  });

  it("Awish nej: misslyckad med Awish text; Försök igen lyckas", async () => {
    fake.state.writeCode = 500;
    const v = await viewerFor(owner, orgId);
    const r = await createCampaignFor(
      v,
      campaignInput({ title: "Rea", machineIds: [m1], reuseImageFrom: liveId }),
      null,
      deps(),
    );
    expect(r).toMatchObject({ shown: 0, failed: 1 });
    const [row] = await rows<{ status: string; error: string }>(
      db(),
      sql`select status, error from public.campaign_machines where campaign_id = ${r.campaignId}::uuid`,
    );
    expect(row).toMatchObject({ status: "failed" });
    expect(row!.error).toMatch(/Awish sa nej \(kod 500\)/);
    expect(await retryCampaignFor(v, r.campaignId, deps())).toEqual({ shown: 1, failed: 0 });
  });

  it("Stäng av: utgångstiden blir nu i Awish och kampanjen är avstängd", async () => {
    now = new Date("2026-11-04T08:00:00Z");
    const r = await stopCampaignFor(await viewerFor(owner, orgId), liveId, deps());
    expect(r).toEqual({ stopped: 2, failed: 0 });
    const updates = fake.state.calls.filter((c) => c.method === "UpdateBanner");
    expect(updates.length).toBeGreaterThanOrEqual(2);
    expect(updates.at(-1)!.request.expired_at).toBe(String(now.getTime() / 1000));
    for (const m of ["2", "3"]) {
      const b = (fake.state.banners[m] ?? []).find((x) => x.title === "Nytt: Surging Sparks");
      expect(b?.expired_at).toBe(now.getTime() / 1000);
    }
    const [c] = await rows<{ stopped_at: Date | null; stopped_by: string | null }>(
      db(),
      sql`select stopped_at, stopped_by from public.campaigns where id = ${liveId}::uuid`,
    );
    expect(c!.stopped_at).not.toBeNull();
    expect(c!.stopped_by).toBe(owner.id);
    now = new Date("2026-11-03T09:00:00Z");
  });

  it("behörighet: läsare och påfyllare skapar inte; annan organisation ser och stänger inget", async () => {
    await expect(
      createCampaignFor(await viewerFor(viewerUser, orgId), campaignInput(), PNG, deps()),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      loadCampaignPageFor(await viewerFor(refiller, orgId), deps()),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const otherOwner = await createUser();
    const otherOrg = await createOrg(otherOwner);
    const other = await viewerFor(otherOwner, otherOrg);
    await expect(stopCampaignFor(other, scheduledId, deps())).rejects.toThrow(/finns inte/);
    await expect(retryCampaignFor(other, scheduledId, deps())).rejects.toThrow(/Inget att försöka/);
    expect(await readCampaignImageFor(other, scheduledId, deps())).toBeNull();
    const page = await loadCampaignPageFor(other, deps());
    expect(page.current).toEqual([]);
    expect(page.library).toEqual([]);
  });

  it("klientroller kan inte skriva; påfyllaren ser inga kampanjer", async () => {
    const insert = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.campaigns (organization_id, title, image_path, image_url, image_type, image_bytes, starts_at, ends_at)
              values (${orgId}::uuid, 'x', 'p', 'https://x', 'image/png', 1, now(), now() + interval '1 day')`,
        ),
      ),
    );
    expect(insert.code).toBe("42501");
    const update = await asUser(owner, (tx) =>
      attempt(tx, (sp) => sp.execute(sql`update public.campaign_machines set status = 'shown'`)),
    );
    expect(update.code).toBe("42501");
    const seen = await asUser(refiller, (tx) =>
      one<{ n: number }>(tx, sql`select count(*)::int as n from public.campaigns`),
    );
    expect(seen.n).toBe(0);
  });
});

describe("gratis-pack", () => {
  it("valen: automatens varor med titel och inköpspris", async () => {
    const choices = await freePackChoicesFor(await viewerFor(owner, orgId), m1, deps());
    expect(choices.map((c) => [c.goodName, c.inMachine, c.titleId, c.unitCostOre])).toEqual([
      ["Surging Sparks", 4, titleId, 4500],
      ["Black Bolt", 0, null, null],
    ]);
  });

  let batchId: string;
  it("skapar koder, sparar dem och räknar kostnaden i Lönsamhet", async () => {
    const r = await createFreePacksFor(
      await viewerFor(owner, orgId),
      {
        machineId: m1,
        productId: "1",
        quantity: 2,
        days: 14,
        reason: "compensation",
        recipient: "Kalle",
        note: "Fastnade",
      },
      deps(),
    );
    batchId = r.batchId;
    expect(r.codes).toHaveLength(2);
    expect(r.costOre).toBe(9_000);
    expect(r.expiresOn).toBe("2026-11-17");
    const call = fake.state.calls.find((c) => c.method === "CreatePickupCode");
    expect(call?.request).toMatchObject({ machine_id: "2", product_id: "1", quantity: "2" });
    const [b] = await rows<{
      status: string;
      cost_ore: string;
      created_by: string;
      reason: string;
    }>(
      db(),
      sql`select status, cost_ore, created_by, reason from public.free_pack_batches where id = ${batchId}::uuid`,
    );
    expect(b).toMatchObject({ status: "created", created_by: owner.id, reason: "compensation" });
    expect(Number(b!.cost_ore)).toBe(9_000);
    const adj = await loadProfitAdjustmentsFor(await viewerFor(viewerUser, orgId), {
      start: "2026-11-01",
      end: "2026-11-30",
    });
    expect(adj.freePacks).toEqual([
      { id: batchId, machineId: m1, titleId, day: "2026-11-03", costOre: 9_000, packs: 2 },
    ]);
  });

  it("läsaren ser listan och kostnaden men inte koderna; ägaren ser koderna", async () => {
    const asViewer = await loadFreePackPageFor(await viewerFor(viewerUser, orgId), deps());
    expect(asViewer.canCreate).toBe(false);
    expect(asViewer.month).toMatchObject({ packs: 2, costOre: 9_000 });
    expect(asViewer.batches[0]).toMatchObject({ id: batchId, codes: [] });
    const asOwner = await loadFreePackPageFor(await viewerFor(owner, orgId), deps());
    expect(asOwner.batches[0]!.codes).toHaveLength(2);
  });

  it("Awish nej: misslyckat försök finns i listan utan kostnad", async () => {
    fake.state.writeCode = 500;
    await expect(
      createFreePacksFor(
        await viewerFor(owner, orgId),
        {
          machineId: m2,
          productId: "1",
          quantity: 1,
          days: 7,
          reason: "giveaway",
          recipient: null,
          note: null,
        },
        deps(),
      ),
    ).rejects.toThrow(/Awish sa nej/);
    const [b] = await rows<{ status: string; cost_ore: string | null }>(
      db(),
      sql`select status, cost_ore from public.free_pack_batches
          where organization_id = ${orgId}::uuid and machine_id = ${m2}::uuid`,
    );
    expect(b).toEqual({ status: "failed", cost_ore: null });
    const adj = await loadProfitAdjustmentsFor(await viewerFor(owner, orgId), {
      start: "2026-11-01",
      end: "2026-11-30",
    });
    expect(adj.freePacks.map((p) => p.id)).toEqual([batchId]);
  });

  it("avbrutet svar efter att koderna skapats: skapad med kostnad, inte misslyckad", async () => {
    // Awish skapar koderna men svaret kommer aldrig fram (tidsgräns).
    const dropReply: MarketingConnect = (creds) => {
      const api = connect(creds);
      return {
        products: (id) => api.products(id),
        banners: (id) => api.banners(id),
        createBanner: (input) => api.createBanner(input),
        updateBanner: (input) => api.updateBanner(input),
        pickupCodes: (id) => api.pickupCodes(id),
        close: () => api.close(),
        createPickupCodes: async (input) => {
          await api.createPickupCodes(input);
          throw new AwishApiError("timeout", "Awish svarade inte i tid.");
        },
      };
    };
    const r = await createFreePacksFor(
      await viewerFor(owner, orgId),
      {
        machineId: m2,
        productId: "1",
        quantity: 1,
        days: 7,
        reason: "compensation",
        recipient: null,
        note: null,
      },
      { ...deps(), connect: dropReply },
    );
    expect(r.codes).toHaveLength(1);
    const [b] = await rows<{ status: string }>(
      db(),
      sql`select status from public.free_pack_batches
          where organization_id = ${orgId}::uuid and id = ${r.batchId}::uuid`,
    );
    expect(b).toEqual({ status: "created" });
    const adj = await loadProfitAdjustmentsFor(await viewerFor(owner, orgId), {
      start: "2026-11-01",
      end: "2026-11-30",
    });
    expect(adj.freePacks.map((p) => p.id)).toContain(r.batchId);
  });

  it("tomt fack, okopplad automat och koder som inte syns", async () => {
    const v = await viewerFor(owner, orgId);
    const base = {
      quantity: 1,
      days: 7 as const,
      reason: "other" as const,
      recipient: null,
      note: null,
    };
    await expect(
      createFreePacksFor(v, { ...base, machineId: m1, productId: "2" }, deps()),
    ).rejects.toThrow(/tomt/);
    await expect(
      createFreePacksFor(v, { ...base, machineId: m3, productId: "1" }, deps()),
    ).rejects.toThrow(/inte kopplad/);
    fake.state.hideNewCodes = true;
    try {
      const r = await createFreePacksFor(v, { ...base, machineId: m2, productId: "1" }, deps());
      expect(r.codes).toEqual([]);
      const [b] = await rows<{ status: string; error: string }>(
        db(),
        sql`select status, error from public.free_pack_batches where id = ${r.batchId}::uuid`,
      );
      expect(b).toMatchObject({ status: "created" });
      expect(b!.error).toMatch(/kunde inte läsas/);
    } finally {
      fake.state.hideNewCodes = false;
    }
  });

  it("behörighet: läsaren skapar inte; annan organisation når inte automaten; koderna bara för ägare/admin", async () => {
    const input = {
      machineId: m1,
      productId: "1",
      quantity: 1,
      days: 7 as const,
      reason: "staff" as const,
      recipient: null,
      note: null,
    };
    await expect(
      createFreePacksFor(await viewerFor(viewerUser, orgId), input, deps()),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      freePackChoicesFor(await viewerFor(viewerUser, orgId), m1, deps()),
    ).rejects.toBeInstanceOf(AuthorizationError);
    const otherOwner = await createUser();
    const otherOrg = await createOrg(otherOwner);
    await expect(
      createFreePacksFor(await viewerFor(otherOwner, otherOrg), input, deps()),
    ).rejects.toThrow(/inte kopplad|Koppla Awish/);
    const codes = await asUser(viewerUser, (tx) =>
      one<{ n: number }>(tx, sql`select count(*)::int as n from public.free_pack_codes`),
    );
    expect(codes.n).toBe(0);
    const batches = await asUser(refiller, (tx) =>
      one<{ n: number }>(tx, sql`select count(*)::int as n from public.free_pack_batches`),
    );
    expect(batches.n).toBe(0);
    const del = await asUser(owner, (tx) =>
      attempt(tx, (sp) => sp.execute(sql`delete from public.free_pack_batches`)),
    );
    expect(del.code).toBe("42501");
  });
});
