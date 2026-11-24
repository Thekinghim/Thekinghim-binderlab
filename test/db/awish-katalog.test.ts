/**
 * Katalogen och personerna i Awish via API:t, mot testdatabasen med en låtsas-Awish i minnet
 * (aldrig riktiga Awish) och en spärr som spelar in vad tjänsterna ber om:
 *
 * - medlemmar: bara ägare och admin (påfyllaren och läsaren nekas utan att Awish läses),
 *   demo ansluter aldrig, loggen får bara fältnamn och inget sparas i Binderlab;
 * - kategorier: skapa med förhandsvisningens fingeravtryck, kategori per fack;
 * - Ta bort vara spärras så länge varan ligger i ett fack;
 * - Awish-kontot: tidszonen skickas ensam;
 * - varor: webbpanelen som standard, API:t med flaggan, webbpanelen som reserv bara när API:t
 *   sa nej (inte vid okänt utfall).
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { AuthorizationError, listOrganizationsFor } from "../../src/server/access";
import type { AwishApiState } from "../../src/server/awish/control/connect";
import type { ControlActionResult, ControlActionSpec } from "../../src/server/awish/control/guard";
import type {
  AwishControlApi,
  AwishMember,
  AwishProductDetail,
} from "../../src/server/awish/control/types";
import type { GoodInput } from "../../src/server/awish/goods";
import type { AwishWebApi } from "../../src/server/awish/web-client";
import type { CatalogDeps } from "../../src/server/awish-catalog/common";
import type { Viewer } from "../../src/server/data/core/loaders";

import {
  asUser,
  createMember,
  createOrg,
  createUser,
  db,
  orgScopedTables,
  type TestUser,
} from "./helpers";

vi.mock("server-only", () => ({}));

const { saveAwishCredentialsFor } = await import("../../src/server/awish/manage");
const { applyMemberFor, loadMembersFor, previewMemberFor } =
  await import("../../src/server/awish-catalog/members");
const {
  applyBatchCategoryFor,
  applyCategoryFor,
  loadCategoriesPageFor,
  previewBatchCategoryFor,
  previewCategoryFor,
} = await import("../../src/server/awish-catalog/categories");
const { deleteGoodFor, goodsWriterFor, previewDeleteGoodFor } =
  await import("../../src/server/awish-catalog/goods-api");
const { applyTimezoneFor, loadAwishAccountFor, previewTimezoneFor } =
  await import("../../src/server/awish-catalog/merchant");
const { encodeGoodInput } = await import("../../src/server/awish/goods");
const { loadCampaignPageFor, removeCampaignFromScreenFor } =
  await import("../../src/server/campaigns/service");

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

// ---------------------------------------------------------------------------
// Låtsas-Awish och spärr
// ---------------------------------------------------------------------------

interface FakeState {
  members: AwishMember[];
  products: AwishProductDetail[];
  categories: { id: string; title: string }[];
  timezone: string | null;
  writes: { method: string; args: unknown[] }[];
  clients: number;
}

function member(id: string, name: string): AwishMember {
  return {
    id,
    name,
    telMasked: "070****123",
    emailMasked: "a***@x.se",
    memberNo: `M${id}`,
    machineId: null,
    principalBalance: "0.00",
    bonusBalance: "0.00",
    totalBalance: "0.00",
    points: 0,
    levelId: 1,
    status: 1,
    registeredAt: "2026-11-01 10:00:00",
    remark: null,
  };
}

function newState(): FakeState {
  return {
    members: [member("5", "Anna Andersson"), member("6", "Bertil Berg")],
    products: [
      {
        id: "71",
        machineId: "123",
        status: true,
        floorStatus: null,
        lockStatus: null,
        currentInventory: 4,
        capacity: 10,
        goodId: "9",
        goodName: "Mystery Pack",
        channel: { id: "71", name: "A3", addr: "1", motorId: "13", floorType: 2, total: 10 },
      },
      {
        id: "72",
        machineId: "123",
        status: true,
        floorStatus: null,
        lockStatus: null,
        currentInventory: 0,
        capacity: 8,
        goodId: null,
        goodName: null,
        channel: { id: "72", name: "A4", addr: "1", motorId: "14", floorType: 2, total: 8 },
      },
    ],
    categories: [{ id: "1", title: "Pokémon" }],
    timezone: "Asia/Shanghai",
    writes: [],
    clients: 0,
  };
}

function fakeApi(st: FakeState): AwishControlApi {
  const ok =
    (method: string) =>
    async (...args: unknown[]) => {
      st.writes.push({ method, args });
      return { code: 0, message: "ok", requestId: "r1", data: null };
    };
  const impl: Partial<AwishControlApi> = {
    members: async ({ currentPage, perPage }) => ({
      items: st.members.slice((currentPage - 1) * perPage, currentPage * perPage),
      total: st.members.length,
      currentPage,
      perPage,
      lastPage: Math.max(1, Math.ceil(st.members.length / perPage)),
      hasMore: null,
    }),
    productDetails: async () => st.products,
    categories: async () => st.categories,
    currencies: async () => [{ id: "1", name: "Krona", code: "SEK", symbol: "kr" }],
    merchantDetail: async () => ({
      id: "1",
      title: "Binderlab AB",
      expiredAt: "2027-04-18 23:48:54",
      timezone: st.timezone,
      whitelistIp: null,
      taxEnabled: false,
    }),
    batchCreateMembers: ok("batchCreateMembers"),
    updateMember: ok("updateMember"),
    deleteMember: ok("deleteMember"),
    createCategory: ok("createCategory"),
    updateCategory: ok("updateCategory"),
    deleteCategory: ok("deleteCategory"),
    batchUpdateProducts: ok("batchUpdateProducts"),
    deleteGood: ok("deleteGood"),
    deleteBanner: ok("deleteBanner"),
    createGood: ok("createGood"),
    updateGood: ok("updateGood"),
    updateMerchantTimezone: ok("updateMerchantTimezone"),
    close: () => {},
  };
  return new Proxy(impl as AwishControlApi, {
    get(target, prop) {
      const v = (target as unknown as Record<string | symbol, unknown>)[prop];
      if (v === undefined) throw new Error(`Låtsas-Awish saknar ${String(prop)}`);
      return v;
    },
  });
}

const STATE = { signStatus: "ok", goodsWritesVia: "web" } as AwishApiState;

let st: FakeState;
let specs: ControlActionSpec[];
let refuse: { kind: "awish" | "unknown_outcome" | "forbidden"; message: string } | null;

function deps(): CatalogDeps {
  async function run<T>(
    _viewer: Viewer,
    spec: ControlActionSpec,
    fn: (
      a: AwishControlApi,
      ctx: { awishMachineId: string | null; db: ReturnType<typeof db> },
    ) => Promise<T>,
  ): Promise<ControlActionResult<T>> {
    specs.push(spec);
    if (refuse) return { ok: false, message: refuse.message, actionId: null, kind: refuse.kind };
    const value = await fn(fakeApi(st), { awishMachineId: null, db: db() });
    return { ok: true, message: "Klart.", value, actionId: randomUUID(), replayed: false };
  }
  return {
    db: db(),
    run,
    client: async () => {
      st.clients++;
      return { api: fakeApi(st), sourceId: "x", state: STATE };
    },
  };
}

function fresh() {
  st = newState();
  specs = [];
  refuse = null;
}

let owner: TestUser;
let admin: TestUser;
let refiller: TestUser;
let viewerUser: TestUser;
let orgId: string;
let demoOrg: string;
let sourceId: string;
let m1: string;

async function rowCount(org: string): Promise<number> {
  let total = 0;
  for (const t of await orgScopedTables()) {
    const [r] = Array.from(
      await db().execute(
        sql`select count(*)::int as n from ${sql.raw(`public.${t}`)} where organization_id = ${org}::uuid`,
      ),
    ) as { n: number }[];
    total += r?.n ?? 0;
  }
  return total;
}

beforeAll(async () => {
  owner = await createUser();
  orgId = await createOrg(owner);
  admin = await createMember(orgId, "admin");
  refiller = await createMember(orgId, "refiller");
  viewerUser = await createMember(orgId, "viewer");
  const [machine] = await asUser(owner, (tx) =>
    tx
      .insert(s.machines)
      .values({
        organizationId: orgId,
        code: "BL-003",
        name: "Sega gubben",
        activeFrom: "2026-10-01",
      })
      .returning(),
  );
  m1 = machine!.id;
  ({ dataSourceId: sourceId } = await saveAwishCredentialsFor(await viewerFor(owner, orgId), {
    appId: "app-test",
    appSecret: "hemlig-secret",
    appKey: "nyckel-key",
  }));
  await db().execute(
    sql`insert into public.source_machines (organization_id, data_source_id, external_id, external_name, machine_id)
        values (${orgId}::uuid, ${sourceId}::uuid, '123', 'Sega gubben', ${m1}::uuid)`,
  );
  demoOrg = await createOrg(owner, "Demo");
  await db().execute(
    sql`update public.organizations set is_demo = true where id = ${demoOrg}::uuid`,
  );
});

// ---------------------------------------------------------------------------
// Medlemmar
// ---------------------------------------------------------------------------

describe("medlemmar", () => {
  it("påfyllaren och läsaren nekas innan Awish läses", async () => {
    fresh();
    for (const u of [refiller, viewerUser]) {
      const v = await viewerFor(u, orgId);
      await expect(loadMembersFor(v, 1, deps())).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        previewMemberFor(v, { action: "create", name: "Ny" }, deps()),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(
        applyMemberFor(v, { action: "delete", id: "5", idempotencyKey: randomUUID() }, deps()),
      ).rejects.toBeInstanceOf(AuthorizationError);
      await expect(loadCategoriesPageFor(v, deps())).rejects.toBeInstanceOf(AuthorizationError);
      await expect(loadAwishAccountFor(v, deps())).rejects.toBeInstanceOf(AuthorizationError);
    }
    expect(st.clients).toBe(0);
    expect(specs).toHaveLength(0);
  });

  it("demo: rutan visas och inget anrop till Awish görs", async () => {
    fresh();
    const v = await viewerFor(owner, demoOrg);
    expect((await loadMembersFor(v, 1, deps())).status).toBe("demo");
    expect((await loadCategoriesPageFor(v, deps())).status).toBe("demo");
    expect((await loadAwishAccountFor(v, deps())).status).toBe("demo");
    await expect(previewMemberFor(v, { action: "delete", id: "5" }, deps())).rejects.toThrow(
      /demo/i,
    );
    await expect(previewTimezoneFor(v, deps())).rejects.toThrow(/demo/i);
    await expect(previewMemberFor(v, { action: "create", name: "Ny" }, deps())).rejects.toThrow(
      /demo/i,
    );
    expect(st.clients).toBe(0);
  });

  it("listan läses live för admin", async () => {
    fresh();
    const page = await loadMembersFor(await viewerFor(admin, orgId), 1, deps());
    expect(page.status).toBe("ok");
    if (page.status !== "ok") return;
    expect(page.page.items.map((m) => m.telMasked)).toEqual(["070****123", "070****123"]);
  });

  it("ny medlem: loggen får bara fältnamnen och inget sparas i Binderlab", async () => {
    fresh();
    const v = await viewerFor(owner, orgId);
    const before = await rowCount(orgId);
    const input = { action: "create", name: "Cecilia Ceder", tel: "0701234567", email: "c@x.se" };
    const p = await previewMemberFor(v, input, deps());
    expect(p.blocking).toBeNull();
    await expect(
      applyMemberFor(v, { ...input, fingerprint: "fel", idempotencyKey: p.idempotencyKey }, deps()),
    ).rejects.toThrow(/förhandsvisningen/);
    const r = await applyMemberFor(
      v,
      { ...input, fingerprint: p.fingerprint, idempotencyKey: p.idempotencyKey },
      deps(),
    );
    expect(r.ok).toBe(true);
    expect(st.writes).toEqual([
      {
        method: "batchCreateMembers",
        args: [[{ name: "Cecilia Ceder", tel: "0701234567", email: "c@x.se" }]],
      },
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.kind).toBe("member_create");
    expect(specs[0]!.auditRequest).toEqual({ fields: ["email", "name", "tel"] });
    expect(JSON.stringify(specs[0])).not.toMatch(/Cecilia|0701234567|c@x\.se/);
    expect(await rowCount(orgId)).toBe(before);
  });

  it("ändra och ta bort: id och fältnamn i loggen", async () => {
    fresh();
    const v = await viewerFor(owner, orgId);
    const edit = {
      action: "update",
      id: "5",
      name: "Anna Andersson",
      status: "2",
      remark: "Kort borttappat",
    };
    const p = await previewMemberFor(v, edit, deps());
    expect(p.lines).toEqual(["Anna Andersson: anteckning, status ändras."]);
    await applyMemberFor(
      v,
      { ...edit, fingerprint: p.fingerprint, idempotencyKey: p.idempotencyKey },
      deps(),
    );
    expect(st.writes[0]).toEqual({
      method: "updateMember",
      args: ["5", { status: 2, remark: "Kort borttappat" }],
    });
    expect(specs[0]!.auditRequest).toEqual({ id: "5", fields: ["remark", "status"] });
    expect(JSON.stringify(specs[0])).not.toMatch(/Kort borttappat|Anna/);

    const d = await previewMemberFor(v, { action: "delete", id: "6" }, deps());
    expect(d.confirm).toBe("Ta bort Bertil Berg? Det går inte att ångra.");
    await applyMemberFor(
      v,
      { action: "delete", id: "6", fingerprint: d.fingerprint, idempotencyKey: d.idempotencyKey },
      deps(),
    );
    expect(st.writes[1]).toEqual({ method: "deleteMember", args: ["6"] });
    expect(specs[1]!.auditRequest).toEqual({ id: "6" });

    await expect(previewMemberFor(v, { action: "delete", id: "99" }, deps())).rejects.toThrow(
      /finns inte längre/,
    );
  });
});

// ---------------------------------------------------------------------------
// Kategorier och fack
// ---------------------------------------------------------------------------

describe("kategorier", () => {
  it("sidan, ny kategori och kategori per fack", async () => {
    fresh();
    const v = await viewerFor(owner, orgId);
    const page = await loadCategoriesPageFor(v, deps());
    expect(page.status).toBe("ok");
    if (page.status === "ok") expect(page.machines.map((m) => m.code)).toEqual(["BL-003"]);

    const input = { action: "create", title: "Mystery", priority: "2" };
    const p = await previewCategoryFor(v, input, deps());
    const r = await applyCategoryFor(
      v,
      { ...input, fingerprint: p.fingerprint, idempotencyKey: p.idempotencyKey },
      deps(),
    );
    expect(r).toEqual({ ok: true, message: "Klart! Mystery finns nu i Awish." });
    expect(st.writes[0]).toEqual({
      method: "createCategory",
      args: [{ title: "Mystery", priority: 2, isVisible: true }],
    });

    const batch = { machineId: m1, productIds: ["72", "71"], categoryId: "1" };
    const b = await previewBatchCategoryFor(v, batch, deps());
    expect(b.lines).toEqual(["2 fack på BL-003 → Pokémon:", "A3, A4"]);
    await applyBatchCategoryFor(
      v,
      { ...batch, fingerprint: b.fingerprint, idempotencyKey: b.idempotencyKey },
      deps(),
    );
    expect(st.writes[1]).toEqual({
      method: "batchUpdateProducts",
      args: [{ machineId: "123", ids: ["71", "72"], categoryId: "1" }],
    });
    expect(specs[1]).toMatchObject({ kind: "products_batch", machineId: m1 });

    await expect(
      previewBatchCategoryFor(v, { ...batch, productIds: ["99"] }, deps()),
    ).resolves.toMatchObject({ blocking: "Något fack finns inte längre. Ladda om sidan." });
  });
});

// ---------------------------------------------------------------------------
// Varor
// ---------------------------------------------------------------------------

describe("varor", () => {
  it("Ta bort vara spärras så länge varan ligger i ett fack", async () => {
    fresh();
    const v = await viewerFor(owner, orgId);
    const blocked = await previewDeleteGoodFor(v, { goodId: 9, goodName: "Mystery Pack" }, deps());
    expect(blocked.blocking).toBe("Varan ligger i A3 på BL-003. Byt pack i facket först.");
    await expect(
      deleteGoodFor(
        v,
        { goodId: 9, fingerprint: blocked.fingerprint, idempotencyKey: blocked.idempotencyKey },
        deps(),
      ),
    ).rejects.toThrow(/Byt pack i facket först/);
    expect(st.writes).toEqual([]);

    const free = await previewDeleteGoodFor(v, { goodId: 10, goodName: "Gammal" }, deps());
    expect(free.blocking).toBeNull();
    const r = await deleteGoodFor(
      v,
      {
        goodId: 10,
        goodName: "Gammal",
        fingerprint: free.fingerprint,
        idempotencyKey: free.idempotencyKey,
      },
      deps(),
    );
    expect(r.ok).toBe(true);
    expect(st.writes).toEqual([{ method: "deleteGood", args: ["10"] }]);
    expect(specs[0]).toMatchObject({ kind: "good_delete", targetId: "10" });
  });

  function webStub() {
    const calls: { method: string; input: GoodInput }[] = [];
    const web = {
      createGood: async (input: GoodInput) => {
        calls.push({ method: "createGood", input });
      },
      updateGood: async (_id: number, input: GoodInput) => {
        calls.push({ method: "updateGood", input });
      },
    } as unknown as AwishWebApi;
    return { web, calls };
  }

  async function setVia(via: "web" | "api" | "api_then_web" | null) {
    await db().execute(
      sql`delete from public.awish_api_state where organization_id = ${orgId}::uuid`,
    );
    if (via) {
      await db().execute(
        sql`insert into public.awish_api_state (organization_id, data_source_id, goods_writes_via)
            values (${orgId}::uuid, ${sourceId}::uuid, ${via})`,
      );
    }
  }

  const good = () =>
    encodeGoodInput({ name: "Mystery XL", salePriceOre: 7900, currencyId: 1, imageUrl: null });

  it("webbpanelen som standard; API:t med flaggan (79.00 i SEK)", async () => {
    fresh();
    const v = await viewerFor(owner, orgId);
    await setVia(null);
    const a = webStub();
    const w1 = await goodsWriterFor(v, a.web, sourceId, deps());
    expect(w1.via).toBe("web");
    await w1.createGood(good(), "fp");
    expect(a.calls.map((c) => c.method)).toEqual(["createGood"]);
    expect(specs).toHaveLength(0);

    await setVia("api");
    const b = webStub();
    const w2 = await goodsWriterFor(v, b.web, sourceId, deps());
    expect(w2.via).toBe("api");
    await w2.createGood(good(), "fp");
    expect(b.calls).toEqual([]);
    expect(st.writes[0]!.method).toBe("createGood");
    expect(st.writes[0]!.args[0]).toMatchObject({
      name: "Mystery XL",
      prices: [{ id: "0", price: "79.00", currencyId: "1" }],
    });
    expect(specs[0]!.kind).toBe("good_create");
    expect(specs[0]!.idempotencyKey).toMatch(/^good_create:[0-9a-f]{48}$/);
  });

  it("API, webbpanelen som reserv: bara när API:t sa nej, aldrig vid okänt utfall", async () => {
    fresh();
    const v = await viewerFor(owner, orgId);
    await setVia("api_then_web");
    refuse = { kind: "awish", message: "Awish sa nej." };
    const a = webStub();
    await (await goodsWriterFor(v, a.web, sourceId, deps())).updateGood(42, good(), "fp");
    expect(a.calls.map((c) => c.method)).toEqual(["updateGood"]);

    refuse = { kind: "unknown_outcome", message: "Vi vet inte om Awish fick det." };
    const b = webStub();
    await expect(
      (await goodsWriterFor(v, b.web, sourceId, deps())).updateGood(42, good(), "fp"),
    ).rejects.toThrow("Vi vet inte om Awish fick det.");
    expect(b.calls).toEqual([]);

    await setVia("api");
    refuse = { kind: "awish", message: "Awish sa nej." };
    const c = webStub();
    await expect(
      (await goodsWriterFor(v, c.web, sourceId, deps())).createGood(good(), "fp"),
    ).rejects.toThrow("Awish sa nej.");
    expect(c.calls).toEqual([]);
    await setVia(null);
  });
});

// ---------------------------------------------------------------------------
// Awish-kontot
// ---------------------------------------------------------------------------

describe("Awish-kontot", () => {
  it("tidszonen skickas ensam", async () => {
    fresh();
    const v = await viewerFor(owner, orgId);
    const page = await loadAwishAccountFor(v, deps());
    expect(page).toMatchObject({
      status: "ok",
      timezoneMatches: false,
      wantedTimezone: "Europe/Stockholm",
    });
    const p = await previewTimezoneFor(v, deps());
    expect(p.lines).toEqual(["Tidszon: Asia/Shanghai → Europe/Stockholm."]);
    const r = await applyTimezoneFor(
      v,
      { fingerprint: p.fingerprint, idempotencyKey: p.idempotencyKey },
      deps(),
    );
    expect(r.ok).toBe(true);
    expect(st.writes).toEqual([{ method: "updateMerchantTimezone", args: ["Europe/Stockholm"] }]);
    expect(specs[0]).toMatchObject({
      kind: "merchant_update",
      auditRequest: { timezone: "Europe/Stockholm" },
    });
    expect(JSON.stringify(specs[0])).not.toMatch(/config|app_secret|appKey/);

    st.timezone = "Europe/Stockholm";
    expect((await previewTimezoneFor(v, deps())).blocking).toMatch(/redan/);
  });
});

// ---------------------------------------------------------------------------
// Kampanjer: Ta bort från skärmen (DeleteBanner)
// ---------------------------------------------------------------------------

describe("kampanjer: ta bort från skärmen", () => {
  async function campaign(endsAt: string, stopped: boolean): Promise<string> {
    const [c] = Array.from(
      await db().execute(
        sql`insert into public.campaigns
              (organization_id, title, image_path, image_url, image_type, image_bytes, starts_at, ends_at, stopped_at)
            values (${orgId}::uuid, 'Jul', 'x/jul.png', 'https://x/jul.png', 'image/png', 10,
                    '2026-11-01T00:00:00Z', ${endsAt}::timestamptz, ${stopped ? "2026-11-10T00:00:00Z" : null}::timestamptz)
            returning id::text as id`,
      ),
    ) as { id: string }[];
    await db().execute(
      sql`insert into public.campaign_machines
            (organization_id, campaign_id, machine_id, awish_machine_id, awish_banner_id, status)
          values (${orgId}::uuid, ${c!.id}::uuid, ${m1}::uuid, '123', '77', ${stopped ? "stopped" : "shown"})`,
    );
    return c!.id;
  }

  it("bara slut eller avstängd; påfyllaren nekas; en borttagning per automat", async () => {
    fresh();
    const now = () => new Date("2026-11-24T12:00:00Z");
    const running = await campaign("2026-12-31T00:00:00Z", false);
    const v = await viewerFor(owner, orgId);
    await expect(removeCampaignFromScreenFor(v, running, { ...deps(), now })).rejects.toThrow(
      "Stäng av kampanjen först.",
    );
    await expect(
      removeCampaignFromScreenFor(await viewerFor(refiller, orgId), running, { ...deps(), now }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    const ended = await campaign("2026-11-20T00:00:00Z", true);
    const r = await removeCampaignFromScreenFor(v, ended, { ...deps(), now });
    expect(r).toMatchObject({ removed: 1, failed: 0 });
    expect(st.writes).toEqual([{ method: "deleteBanner", args: [{ machineId: "123", id: "77" }] }]);
    expect(specs[0]).toMatchObject({ kind: "banner_delete", targetId: "77" });
    expect(specs[0]!.idempotencyKey).toMatch(/^banner_delete:[0-9a-f-]{36}$/);

    // Loggen säger att bilden är borta (raden skrivs av spärren i appen).
    await db().execute(
      sql`insert into public.awish_actions (organization_id, kind, target_id, idempotency_key, status, finished_at)
          values (${orgId}::uuid, 'banner_delete', '77', ${specs[0]!.idempotencyKey}, 'ok', now())`,
    );
    const page = await loadCampaignPageFor(v, { db: db(), now });
    expect(page.past.find((c) => c.id === ended)?.onScreen).toBe(0);
    const again = await removeCampaignFromScreenFor(v, ended, { ...deps(), now });
    expect(again.removed).toBe(0);
    expect(again.message).toBe("Kampanjen finns inte kvar på någon skärm.");
  });
});
