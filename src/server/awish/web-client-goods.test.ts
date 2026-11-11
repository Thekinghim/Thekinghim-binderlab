/**
 * Webb-klientens varor, valutor, bilder och fack mot låtsas-panelen, och att låtsas-panelen
 * är lika sträng som riktiga Awish om formen på anropen (fel form nekas, inget ändras).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { startFakeAwishWeb } = await import("./testing/fake-web-server");
type FakeWeb = Awaited<ReturnType<typeof startFakeAwishWeb>>;
const { DASHBOARD_DOCUMENTS } = await import("./testing/dashboard-documents");
const docs = await import("./web-documents");
const { awishWebBaseUrlFromEnv, createAwishWebClient } = await import("./web-client");
const { checkGoodImage, encodeGoodInput } = await import("./goods");
const { awishEncode, awishSignInput } = await import("./web-sign");
const { AwishApiError } = await import("./grpc-client");
const { MISSING_TIMESTAMP_MESSAGE } = await import("./testing/fake-web-server");

let fake: FakeWeb;

const NOW = 1_762_250_000_000;

beforeEach(async () => {
  fake = await startFakeAwishWeb({
    // Samma klocka som klienten: signaturens tidsfönster räknas mot den.
    now: () => NOW,
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
          inventory: 6,
          channelName: "A2",
          floorStatus: "ERR_MOTOR_FAULT",
        },
      ],
    },
  });
});

afterEach(async () => {
  await fake.stop();
});

async function loggedIn() {
  const c = createAwishWebClient({ baseUrl: fake.baseUrl, now: () => NOW });
  await c.login({ email: fake.state.email, password: fake.state.password });
  return c;
}

/** Indata signerat som panelen 1.30.5 gör (timestamp + sign), med testets klocka. */
const signed = <T extends object>(value: T) => awishSignInput(value, fake.state.appKey, NOW);

/** Ett rått anrop till låtsas-panelen, som klienten skulle göra det. */
async function raw(operationName: string, query: string, variables: Record<string, unknown>) {
  const res = await fetch(`${fake.baseUrl}/graphql`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      Appid: fake.state.appId,
      Authorization: `Bearer ${fake.state.accessToken}`,
    },
    body: JSON.stringify({ operationName, query, variables }),
  });
  return (await res.json()) as {
    data?: Record<string, unknown>;
    errors?: Array<{ message: string }>;
  };
}

describe("dokumenten", () => {
  it("klientens dokument är ordagrant panelens", () => {
    expect(docs.SIGNIN_DOCUMENT).toBe(DASHBOARD_DOCUMENTS.Signin);
    expect(docs.PROFILE_DOCUMENT).toBe(DASHBOARD_DOCUMENTS.Profile);
    expect(docs.UNITS_AND_CURRENCIES_DOCUMENT).toBe(DASHBOARD_DOCUMENTS.UnitsAndCurrencies);
    expect(docs.GOODS_DOCUMENT).toBe(DASHBOARD_DOCUMENTS.Goods);
    expect(docs.CREATE_GOOD_DOCUMENT).toBe(DASHBOARD_DOCUMENTS.CreateGood);
    expect(docs.UPDATE_GOOD_DOCUMENT).toBe(DASHBOARD_DOCUMENTS.UpdateGood);
    expect(docs.CATEGORIES_DOCUMENT).toBe(DASHBOARD_DOCUMENTS.Categories);
    expect(docs.PRODUCTS_DOCUMENT).toBe(DASHBOARD_DOCUMENTS.Products);
    expect(docs.UPDATE_PRODUCT_DOCUMENT).toBe(DASHBOARD_DOCUMENTS.UpdateProduct);
    expect(docs.CREATE_PRODUCT_DOCUMENT).toBe(DASHBOARD_DOCUMENTS.CreateProduct);
  });
});

describe("varor, valuta och bild", () => {
  it("läser butikens merchant-id och SEK", async () => {
    const c = await loggedIn();
    const { merchantId } = await c.profile();
    expect(merchantId).toBe(77);
    const currencies = await c.currencies(merchantId);
    expect(currencies.find((x) => x.code === "SEK")?.id).toBe(2);
    expect(
      fake.state.calls.find((x) => x.operationName === "UnitsAndCurrencies")?.variables,
    ).toEqual({
      input: { merchant_id: 77 },
    });
  });

  it("läser alla varor sida för sida (20 per sida som panelen)", async () => {
    for (let i = 0; i < 25; i += 1) {
      fake.state.goods.push({
        id: 100 + i,
        name: `Vara ${i}`,
        price: "12.50",
        thumb: "",
        media: [],
        description: "",
        content: "",
      });
    }
    const c = await loggedIn();
    const goods = await c.allGoods();
    expect(goods).toHaveLength(26);
    expect(goods.find((g) => g.id === 100)?.priceOre).toBe(1250);
    const pages = fake.state.calls
      .filter((x) => x.operationName === "Goods")
      .map((x) => x.variables);
    expect(pages).toEqual([
      { input: { per_page: 20, current_page: 1 } },
      { input: { per_page: 20, current_page: 2 } },
    ]);
  });

  it("skapar en vara med panelens GoodInput", async () => {
    const c = await loggedIn();
    await c.createGood(
      encodeGoodInput({ name: "Mystery XL", salePriceOre: 9900, currencyId: 2, imageUrl: null }),
    );
    const g = fake.state.goods.find((x) => x.name === "Mystery XL");
    expect(g?.price).toBe("99.00");
    expect(fake.state.rejected).toEqual([]);
  });

  it("laddar upp en bild som panelen: fälten, token utan Bearer, Appid och tid", async () => {
    const c = await loggedIn();
    const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
    const url = await c.uploadImage(checkGoodImage(jpg, "Mystery XL"));
    expect(url).toBe(`${fake.baseUrl}/uploads/1.jpg`);
    expect(fake.state.uploads[0]).toMatchObject({
      fileName: "mystery-xl.jpg",
      type: "image/jpeg",
      size: 8,
      fields: {
        compress: '{"quality":80}',
        crop: '{"width":400,"height":400}',
        thumbnail: '{"width":400,"height":400}',
        resize: '{"width":400,"height":400}',
      },
    });
  });

  it("uppladdning med Bearer-token eller utan fält nekas (som panelens server)", async () => {
    const form = new FormData();
    form.append(
      "file",
      new Blob([new Uint8Array([0xff, 0xd8, 0xff])], { type: "image/jpeg" }),
      "a.jpg",
    );
    const bearer = await fetch(`${fake.baseUrl}/api/v1/files`, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${fake.state.accessToken}`,
        Appid: fake.state.appId,
        timestamp: "1762250000",
      },
      body: form,
    });
    expect(bearer.status).toBe(401);
    const svg = new FormData();
    svg.append("file", new Blob(["<svg/>"], { type: "image/svg+xml" }), "a.svg");
    const bad = await fetch(`${fake.baseUrl}/api/v1/files`, {
      method: "POST",
      headers: {
        Authorization: fake.state.accessToken,
        Appid: fake.state.appId,
        timestamp: "1762250000",
      },
      body: svg,
    });
    expect(bad.status).toBe(422);
    expect(fake.state.uploads).toEqual([]);
  });

  it("ett uppladdningsfel blir ett svenskt fel", async () => {
    const c = await loggedIn();
    fake.state.uploadFailStatus = 413;
    await expect(
      c.uploadImage(checkGoodImage(new Uint8Array([0xff, 0xd8, 0xff, 0]), "x")),
    ).rejects.toThrow("Awish tog inte emot bilden: den är för stor.");
  });

  it("fack: vara, felstatus, antal och fackets egen kapacitet", async () => {
    const c = await loggedIn();
    const slots = await c.slots(1001);
    expect(slots).toEqual([
      {
        id: 11,
        channelName: "A1",
        goodId: 6,
        goodName: "Mystery Pack",
        status: true,
        floorStatus: "ERR_NORMAL",
        currentInventory: 5,
        capacity: 10,
      },
      {
        id: 12,
        channelName: "A2",
        goodId: null,
        goodName: null,
        status: true,
        floorStatus: "ERR_MOTOR_FAULT",
        currentInventory: 0,
        capacity: 6,
      },
    ]);
  });

  it("UpdateProduct byter vara och antal i ett fack", async () => {
    const c = await loggedIn();
    fake.state.goods.push({
      id: 7,
      name: "30th",
      price: "79.00",
      thumb: "",
      media: [],
      description: "",
      content: "",
    });
    await c.setProductInventory(11, { goodId: 7, status: true, currentInventory: 3 });
    const p = fake.state.products["1001"]![0]!;
    expect([p.goodId, p.goodName, p.currentInventory]).toEqual([7, "30th", 3]);
  });

  it("panelens adress kan pekas om lokalt, men aldrig till okrypterad adress i drift", () => {
    expect(awishWebBaseUrlFromEnv({})).toBe("https://dash.awish.vip");
    expect(awishWebBaseUrlFromEnv({ AWISH_WEB_BASE_URL: "http://127.0.0.1:4555/" })).toBe(
      "http://127.0.0.1:4555",
    );
    expect(
      awishWebBaseUrlFromEnv({
        AWISH_WEB_BASE_URL: "http://127.0.0.1:4555",
        NODE_ENV: "production",
      }),
    ).toBe("https://dash.awish.vip");
    expect(awishWebBaseUrlFromEnv({ AWISH_WEB_BASE_URL: "http://evil.example" })).toBe(
      "https://dash.awish.vip",
    );
    expect(awishWebBaseUrlFromEnv({ AWISH_WEB_BASE_URL: "https://proxy.example/x" })).toBe(
      "https://proxy.example",
    );
  });
});

describe("låtsas-panelen är lika sträng som riktiga Awish", () => {
  const input = () =>
    encodeGoodInput({ name: "Ny", salePriceOre: 100, currencyId: 2, imageUrl: null });

  it("urval på en skalär mutation nekas", async () => {
    const r = await raw(
      "CreateGood",
      "mutation CreateGood($input: GoodInput!) { createGood(input: $input) { id } }",
      { input: input() },
    );
    expect(r.errors?.[0]?.message).toMatch(/must not have a selection/);
    expect(fake.state.goods.some((g) => g.name === "Ny")).toBe(false);
  });

  it("fel variabeltyp, saknad variabel och okänt fält nekas", async () => {
    const wrongType = await raw(
      "CreateGood",
      "mutation CreateGood($input: GoodsInput!) { createGood(input: $input) }",
      { input: input() },
    );
    expect(wrongType.errors?.[0]?.message).toMatch(/expecting type "GoodInput!"/);
    const missing = await raw("CreateGood", docs.CREATE_GOOD_DOCUMENT, {});
    expect(missing.errors?.[0]?.message).toMatch(/was not provided/);
    const unknown = await raw(
      "Goods",
      "query Goods($input: GoodsQueryInput!) { goods(input: $input) { data { id name sku } } }",
      { input: { per_page: 20, current_page: 1 } },
    );
    expect(unknown.errors?.[0]?.message).toMatch(/Cannot query field "sku"/);
    const noSelection = await raw(
      "Goods",
      "query Goods($input: GoodsQueryInput!) { goods(input: $input) }",
      { input: { per_page: 20, current_page: 1 } },
    );
    expect(noSelection.errors?.[0]?.message).toMatch(/must have a selection/);
  });

  it("GoodInput: pris som sträng, okänt fält, saknat fält och okänd valuta nekas", async () => {
    const cases: Array<[Record<string, unknown>, RegExp]> = [
      [{ ...input(), prices: [{ ...input().prices[0], price: "1.00" }] }, /Float cannot represent/],
      [{ ...input(), category_id: 3 }, /Field "category_id" is not defined by type "GoodInput"/],
      [{ ...input(), description: undefined }, /description/],
      [{ ...input(), prices: [{ ...input().prices[0], currency_id: 99 }] }, /currency not found/],
      [{ ...input(), prices: [{ ...input().prices[0], price: 0 }] }, /at least 0.01/],
      [{ ...input(), prices: [] }, /prices is required/],
    ];
    for (const [value, error] of cases) {
      const r = await raw("CreateGood", docs.CREATE_GOOD_DOCUMENT, { input: signed(value) });
      expect(r.errors?.[0]?.message).toMatch(error);
    }
    expect(fake.state.goods.some((g) => g.name === "Ny")).toBe(false);
  });

  it("ProductInput med okänt fält eller antal över kapaciteten nekas, facket rörs inte", async () => {
    const extra = await raw("UpdateProduct", docs.UPDATE_PRODUCT_DOCUMENT, {
      id: 11,
      input: signed({ good_id: 6, status: true, current_inventory: 2, price: 10 }),
    });
    expect(extra.errors?.[0]?.message).toMatch(
      /Field "price" is not defined by type "ProductInput"/,
    );
    const over = await raw("UpdateProduct", docs.UPDATE_PRODUCT_DOCUMENT, {
      id: 11,
      input: signed({ good_id: 6, status: true, current_inventory: 11 }),
    });
    expect(over.errors?.[0]?.message).toMatch(/exceeds capacity/);
    expect(fake.state.products["1001"]![0]!.currentInventory).toBe(5);
  });

  it("osignerad skrivning nekas med riktiga Awishs egen text, och inget ändras", async () => {
    const good = await raw("CreateGood", docs.CREATE_GOOD_DOCUMENT, { input: input() });
    expect(good.errors?.[0]?.message).toBe(
      'Invalid value for argument "input", field "timestamp" of type "Int!" is required but not provided',
    );
    expect(good.errors?.[0]?.message).toBe(MISSING_TIMESTAMP_MESSAGE);
    const update = await raw("UpdateGood", docs.UPDATE_GOOD_DOCUMENT, { id: 6, input: input() });
    expect(update.errors?.[0]?.message).toBe(MISSING_TIMESTAMP_MESSAGE);
    const slot = await raw("UpdateProduct", docs.UPDATE_PRODUCT_DOCUMENT, {
      id: 11,
      input: { good_id: 6, status: true, current_inventory: 2 },
    });
    expect(slot.errors?.[0]?.message).toBe(MISSING_TIMESTAMP_MESSAGE);
    expect(fake.state.goods.some((g) => g.name === "Ny")).toBe(false);
    expect(fake.state.products["1001"]![0]!.currentInventory).toBe(5);
  });

  it("fel signatur, ändrat fält efter signeringen, fel nyckel och gammal tid nekas", async () => {
    const slot = { good_id: 6, status: true, current_inventory: 2 };
    const send = (value: object) =>
      raw("UpdateProduct", docs.UPDATE_PRODUCT_DOCUMENT, { id: 11, input: value });
    const cases: Array<[object, RegExp]> = [
      [{ ...signed(slot), current_inventory: 3 }, /signature mismatch/],
      [{ ...signed(slot), sign: "0".repeat(64) }, /signature mismatch/],
      [awishSignInput(slot, "fel-nyckel", NOW), /signature mismatch/],
      [awishSignInput(slot, fake.state.appKey, NOW - 3_600_000), /out of time window/],
      [{ ...signed(slot), sign: "INTE-HEX" }, /expected hexadecimal/],
      [{ ...slot, timestamp: Math.trunc(NOW / 1000) }, /field "sign"/],
      [{ ...signed(slot), timestamp: String(Math.trunc(NOW / 1000)) }, /Int cannot represent/],
    ];
    for (const [value, error] of cases) {
      expect((await send(value)).errors?.[0]?.message).toMatch(error);
    }
    expect(fake.state.products["1001"]![0]!.currentInventory).toBe(5);
    // Rätt signerat går igenom.
    expect((await send(signed(slot))).data).toEqual({ updateProduct: true });
    expect(fake.state.products["1001"]![0]!.currentInventory).toBe(2);
  });

  it("klienten signerar CreateGood, UpdateGood och UpdateProduct som panelen 1.30.5", async () => {
    fake.state.goods.push({
      id: 6,
      name: "Mystery Pack",
      price: "49.00",
      thumb: "",
      media: [],
      description: "",
      content: "",
    });
    const c = await loggedIn();
    const good = encodeGoodInput({
      name: "Signerad",
      salePriceOre: 7950,
      currencyId: 2,
      imageUrl: null,
    });
    await c.createGood(good);
    await c.setProductInventory(11, { goodId: 6, status: true, currentInventory: 3 });
    expect(fake.state.rejected).toEqual([]);
    const sent = (op: string) =>
      fake.state.calls.find((x) => x.operationName === op)!.variables.input as Record<
        string,
        unknown
      >;
    expect(sent("CreateGood")).toEqual(signed(good));
    expect(sent("CreateGood").timestamp).toBe(1_762_250_000);
    expect(sent("CreateGood").sign).toMatch(/^[0-9a-f]{64}$/);
    expect(sent("UpdateProduct")).toEqual(
      signed({ good_id: 6, status: true, current_inventory: 3 }),
    );
    expect(fake.state.products["1001"]![0]!.currentInventory).toBe(3);
  });

  it("ändrar Awish formen igen blir felet enkel svenska; den tekniska texten går till loggen", async () => {
    const c = await loggedIn();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const technical =
        'Invalid value for argument "input", field "nonce" of type "String!" is required but not provided';
      const good = encodeGoodInput({
        name: "Ny",
        salePriceOre: 100,
        currencyId: 2,
        imageUrl: null,
      });
      fake.state.failOn.CreateGood = { message: technical };
      const error = await c.createGood(good).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(AwishApiError);
      const e = error as InstanceType<typeof AwishApiError>;
      expect(e.message).toBe(
        "Awish har ändrat sitt system. Produkten skapades inte. Säg till så rättar vi appen.",
      );
      expect(e.kind).toBe("changed");
      expect(e.retryable).toBe(false);
      expect(e.technical).toBe(technical);
      expect(log).toHaveBeenCalledWith(`[awish-webb] Awish nekade CreateGood: ${technical}`);

      fake.state.failOn.UpdateProduct = { message: "signature verification failed" };
      await expect(
        c.setProductInventory(11, { goodId: 6, status: true, currentInventory: 3 }),
      ).rejects.toThrow(
        "Awish har ändrat sitt system. Antalet skickades inte till Awish. Säg till så rättar vi appen.",
      );
      fake.state.failOn.UpdateGood = { message: 'Field "x" is not defined by type "GoodInput".' };
      await expect(c.updateGood(6, good)).rejects.toThrow(
        "Awish har ändrat sitt system. Ändringen sparades inte. Säg till så rättar vi appen.",
      );
      // Ett vanligt nej från Awish (inte formen) visas som förut.
      fake.state.failOn.CreateGood = { message: "The name has already been taken." };
      await expect(c.createGood(good)).rejects.toThrow(
        "Awish svarade med ett fel: The name has already been taken.",
      );
      // En trasig inloggnings-token är en inloggning som ska göras om, inte en ändring hos Awish.
      fake.state.failOn.CreateGood = { message: "token signature is invalid" };
      const auth = (await c.createGood(good).catch((e: unknown) => e)) as InstanceType<
        typeof AwishApiError
      >;
      expect(auth.kind).toBe("auth");
      expect(auth.message).toBe(
        "Awish nekade inloggningen. Kontrollera e-post och lösenord under Datakällor.",
      );
    } finally {
      log.mockRestore();
    }
  });

  it("loggen får aldrig långa kodade värden (t.ex. en inloggnings-payload)", async () => {
    const c = await loggedIn();
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const secret = Buffer.from(JSON.stringify({ email: "a@b.se", password: "hemligt-lösen" }))
        .toString("base64")
        .padEnd(60, "A");
      fake.state.failOn.Goods = { message: `Variable "$input" got invalid value "${secret}".` };
      await expect(c.goods(1)).rejects.toThrow("Awish har ändrat sitt system.");
      expect(JSON.stringify(log.mock.calls)).not.toContain(secret);
      expect(JSON.stringify(log.mock.calls)).toContain("[dolt]");
    } finally {
      log.mockRestore();
    }
  });

  it("CreateProduct (synka fack) är bara för root; Categories tar machine_id", async () => {
    const r = await raw("CreateProduct", docs.CREATE_PRODUCT_DOCUMENT, { machine_id: 1001 });
    expect(r.errors?.[0]?.message).toBe("permission denied");
    fake.state.categories["1001"] = [{ id: 1, title: "Pokémon" }];
    const cats = await raw("Categories", docs.CATEGORIES_DOCUMENT, { machine_id: 1001 });
    expect(cats.data).toEqual({
      categories: [
        { id: 1, title: "Pokémon", machine_id: 1001, sort_id: 0, is_visible: true, priority: 1 },
      ],
    });
  });

  it("svaret har bara de fält som frågades efter", async () => {
    const input = awishEncode({ machine_id: "1001" }, fake.state.appKey, NOW);
    const r = await raw(
      "Products",
      "query Products($input: String!) { products(input: $input) { id current_inventory } }",
      { input },
    );
    expect(r.data).toEqual({
      products: [
        { id: 11, current_inventory: 5 },
        { id: 12, current_inventory: 0 },
      ],
    });
  });

  it("påfyllningens Products-fråga (med good_id) godtas", async () => {
    const input = awishEncode({ machine_id: "1001" }, fake.state.appKey, NOW);
    const r = await raw(
      "Products",
      "query Products($input: String!) { products(input: $input) { id good_id status current_inventory good { id name } channel { name total } } }",
      { input },
    );
    expect(r.errors).toBeUndefined();
  });
});

const { encodeUpdateGoodInput, GOOD_PERMISSIONS } = await import("./goods-edit");

describe("Redigera vara (UpdateGood)", () => {
  function seed() {
    fake.state.goods.push({
      id: 42,
      name: "Delta Reign",
      price: "150.00",
      thumb: "https://img.example/a.png",
      media: ["https://img.example/a.png", "https://img.example/b.png"],
      description: "Delta Reign",
      content: "<p>Delta Reign</p>",
      priceId: 4200,
      originalPrice: "199.00",
      costPrice: "80.00",
      extraPrices: [{ id: 4201, currencyId: 1, price: "14.50" }],
      multiCurrency: true,
      slug: "delta-reign",
      unitId: 3,
      attributes: [{ id: 9, label_name: "weight", label_value: ["100g"], immutable: false }],
      isTaxExempt: false,
      taxRate: "12.00",
      isReturnable: true,
    });
  }

  it("läser kontots behörigheter (Profile.permissions)", async () => {
    const c = await loggedIn();
    expect((await c.profile()).permissions).toEqual([
      "goods:create",
      "goods:update",
      "goods:delete",
    ]);
  });

  it("skickar panelens dokument och hela varan; bara namn, SEK-pris och bild ändras", async () => {
    seed();
    const c = await loggedIn();
    const good = (await c.allGoodsFull()).find((g) => g.id === 42)!;
    const input = encodeUpdateGoodInput(
      good,
      { name: "Delta Reign ETB", priceOre: 16_000, imageUrl: "https://img.example/ny.png" },
      Object.values(GOOD_PERMISSIONS),
    );
    await c.updateGood(42, input);
    expect(fake.state.rejected).toEqual([]);
    const call = fake.state.calls.find((x) => x.operationName === "UpdateGood")!;
    expect(call.query).toBe(DASHBOARD_DOCUMENTS.UpdateGood);
    // Hela varan plus panelens två signaturfält (1.30.5).
    expect(call.variables).toEqual({ id: 42, input: signed(input) });

    const after = (await c.allGoodsFull()).find((g) => g.id === 42)!;
    expect(after).toEqual({
      ...good,
      name: "Delta Reign ETB",
      description: "Delta Reign ETB",
      content: "<p>Delta Reign ETB</p>",
      thumb: "https://img.example/ny.png",
      media: ["https://img.example/ny.png", "https://img.example/b.png"],
      prices: [{ ...good.prices[0]!, price: 160 }, good.prices[1]!],
    });
  });

  it("låtsas-panelen nekar fel form: urval på mutationen, okänt fält, fel pris-id", async () => {
    seed();
    const c = await loggedIn();
    const good = (await c.allGoodsFull()).find((g) => g.id === 42)!;
    const input = encodeUpdateGoodInput(
      good,
      { name: "X", priceOre: 100, imageUrl: null },
      Object.values(GOOD_PERMISSIONS),
    );
    const withSelection = await raw(
      "UpdateGood",
      "mutation UpdateGood($id: Int!, $input: GoodInput!) { updateGood(id: $id, input: $input) { id } }",
      { id: 42, input: signed(input) },
    );
    expect(withSelection.errors?.[0]?.message).toBeTruthy();
    const extra = await raw("UpdateGood", DASHBOARD_DOCUMENTS.UpdateGood!, {
      id: 42,
      input: signed({ ...input, category_id: 1 }),
    });
    expect(extra.errors?.[0]?.message).toMatch(/category_id/);
    const wrongPrice = await raw("UpdateGood", DASHBOARD_DOCUMENTS.UpdateGood!, {
      id: 42,
      input: signed({ ...input, prices: [{ ...input.prices[0]!, id: 999 }] }),
    });
    expect(wrongPrice.errors?.[0]?.message).toBe("price not found");
    expect(fake.state.goods.find((g) => g.id === 42)!.name).toBe("Delta Reign");
  });

  it("ett nekat UpdateGood blir ett svenskt fel", async () => {
    seed();
    const c = await loggedIn();
    const good = (await c.allGoodsFull()).find((g) => g.id === 42)!;
    fake.state.failOn.UpdateGood = { message: "permission denied", code: "FORBIDDEN" };
    await expect(
      c.updateGood(
        42,
        encodeUpdateGoodInput(good, { name: "X", priceOre: 100, imageUrl: null }, []),
      ),
    ).rejects.toThrow("Awish-kontot saknar behörighet för den åtgärden.");
  });
});
