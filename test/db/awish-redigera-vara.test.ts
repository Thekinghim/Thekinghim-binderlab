/**
 * "Varor i Awish" och "Redigera vara" (src/server/awish/edit-good.ts) mot testdatabasen och
 * låtsas-panelen:
 *
 *  - bara ägare och admin; påfyllare, läsare och butiken nekas och inget skickas till Awish,
 *  - push måste vara påslaget,
 *  - listan: koppling via alias, sålt 30 d, fack, lager, kvar per order och flaggor,
 *  - hela flödet: förhandsvisning (med effekten av priset) → Spara skickar panelens
 *    UpdateGood med hela varan; det nya namnet blir alias på samma titel och titeln byter namn,
 *  - två varor med samma namn efter bytet stoppas,
 *  - Awish nekar (eller sparar inte): ingenting ändras i Binderlab,
 *  - ändrat i Awish efter förhandsvisningen och dubbelklick skickar inget två gånger,
 *  - Koppla: en vara utan titel får en ny titel eller kopplas till en befintlig.
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
const eg = await import("../../src/server/awish/edit-good");
const { FORBIDDEN_MESSAGE, STALE_MESSAGE } = await import("../../src/server/awish/new-product");
const { checkGoodImage } = await import("../../src/server/awish/goods");
const { encodeUpdateGoodInput, GOOD_PERMISSIONS } =
  await import("../../src/server/awish/goods-edit");
const ALL_GOOD_PERMISSIONS = Object.values(GOOD_PERMISSIONS);
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
let dataSourceId: string;

const JPG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 9, 8, 7, 6, 5]);

const updates = () => fake.state.calls.filter((c) => c.operationName === "UpdateGood");

/** En titel med alias, inköpspris och order (150 kr) de senaste dagarna. */
async function seedTitle(
  name: string,
  opts: { alias?: string | null; priceOre?: number | null; orders?: number } = {},
): Promise<string> {
  return asUser(owner, async (tx) => {
    const org = { organizationId: orgId };
    const [t] = await tx
      .insert(s.titles)
      .values({ ...org, name })
      .returning();
    const alias = opts.alias === undefined ? name : opts.alias;
    if (alias) await tx.insert(s.titleAliases).values({ ...org, titleId: t!.id, alias });
    if (opts.priceOre !== null) {
      await tx.insert(s.purchasePrices).values({
        ...org,
        titleId: t!.id,
        unitCostOre: opts.priceOre ?? 9_000,
        validFrom: "2026-01-01",
      });
    }
    const n = opts.orders ?? 0;
    if (n > 0) {
      await tx.insert(s.orders).values(
        Array.from({ length: n }, (_, i) => ({
          ...org,
          dataSourceId,
          externalId: `${name}-${i}`,
          rawTitle: alias ?? name,
          titleId: t!.id,
          orderedAt: new Date(`2026-11-0${1 + (i % 3)}T10:00:00Z`),
          amountOre: 15_000,
          sourceHash: `${name}-${i}`,
        })),
      );
    }
    return t!.id;
  });
}

async function titleState(titleId: string) {
  const [t] = await rows<{ name: string }>(
    db(),
    sql`select name from public.titles where organization_id = ${orgId}::uuid and id = ${titleId}::uuid`,
  );
  const aliases = await rows<{ alias: string }>(
    db(),
    sql`select alias from public.title_aliases
        where organization_id = ${orgId}::uuid and title_id = ${titleId}::uuid order by alias`,
  );
  return { name: t?.name, aliases: aliases.map((a) => a.alias) };
}

function delta(id: number, name: string) {
  return {
    id,
    name,
    price: "150.00",
    thumb: "https://img.example/delta.png",
    media: ["https://img.example/delta.png", "https://img.example/extra.png"],
    description: name,
    content: `<p>${name}</p>`,
    unitId: 3,
    taxRate: "12.00",
    isTaxExempt: false,
    costPrice: "80.00",
    attributes: [{ id: 9, label_name: "weight", label_value: ["100g"], immutable: false }],
  };
}

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
  ({ dataSourceId } = await saveAwishCredentialsFor(viewer, {
    appId: "app",
    appSecret: "secret",
    appKey: "key",
  }));
  await db().execute(sql`
    insert into public.source_machines (organization_id, data_source_id, external_id, external_name, machine_id)
    values (${orgId}::uuid, ${dataSourceId}::uuid, '1001', 'Sega gubben', ${machineId}::uuid)
    on conflict (organization_id, data_source_id, external_id) do update set machine_id = excluded.machine_id`);
});

beforeEach(async () => {
  fake = await startFakeAwishWeb({ products: {} });
  // Ett konto med alla varubehörigheter (det panelen visar alla fält för).
  fake.state.permissions = [...ALL_GOOD_PERMISSIONS];
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

describe("Varor i Awish: behörighet och påslag", () => {
  it("påfyllare, läsare och butiken nekas och inget skickas till Awish", async () => {
    fake.state.goods.push(delta(42, "Nekad vara"));
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
    const viewers: Viewer[] = [
      await viewerFor(await createMember(orgId, "refiller"), orgId),
      await viewerFor(await createMember(orgId, "viewer"), orgId),
      { user: { userId: store.id, email: store.email }, organization: org },
    ];
    const input = { goodId: 42, name: "Hackad", salePrice: "1" };
    for (const v of viewers) {
      await expect(eg.goodsOverviewFor(v, deps())).rejects.toThrow(FORBIDDEN_MESSAGE);
      await expect(eg.previewEditGoodFor(v, input, null, deps())).rejects.toThrow(
        FORBIDDEN_MESSAGE,
      );
      await expect(eg.saveEditGoodFor(v, input, null, "0".repeat(32), deps())).rejects.toThrow(
        FORBIDDEN_MESSAGE,
      );
      await expect(eg.linkGoodToTitleFor(v, { goodId: 42 }, deps())).rejects.toThrow(
        FORBIDDEN_MESSAGE,
      );
    }
    expect(fake.state.calls).toEqual([]);
    expect(fake.state.goods[0]!.name).toBe("Nekad vara");
  });

  it("push avstängd: inget skickas", async () => {
    const viewer = await viewerFor(owner, orgId);
    await setAwishWebPushFor(viewer, false);
    await expect(eg.goodsOverviewFor(viewer, deps())).rejects.toThrow(/Slå på Skicka påfyllningar/);
    await expect(
      eg.previewEditGoodFor(viewer, { goodId: 42, name: "X", salePrice: "1" }, null, deps()),
    ).rejects.toThrow(/Slå på Skicka påfyllningar/);
    expect(fake.state.calls).toEqual([]);
  });
});

describe("Varor i Awish: listan", () => {
  it("koppling, sålt 30 d, fack, lager, kvar per order och flaggor", async () => {
    const titleId = await seedTitle("Lista Delta", { orders: 3 });
    await seedTitle("Lista Utan Pris", { priceOre: null });
    fake.state.goods.push(
      delta(42, "Lista Delta"),
      { ...delta(43, "Lista Utan Pris"), thumb: "", media: [] },
      delta(44, "Lista Okänd"),
    );
    fake.state.products["1001"] = [
      {
        id: 11,
        goodId: 42,
        goodName: "Lista Delta",
        status: true,
        currentInventory: 5,
        capacity: 10,
        channelName: "A1",
      },
    ];
    const viewer = await viewerFor(owner, orgId);
    const overview = await eg.goodsOverviewFor(viewer, deps());
    expect(overview.machines).toBe(1);
    expect(overview.showShare).toBe(false);
    const row = (id: number) => overview.rows.find((r) => r.id === id)!;
    expect(row(42)).toMatchObject({
      name: "Lista Delta",
      priceOre: 15_000,
      titleId,
      sold30: 3,
      revenue30Ore: 45_000,
      packsInSlots: 5,
      warehouse: 0,
      purchaseOre: 9_000,
      flags: [],
    });
    expect(row(42).slots).toEqual([
      { goodId: 42, machine: "BL-001 Sega gubben", slot: "A1", count: 5, capacity: 10 },
    ]);
    // Utan moms och kortavgift i testorganisationen: 150 − 90 = 60 kr (samma som Inköpspriser).
    expect(row(42).leftOre).not.toBeNull();
    expect(row(42).image).toMatch(/^\/inkopspriser\/ny-produkt\/bild\?u=/);
    expect(row(43).flags.map((f) => f.kind)).toEqual(["no-purchase", "no-image", "no-slot"]);
    expect(row(44).flags.map((f) => f.kind)).toEqual(["unlinked", "no-slot"]);
    // Åtgärd först, bäst säljande sist här (den har inga flaggor).
    expect(overview.rows.at(-1)!.id).toBe(42);
    expect(overview.titles.some((t) => t.id === titleId)).toBe(true);
    // Listan skriver ingenting.
    expect(updates()).toEqual([]);
  });
});

describe("Redigera vara: hela flödet", () => {
  it("namn, pris och bild: panelens UpdateGood, alias och nytt titelnamn i Binderlab", async () => {
    const titleId = await seedTitle("Delta Reign", { orders: 3 });
    fake.state.goods.push(delta(42, "Delta Reign"), delta(6, "Mystery Pack"));
    const viewer = await viewerFor(owner, orgId);
    const input = { goodId: 42, name: "Delta Reign ETB", salePrice: "160" };
    const image = checkGoodImage(JPG, "Delta Reign ETB");

    const preview = await eg.previewEditGoodFor(viewer, input, image, deps());
    expect(preview.blocking).toBeNull();
    expect(preview.lines).toEqual([
      "Namn: Delta Reign → Delta Reign ETB",
      "Pris: 150 kr → 160 kr",
      "Bild: byts",
      "Beskrivningen i Awish får också det nya namnet.",
      "Binderlab: lägger till namnet Delta Reign ETB på titeln Delta Reign så försäljningen kopplas rätt.",
      "Binderlab: Delta Reign finns kvar, så gamla order hamnar rätt.",
      "Binderlab: titeln byter namn: Delta Reign → Delta Reign ETB",
    ]);
    expect(preview.effect[0]).toMatch(/^Kvar per order: .+ kr → .+ kr$/);
    expect(preview.effect[1]).toMatch(
      /^≈ \+\d+ kr per månad om försäljningen håller i sig \(3 sålda senaste 30 d\)/,
    );
    // Förhandsvisningen skriver ingenting.
    expect(updates()).toEqual([]);
    expect(fake.state.uploads).toEqual([]);

    const reader = createAwishWebClient({ baseUrl: fake.baseUrl, now: () => NOW.getTime() });
    await reader.login({ email: fake.state.email, password: fake.state.password });
    const before = (await reader.allGoodsFull()).find((x) => x.id === 42)!;
    const r = await eg.saveEditGoodFor(viewer, input, image, preview.fingerprint, deps());
    expect(r.status).toBe("saved");
    expect(r.message).toBe(
      "Klart! Delta Reign ETB är sparad i Awish. Försäljningen kopplas till Delta Reign.",
    );

    const url = fake.state.uploads[0]!.url;
    const call = updates()[0]!;
    expect(call.query).toBe(
      "mutation UpdateGood($id: Int!, $input: GoodInput!) { updateGood(id: $id, input: $input) }",
    );
    expect(call.variables).toEqual({
      id: 42,
      input: encodeUpdateGoodInput(
        before,
        { name: "Delta Reign ETB", priceOre: 16_000, imageUrl: url },
        ALL_GOOD_PERMISSIONS,
      ),
    });
    expect(fake.state.rejected).toEqual([]);
    const g = fake.state.goods.find((x) => x.id === 42)!;
    expect(g).toMatchObject({
      name: "Delta Reign ETB",
      price: "160.00",
      thumb: url,
      media: [url, "https://img.example/extra.png"],
      unitId: 3,
      taxRate: "12.00",
      isTaxExempt: false,
      costPrice: "80.00",
      attributes: [{ id: 9, label_name: "weight", label_value: ["100g"], immutable: false }],
    });
    expect(r.good).toMatchObject({ id: 42, name: "Delta Reign ETB", priceOre: 16_000 });

    // Binderlab: samma titel, båda namnen som alias, titeln heter som varan.
    expect(await titleState(titleId)).toEqual({
      name: "Delta Reign ETB",
      aliases: ["Delta Reign", "Delta Reign ETB"],
    });

    // Igen: inget ändrat, ingen ny UpdateGood.
    const again = await eg.previewEditGoodFor(
      viewer,
      { goodId: 42, name: "Delta Reign ETB", salePrice: "160" },
      null,
      deps(),
    );
    expect(again.nothingToDo).toBe(true);
    expect(updates()).toHaveLength(1);
  });

  it("titeln heter annorlunda: bara aliaset läggs till", async () => {
    const titleId = await seedTitle("SV Prismatic Evolutions", { alias: "Prismatic ETB" });
    fake.state.goods.push(delta(50, "Prismatic ETB"));
    const viewer = await viewerFor(owner, orgId);
    const input = { goodId: 50, name: "Prismatic Elite Trainer Box", salePrice: "150" };
    const preview = await eg.previewEditGoodFor(viewer, input, null, deps());
    expect(preview.effect).toEqual([]);
    await eg.saveEditGoodFor(viewer, input, null, preview.fingerprint, deps());
    expect(await titleState(titleId)).toEqual({
      name: "SV Prismatic Evolutions",
      aliases: ["Prismatic ETB", "Prismatic Elite Trainer Box"],
    });
  });

  it("två varor med samma namn efter bytet: stoppas, inget skickas", async () => {
    fake.state.goods.push(delta(42, "Krock A"), delta(43, "Krock B"));
    const viewer = await viewerFor(owner, orgId);
    const input = { goodId: 42, name: "  krock   b ", salePrice: "150" };
    const preview = await eg.previewEditGoodFor(viewer, input, null, deps());
    expect(preview.blocking).toBe(
      "Awish har redan en vara som heter Krock B (id 43). Välj ett annat namn.",
    );
    await expect(
      eg.saveEditGoodFor(viewer, input, null, preview.fingerprint, deps()),
    ).rejects.toThrow("Awish har redan en vara som heter Krock B");
    expect(updates()).toEqual([]);
  });

  it("Awish nekar: Binderlab oförändrat, svenskt fel", async () => {
    const titleId = await seedTitle("Nekas Vara");
    fake.state.goods.push(delta(42, "Nekas Vara"));
    const viewer = await viewerFor(owner, orgId);
    const input = { goodId: 42, name: "Nekas Vara Ny", salePrice: "155" };
    const preview = await eg.previewEditGoodFor(viewer, input, null, deps());
    fake.state.failOn.UpdateGood = { message: "The name has already been taken." };
    await expect(
      eg.saveEditGoodFor(viewer, input, null, preview.fingerprint, deps()),
    ).rejects.toThrow("Awish svarade med ett fel: The name has already been taken.");
    expect(await titleState(titleId)).toEqual({ name: "Nekas Vara", aliases: ["Nekas Vara"] });
    expect(fake.state.goods.find((g) => g.id === 42)!.name).toBe("Nekas Vara");
  });

  it("Awish svarar ja men sparar inte: sägs tydligt, Binderlab oförändrat", async () => {
    const titleId = await seedTitle("Tyst Vara");
    fake.state.goods.push(delta(42, "Tyst Vara"));
    const viewer = await viewerFor(owner, orgId);
    const input = { goodId: 42, name: "Tyst Vara Ny", salePrice: "150" };
    const preview = await eg.previewEditGoodFor(viewer, input, null, deps());
    fake.state.dropNextUpdate = true;
    await expect(
      eg.saveEditGoodFor(viewer, input, null, preview.fingerprint, deps()),
    ).rejects.toThrow("Awish sparade inte namnet. Inget ändrades i Binderlab.");
    expect(await titleState(titleId)).toEqual({ name: "Tyst Vara", aliases: ["Tyst Vara"] });
  });

  it("Awish sparar men svaret går förlorat: aliaset sparas ändå så försäljningen kopplas", async () => {
    const titleId = await seedTitle("Tappad Vara");
    fake.state.goods.push(delta(42, "Tappad Vara"));
    const viewer = await viewerFor(owner, orgId);
    const input = { goodId: 42, name: "Tappad Vara Ny", salePrice: "150" };
    const preview = await eg.previewEditGoodFor(viewer, input, null, deps());
    fake.state.failAfterNextUpdate = true;
    const r = await eg.saveEditGoodFor(viewer, input, null, preview.fingerprint, deps());
    expect(fake.state.goods.find((g) => g.id === 42)!.name).toBe("Tappad Vara Ny");
    expect(r.status).toBe("saved");
    expect(await titleState(titleId)).toEqual({
      name: "Tappad Vara Ny",
      aliases: ["Tappad Vara", "Tappad Vara Ny"],
    });
  });

  it("Awish nås inte alls vid sändningen: Binderlab oförändrat", async () => {
    const titleId = await seedTitle("Nere Vara");
    fake.state.goods.push(delta(42, "Nere Vara"));
    const viewer = await viewerFor(owner, orgId);
    const input = { goodId: 42, name: "Nere Vara Ny", salePrice: "150" };
    const preview = await eg.previewEditGoodFor(viewer, input, null, deps());
    fake.state.failOn.UpdateGood = { message: "server error" };
    await expect(
      eg.saveEditGoodFor(viewer, input, null, preview.fingerprint, deps()),
    ).rejects.toThrow();
    expect(fake.state.goods.find((g) => g.id === 42)!.name).toBe("Nere Vara");
    expect(await titleState(titleId)).toEqual({ name: "Nere Vara", aliases: ["Nere Vara"] });
  });

  it("kontot får inte ändra kostnadspriset som varan har: stoppas, inget nollställs", async () => {
    fake.state.goods.push(delta(42, "Kostvara"));
    fake.state.permissions = ["goods:update", "goods:attributes:update"];
    const viewer = await viewerFor(owner, orgId);
    const input = { goodId: 42, name: "Kostvara", salePrice: "160" };
    const preview = await eg.previewEditGoodFor(viewer, input, null, deps());
    expect(preview.blocking).toMatch(/^Awish-kontot får inte ändra varans kostnadspris\./);
    await expect(
      eg.saveEditGoodFor(viewer, input, null, preview.fingerprint, deps()),
    ).rejects.toThrow(/kostnadspris/);
    expect(updates()).toEqual([]);
    expect(fake.state.goods.find((g) => g.id === 42)!.costPrice).toBe("80.00");
  });

  it("bara priset sparas inte: partial med besked", async () => {
    fake.state.goods.push(delta(42, "Prisvara"));
    const viewer = await viewerFor(owner, orgId);
    const input = { goodId: 42, name: "Prisvara", salePrice: "175" };
    const preview = await eg.previewEditGoodFor(viewer, input, null, deps());
    fake.state.dropNextUpdate = true;
    const r = await eg.saveEditGoodFor(viewer, input, null, preview.fingerprint, deps());
    expect(r.status).toBe("partial");
    expect(r.message).toBe("Awish sparade inte priset. Titta i Awish och försök igen.");
    expect(r.good.priceOre).toBe(15_000);
  });

  it("varan ändrad i Awish efter förhandsvisningen: inget skickas", async () => {
    fake.state.goods.push(delta(42, "Ändrad Vara"));
    const viewer = await viewerFor(owner, orgId);
    const input = { goodId: 42, name: "Ändrad Vara", salePrice: "151" };
    const preview = await eg.previewEditGoodFor(viewer, input, null, deps());
    fake.state.goods.find((g) => g.id === 42)!.description = "Ändrad i panelen";
    await expect(
      eg.saveEditGoodFor(viewer, input, null, preview.fingerprint, deps()),
    ).rejects.toThrow(STALE_MESSAGE);
    expect(updates()).toEqual([]);
  });

  it("dubbelklick: varan ändras en gång", async () => {
    const titleId = await seedTitle("Dubbel Vara");
    fake.state.goods.push(delta(42, "Dubbel Vara"));
    const viewer = await viewerFor(owner, orgId);
    const input = { goodId: 42, name: "Dubbel Vara 2", salePrice: "150" };
    const preview = await eg.previewEditGoodFor(viewer, input, null, deps());
    const results = await Promise.allSettled([
      eg.saveEditGoodFor(viewer, input, null, preview.fingerprint, deps()),
      eg.saveEditGoodFor(viewer, input, null, preview.fingerprint, deps()),
    ]);
    expect(results.filter((x) => x.status === "fulfilled")).toHaveLength(1);
    expect(updates()).toHaveLength(1);
    expect(await titleState(titleId)).toEqual({
      name: "Dubbel Vara 2",
      aliases: ["Dubbel Vara", "Dubbel Vara 2"],
    });
  });

  it("kontot saknar behörighet i Awish: stoppas före sändning", async () => {
    fake.state.goods.push(delta(42, "Behörighet"));
    fake.state.permissions = [];
    const viewer = await viewerFor(owner, orgId);
    const preview = await eg.previewEditGoodFor(
      viewer,
      { goodId: 42, name: "Behörighet", salePrice: "99" },
      null,
      deps(),
    );
    expect(preview.blocking).toMatch(/får inte ändra varor/);
    expect(updates()).toEqual([]);
  });
});

describe("Koppla en vara till Binderlab", () => {
  it("ny titel med varans namn, eller alias på en befintlig titel", async () => {
    const existing = await seedTitle("Befintlig Titel");
    fake.state.goods.push(delta(60, "Helt Ny Vara"), delta(61, "Annat Namn"));
    const viewer = await viewerFor(owner, orgId);

    const created = await eg.linkGoodToTitleFor(viewer, { goodId: 60, titleId: null }, deps());
    expect(created.titleName).toBe("Helt Ny Vara");
    expect(await titleState(created.titleId)).toEqual({
      name: "Helt Ny Vara",
      aliases: ["Helt Ny Vara"],
    });

    const linked = await eg.linkGoodToTitleFor(viewer, { goodId: 61, titleId: existing }, deps());
    expect(linked.titleId).toBe(existing);
    expect((await titleState(existing)).aliases).toEqual(["Annat Namn", "Befintlig Titel"]);

    await expect(
      eg.linkGoodToTitleFor(viewer, { goodId: 61, titleId: null }, deps()),
    ).rejects.toThrow("Annat Namn är redan kopplad till Befintlig Titel.");
    expect(updates()).toEqual([]);
  });
});
