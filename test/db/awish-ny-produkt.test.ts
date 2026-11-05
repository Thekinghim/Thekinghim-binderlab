/**
 * "Ny produkt" (src/server/awish/new-product.ts) mot testdatabasen och låtsas-panelen:
 *
 *  - bara ägare och admin; påfyllare och läsare nekas och inget skickas till Awish,
 *  - push måste vara påslaget,
 *  - hela flödet: förhandsvisning → Skicka till Awish skapar varan (med bild) med panelens
 *    exakta GoodInput och titel, alias, inköpspris och egen produkt i Binderlab,
 *  - misslyckas Awish (varan eller bilden) sparas ingenting i Binderlab,
 *  - en vara som redan finns kopplas bara (priset i Awish rörs inte),
 *  - ändrad plan efter förhandsvisningen och dubbelklick skickar inget två gånger,
 *  - fack: byte av vara i ett fack med pack kräver bekräftelse och skickar panelens
 *    UpdateProduct-indata.
 *
 * Testet når aldrig riktiga Awish: webb-klienten pekas mot låtsas-panelen.
 */

import { sql } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import type { Viewer } from "../../src/server/data/core/loaders";

import {
  asPostgres,
  asUser,
  createMember,
  createOrg,
  createUser,
  db,
  rows,
  type TestUser,
} from "./helpers";

vi.mock("server-only", () => ({}));

const { saveAwishCredentialsFor, saveAwishWebCredentialsFor, setAwishWebPushFor } =
  await import("../../src/server/awish/manage");
const np = await import("../../src/server/awish/new-product");
const { checkGoodImage, NewProductError } = await import("../../src/server/awish/goods");
const { startFakeAwishWeb } = await import("../../src/server/awish/testing/fake-web-server");
type FakeWeb = Awaited<ReturnType<typeof startFakeAwishWeb>>;
const { createAwishWebClient } = await import("../../src/server/awish/web-client");

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let fake: FakeWeb;
const NOW = new Date("2026-11-05T10:00:00Z");
const deps = () => ({
  serviceDb: db(),
  makeWebClient: (o: Parameters<typeof createAwishWebClient>[0] = {}) =>
    createAwishWebClient({ ...o, baseUrl: fake.baseUrl, now: () => NOW.getTime() }),
  now: () => NOW,
});

let owner: TestUser;
let orgId: string;
let machineId: string;

const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6, 5]);
const IMG = () => checkGoodImage(JPG, "Testbild");

async function titleRows(name: string) {
  return rows<{
    id: string;
    own_product: boolean;
    alias: string | null;
    price: number | null;
    valid_from: string | null;
  }>(
    db(),
    sql`select t.id, t.own_product, a.alias, pp.unit_cost_ore::int as price, pp.valid_from::text as valid_from
        from public.titles t
        left join public.title_aliases a on a.organization_id = t.organization_id and a.title_id = t.id
        left join public.purchase_prices pp on pp.organization_id = t.organization_id and pp.title_id = t.id
        where t.organization_id = ${orgId}::uuid and lower(t.name) = lower(${name})`,
  );
}

const writes = () =>
  fake.state.calls.filter((c) =>
    ["CreateGood", "UpdateProduct", "UpdateGood"].includes(c.operationName),
  );

beforeAll(async () => {
  owner = await createUser();
  orgId = await createOrg(owner);
  const [machine] = await asUser(owner, (tx) =>
    tx
      .insert(s.machines)
      .values({
        organizationId: orgId,
        code: "BL-001",
        name: "Sega gubben",
        activeFrom: "2026-10-01",
      })
      .returning(),
  );
  machineId = machine!.id;
  const viewer = await viewerFor(owner, orgId);
  const { dataSourceId } = await saveAwishCredentialsFor(viewer, {
    appId: "app",
    appSecret: "secret",
    appKey: "key",
  });
  await db().execute(sql`
    insert into public.source_machines (organization_id, data_source_id, external_id, external_name, machine_id)
    values (${orgId}::uuid, ${dataSourceId}::uuid, '1001', 'Sega gubben', ${machineId}::uuid)
    on conflict (organization_id, data_source_id, external_id) do update set machine_id = excluded.machine_id`);
});

beforeEach(async () => {
  fake = await startFakeAwishWeb({
    products: {
      "1001": [
        {
          id: 11,
          goodId: 6,
          goodName: "Mystery Pack",
          status: true,
          currentInventory: 5,
          capacity: 10,
          channelName: "A1",
        },
        {
          id: 12,
          goodId: null,
          goodName: null,
          status: true,
          currentInventory: 0,
          capacity: 8,
          channelName: "A2",
        },
      ],
    },
  });
  const viewer = await viewerFor(owner, orgId);
  await saveAwishWebCredentialsFor(viewer, {
    email: fake.state.email,
    password: fake.state.password,
  });
  await setAwishWebPushFor(viewer, true);
});

afterEach(async () => {
  await fake.stop();
});

describe("Ny produkt: behörighet och påslag", () => {
  it("påfyllare och läsare nekas och inget skickas till Awish", async () => {
    for (const role of ["refiller", "viewer"] as const) {
      const v = await viewerFor(await createMember(orgId, role), orgId);
      const input = { name: "Nekad", salePrice: "79", purchasePrice: "30", ownProduct: false };
      await expect(np.newProductPageFor(v, deps())).rejects.toThrow(np.FORBIDDEN_MESSAGE);
      await expect(np.previewNewProductFor(v, input, null, deps())).rejects.toThrow(
        np.FORBIDDEN_MESSAGE,
      );
      await expect(np.createNewProductFor(v, input, null, "0".repeat(32), deps())).rejects.toThrow(
        np.FORBIDDEN_MESSAGE,
      );
      await expect(np.slotChoicesFor(v, machineId, deps())).rejects.toThrow(np.FORBIDDEN_MESSAGE);
      await expect(
        np.applySlotChangeFor(
          v,
          { machineId, productId: 11, goodId: 6, count: 1 },
          "0".repeat(32),
          true,
          deps(),
        ),
      ).rejects.toThrow(np.FORBIDDEN_MESSAGE);
    }
    expect(fake.state.calls).toEqual([]);
    expect(await titleRows("Nekad")).toEqual([]);
  });

  it("butiksrollen nekas och inget skickas till Awish", async () => {
    const store = await createUser();
    await asPostgres(async (tx) => {
      const [st] = await tx
        .insert(s.stores)
        .values({ organizationId: orgId, name: "Butik Nekad" })
        .returning();
      await tx
        .insert(s.memberships)
        .values({ organizationId: orgId, userId: store.id, role: "store", storeId: st!.id });
    });
    const org = (await viewerFor(owner, orgId)).organization;
    const v: Viewer = { user: { userId: store.id, email: store.email }, organization: org };
    const input = { name: "Butiksnekad", salePrice: "79", purchasePrice: "30", ownProduct: false };
    await expect(np.newProductPageFor(v, deps())).rejects.toThrow(np.FORBIDDEN_MESSAGE);
    await expect(np.previewNewProductFor(v, input, null, deps())).rejects.toThrow(
      np.FORBIDDEN_MESSAGE,
    );
    await expect(np.createNewProductFor(v, input, null, "0".repeat(32), deps())).rejects.toThrow(
      np.FORBIDDEN_MESSAGE,
    );
    await expect(
      np.previewSlotChangeFor(v, { machineId, productId: 11, goodId: 6, count: 1 }, deps()),
    ).rejects.toThrow(np.FORBIDDEN_MESSAGE);
    expect(fake.state.calls).toEqual([]);
    expect(await titleRows("Butiksnekad")).toEqual([]);
  });

  it("admin får", async () => {
    const admin = await viewerFor(await createMember(orgId, "admin"), orgId);
    const page = await np.newProductPageFor(admin, deps());
    expect(page.status.blocker).toBeNull();
    expect(page.machines).toEqual([{ id: machineId, code: "BL-001", name: "Sega gubben" }]);
  });

  it("push avstängd: sidan säger till och inget skickas", async () => {
    const viewer = await viewerFor(owner, orgId);
    await setAwishWebPushFor(viewer, false);
    const page = await np.newProductPageFor(viewer, deps());
    expect(page.status.blocker).toMatch(/Slå på Skicka påfyllningar till Awish/);
    await expect(
      np.previewNewProductFor(
        viewer,
        { name: "X", salePrice: "79", purchasePrice: "30", ownProduct: false },
        null,
        deps(),
      ),
    ).rejects.toThrow(/Slå på Skicka påfyllningar/);
    expect(fake.state.calls).toEqual([]);
  });
});

describe("Ny produkt: hela flödet", () => {
  it("förhandsvisning → Skicka skapar varan i Awish och titel, alias, pris i Binderlab", async () => {
    const viewer = await viewerFor(owner, orgId);
    const input = {
      name: "Prismatic Pack",
      salePrice: "89,50",
      purchasePrice: "41",
      ownProduct: true,
    };
    const image = checkGoodImage(JPG, "Prismatic Pack");

    const preview = await np.previewNewProductFor(viewer, input, image, deps());
    expect(preview.blocking).toBeNull();
    expect(preview.lines).toEqual([
      "Awish: ny vara Prismatic Pack, 89,50 kr, bild prismatic-pack.jpg.",
      "Binderlab: ny titel Prismatic Pack.",
      "Inköpspris 41 kr från 2026-11-05.",
      "Egen produkt: ja.",
    ]);
    // Förhandsvisningen skriver ingenting.
    expect(writes()).toEqual([]);
    expect(fake.state.uploads).toEqual([]);
    expect(await titleRows("Prismatic Pack")).toEqual([]);

    const r = await np.createNewProductFor(viewer, input, image, preview.fingerprint, deps());
    expect(r.status).toBe("created");

    const create = fake.state.calls.find((c) => c.operationName === "CreateGood");
    expect(create?.query).toBe(
      "mutation CreateGood($input: GoodInput!) { createGood(input: $input) }",
    );
    const url = fake.state.uploads[0]!.url;
    expect(create?.variables).toEqual({
      input: {
        name: "Prismatic Pack",
        description: "Prismatic Pack",
        thumb: url,
        content: "<p>Prismatic Pack</p>",
        media: [url],
        multi_currency_enabled: false,
        slug: "",
        unit_id: null,
        attributes: [],
        is_tax_exempt: true,
        tax_rate: 0,
        is_returnable: false,
        prices: [
          { id: 0, currency_id: 2, price: 89.5, original_price: 0, member_price: 0, cost_price: 0 },
        ],
      },
    });
    expect(fake.state.rejected).toEqual([]);
    const good = fake.state.goods.find((g) => g.name === "Prismatic Pack");
    expect(r.goodId).toBe(good!.id);

    expect(await titleRows("Prismatic Pack")).toEqual([
      {
        id: r.titleId,
        own_product: true,
        alias: "Prismatic Pack",
        price: 4100,
        valid_from: "2026-11-05",
      },
    ]);
    // Försäljning med varans namn hittar titeln (samma normalisering som importen).
    const [hit] = await rows<{ title_id: string }>(
      db(),
      sql`select title_id from public.title_aliases
          where organization_id = ${orgId}::uuid
            and alias_normalized = lower(btrim(regexp_replace(normalize('  prismatic   PACK ', NFKC), '\\s+', ' ', 'g')))`,
    );
    expect(hit?.title_id).toBe(r.titleId);

    // Igen: allt finns redan, inget skickas.
    const again = await np.previewNewProductFor(viewer, input, null, deps());
    expect(again.nothingToDo).toBe(true);
    const nothing = await np.createNewProductFor(viewer, input, null, again.fingerprint, deps());
    expect(nothing.status).toBe("nothing");
    expect(fake.state.calls.filter((c) => c.operationName === "CreateGood")).toHaveLength(1);
  });

  it("Awish nekar varan: inget sparas i Binderlab, svenskt fel", async () => {
    const viewer = await viewerFor(owner, orgId);
    const input = { name: "Felvara", salePrice: "50", purchasePrice: "20", ownProduct: false };
    const preview = await np.previewNewProductFor(viewer, input, IMG(), deps());
    fake.state.failOn.CreateGood = { message: "The name has already been taken." };
    await expect(
      np.createNewProductFor(viewer, input, IMG(), preview.fingerprint, deps()),
    ).rejects.toThrow("Awish svarade med ett fel: The name has already been taken.");
    expect(await titleRows("Felvara")).toEqual([]);
  });

  it("bilden går inte att ladda upp: ingen vara i Awish och inget i Binderlab", async () => {
    const viewer = await viewerFor(owner, orgId);
    const input = { name: "Bildfel", salePrice: "50", purchasePrice: "20", ownProduct: false };
    const image = checkGoodImage(JPG, "Bildfel");
    const preview = await np.previewNewProductFor(viewer, input, image, deps());
    fake.state.uploadFailStatus = 500;
    await expect(
      np.createNewProductFor(viewer, input, image, preview.fingerprint, deps()),
    ).rejects.toThrow(/Awish svarar inte just nu/);
    expect(fake.state.calls.some((c) => c.operationName === "CreateGood")).toBe(false);
    expect(await titleRows("Bildfel")).toEqual([]);
  });

  it("ändrad plan efter förhandsvisningen (annan bild) skickar ingenting", async () => {
    const viewer = await viewerFor(owner, orgId);
    const input = { name: "Bytt bild", salePrice: "50", purchasePrice: "20", ownProduct: false };
    const preview = await np.previewNewProductFor(viewer, input, IMG(), deps());
    await expect(
      np.createNewProductFor(viewer, input, checkGoodImage(JPG, "x"), preview.fingerprint, deps()),
    ).rejects.toThrow(/sedan förhandsvisningen/);
    // Annat pris än i förhandsvisningen.
    await expect(
      np.createNewProductFor(
        viewer,
        { ...input, salePrice: "51" },
        IMG(),
        preview.fingerprint,
        deps(),
      ),
    ).rejects.toThrow(/sedan förhandsvisningen/);
    expect(writes()).toEqual([]);
    expect(fake.state.uploads).toEqual([]);
    expect(await titleRows("Bytt bild")).toEqual([]);
  });

  it("dubbelklick: varan skapas en gång", async () => {
    const viewer = await viewerFor(owner, orgId);
    const input = { name: "Dubbel", salePrice: "60", purchasePrice: "25", ownProduct: false };
    const preview = await np.previewNewProductFor(viewer, input, IMG(), deps());
    const results = await Promise.allSettled([
      np.createNewProductFor(viewer, input, IMG(), preview.fingerprint, deps()),
      np.createNewProductFor(viewer, input, IMG(), preview.fingerprint, deps()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failed = results.find((r) => r.status === "rejected") as PromiseRejectedResult;
    expect(failed.reason).toBeInstanceOf(NewProductError);
    expect(fake.state.goods.filter((g) => g.name === "Dubbel")).toHaveLength(1);
    expect(await titleRows("Dubbel")).toHaveLength(1);
  });

  it("varan finns redan i Awish: kopplas bara, priset i Awish ändras inte", async () => {
    const viewer = await viewerFor(owner, orgId);
    fake.state.goods.push({
      id: 77,
      name: "Gammal vara",
      price: "45.00",
      thumb: "",
      media: [],
      description: "",
      content: "",
    });
    const input = { name: "gammal  VARA", salePrice: "99", purchasePrice: "20", ownProduct: false };
    const preview = await np.previewNewProductFor(viewer, input, IMG(), deps());
    expect(preview.warnings).toContain(
      "Awish har redan Gammal vara för 45 kr. Priset ändras inte här.",
    );
    const r = await np.createNewProductFor(viewer, input, IMG(), preview.fingerprint, deps());
    expect(r).toMatchObject({ status: "linked", goodId: 77 });
    expect(writes()).toEqual([]);
    expect(fake.state.goods.find((g) => g.id === 77)?.price).toBe("45.00");
    const t = await titleRows("gammal vara");
    expect(t).toHaveLength(1);
    expect(t[0]?.price).toBe(2000);
  });

  it("befintlig titel med inköpspris: priset behålls, aliaset läggs till", async () => {
    const viewer = await viewerFor(owner, orgId);
    const [title] = await asUser(owner, (tx) =>
      tx.insert(s.titles).values({ organizationId: orgId, name: "Befintlig" }).returning(),
    );
    await db().execute(sql`
      insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
      values (${orgId}::uuid, ${title!.id}::uuid, 3000, '2026-10-01')`);
    const input = { name: "Befintlig", salePrice: "79", purchasePrice: "35", ownProduct: false };
    const preview = await np.previewNewProductFor(viewer, input, IMG(), deps());
    expect(preview.warnings[0]).toMatch(/redan inköpspris 30 kr/);
    const r = await np.createNewProductFor(viewer, input, IMG(), preview.fingerprint, deps());
    expect(r.titleId).toBe(title!.id);
    expect(await titleRows("Befintlig")).toEqual([
      {
        id: title!.id,
        own_product: false,
        alias: "Befintlig",
        price: 3000,
        valid_from: "2026-10-01",
      },
    ]);
  });
});

describe("Ny produkt: befintlig egen produkt", () => {
  it("en titel som är Egen produkt slås inte av när reglaget är av", async () => {
    const viewer = await viewerFor(owner, orgId);
    const [title] = await asUser(owner, (tx) =>
      tx
        .insert(s.titles)
        .values({ organizationId: orgId, name: "Egen Box", ownProduct: true })
        .returning(),
    );
    const input = { name: "Egen Box", salePrice: "120", purchasePrice: "40", ownProduct: false };
    const preview = await np.previewNewProductFor(viewer, input, IMG(), deps());
    expect(preview.warnings).toContain(
      "Egen Box är Egen produkt i Binderlab. Det ändras inte här (ändra under Inköpspriser).",
    );
    const r = await np.createNewProductFor(viewer, input, IMG(), preview.fingerprint, deps());
    expect(r).toMatchObject({ status: "created", titleId: title!.id });
    const t = await titleRows("Egen Box");
    expect(t).toHaveLength(1);
    expect(t[0]?.own_product).toBe(true);
  });
});

describe("Lägg i fack", () => {
  it("visar fack och varor, kräver bekräftelse och skickar panelens UpdateProduct", async () => {
    const viewer = await viewerFor(owner, orgId);
    fake.state.goods.push({
      id: 88,
      name: "Ny i fack",
      price: "79.00",
      thumb: "",
      media: [],
      description: "",
      content: "",
    });
    const choices = await np.slotChoicesFor(viewer, machineId, deps());
    expect(
      choices.slots.map((x) => [x.channelName, x.goodName, x.currentInventory, x.capacity]),
    ).toEqual([
      ["A1", "Mystery Pack", 5, 10],
      ["A2", null, 0, 8],
    ]);
    expect(choices.goods.map((g) => g.name)).toEqual(["Mystery Pack", "Ny i fack"]);

    const input = { machineId, productId: 11, goodId: 88, count: "7" };
    const preview = await np.previewSlotChangeFor(viewer, input, deps());
    expect(preview.lines).toEqual(["Fack A1: Mystery Pack 5 st → Ny i fack 7 st."]);
    expect(preview.confirm).toBe("Fack A1 har 5 Mystery Pack – byt ändå?");
    expect(writes()).toEqual([]);

    await expect(
      np.applySlotChangeFor(viewer, input, preview.fingerprint, false, deps()),
    ).rejects.toThrow("Bekräfta först: Fack A1 har 5 Mystery Pack – byt ändå?");
    expect(writes()).toEqual([]);

    const r = await np.applySlotChangeFor(viewer, input, preview.fingerprint, true, deps());
    expect(r.message).toBe("Klart! Fack A1: Ny i fack 7 st.");
    const update = fake.state.calls.find((c) => c.operationName === "UpdateProduct");
    expect(update?.variables).toEqual({
      id: 11,
      input: { good_id: 88, status: true, current_inventory: 7 },
    });
    const slot = fake.state.products["1001"]![0]!;
    expect([slot.goodId, slot.currentInventory]).toEqual([88, 7]);
  });

  it("ett tomt fack behöver ingen bekräftelse; en såld vara under tiden stoppar", async () => {
    const viewer = await viewerFor(owner, orgId);
    const input = { machineId, productId: 12, goodId: 6, count: "4" };
    const preview = await np.previewSlotChangeFor(viewer, input, deps());
    expect(preview.confirm).toBeNull();
    // Något ändras i Awish efter förhandsvisningen (t.ex. ett köp i ett annat fack påverkar
    // inte, men en ändring i just det här facket gör det).
    fake.state.products["1001"]![1]!.currentInventory = 1;
    fake.state.products["1001"]![1]!.goodId = 6;
    fake.state.products["1001"]![1]!.goodName = "Mystery Pack";
    await expect(
      np.applySlotChangeFor(viewer, input, preview.fingerprint, false, deps()),
    ).rejects.toThrow(/sedan förhandsvisningen/);
    expect(writes()).toEqual([]);
  });

  it("okopplad automat och okänt fack ger svenska fel", async () => {
    const viewer = await viewerFor(owner, orgId);
    const [other] = await asUser(owner, (tx) =>
      tx
        .insert(s.machines)
        .values({
          organizationId: orgId,
          code: "BL-077",
          name: "Okopplad",
          activeFrom: "2026-10-01",
        })
        .returning(),
    );
    await expect(np.slotChoicesFor(viewer, other!.id, deps())).rejects.toThrow(
      "Automaten är inte kopplad till Awish.",
    );
    await expect(
      np.previewSlotChangeFor(viewer, { machineId, productId: 999, goodId: 6, count: "" }, deps()),
    ).rejects.toThrow(/Facket finns inte/);
  });
});
