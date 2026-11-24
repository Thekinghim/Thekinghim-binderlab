import { createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import {
  AWISH_SIGN_TOLERANCE_S,
  awishSignature,
  canonicalBody,
  signRequest,
  verifyAwishSignature,
  withoutSignature,
} from "./sign";

const TS = 1793352268;

describe("awishSignature: dokumentationens exempel (AW-DOC-110 8.13.1)", () => {
  it("meddelandet är timestamp + '.' + body och nyckeln är appid", () => {
    expect(awishSignature("appid123", TS, '{"amount":100}')).toBe(
      "f4e158a662d36e5feac1e5515c463486224045480649cc02b83c9962c29a06e8",
    );
    expect(awishSignature("app-test", TS, '{"amount":100}')).toBe(
      "7a1cd66d740014d139b5ab8460fd6e55e06a11a23d59931cd35d02d6893da3a2",
    );
    const manual = createHmac("sha256", "appid123")
      .update('1793352268.{"amount":100}')
      .digest("hex");
    expect(awishSignature("appid123", TS, '{"amount":100}')).toBe(manual);
  });

  it("hex med gemener, 64 tecken", () => {
    expect(awishSignature("x", 1, "{}")).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("canonicalBody", () => {
  it("ControlPower: id som tal, uppräkning som tal, utan sign och timestamp", () => {
    const body = canonicalBody(
      "PowerControlRequest",
      { method: "REBOOT", machine_id: "123", timestamp: 5, sign: "abc" },
      "present_sorted",
    );
    expect(body).toBe('{"machine_id":123,"method":1}');
    const signed = signRequest(
      "PowerControlRequest",
      { machine_id: "123", method: 1 },
      "app-test",
      { nowSeconds: TS },
    );
    expect(signed.sign).toBe("3272e02079e656b66012c80147937d9ef858f1e98971c3d2fcce018daa2bf665");
    expect(signed.timestamp).toBe(TS);
  });

  it("ReplenishProductInventory: listor av uint64 i given ordning", () => {
    const signed = signRequest(
      "ReplenishProductInventoryRequest",
      { ids: ["7", "8"], machine_id: "123" },
      "app-test",
      { nowSeconds: TS },
    );
    expect(canonicalBody("ReplenishProductInventoryRequest", signed)).toBe(
      '{"ids":[7,8],"machine_id":123}',
    );
    expect(signed.sign).toBe("7fa81097f3d5881cbf725185374ab44334fefe8fa04c4ed28643bb7050772c73");
  });

  it("nyckelordningen i indata spelar ingen roll", () => {
    const a = canonicalBody("UpdateProductRequest", {
      id: "5",
      good_id: "9",
      status: true,
      current_inventory: 4,
    });
    const b = canonicalBody("UpdateProductRequest", {
      current_inventory: 4,
      status: true,
      good_id: "9",
      id: "5",
    });
    expect(a).toBe(b);
    expect(a).toBe('{"current_inventory":4,"good_id":9,"id":5,"status":true}');
  });

  it("tar bort undefined och null; behåller false och 0 i optional-fält", () => {
    expect(
      canonicalBody("UpdateProductRequest", {
        id: "5",
        good_id: undefined,
        category_id: null,
        status: false,
        current_inventory: 0,
      }),
    ).toBe('{"current_inventory":0,"id":5,"status":false}');
  });

  it("vanliga fält med standardvärdet syns inte på tråden och räknas inte", () => {
    expect(canonicalBody("BatchUpdateProductRequest", { ids: [], machine_id: "3" })).toBe(
      '{"machine_id":3}',
    );
    expect(canonicalBody("CreateCategoryRequest", { title: "" })).toBe("{}");
  });

  it("text med å, ä, ö och kinesiska skrivs som UTF-8 utan escapes", () => {
    expect(canonicalBody("CreateCategoryRequest", { title: "Åäö 宝", is_visible: true })).toBe(
      '{"is_visible":true,"title":"Åäö 宝"}',
    );
    expect(canonicalBody("CreateCategoryRequest", { title: 'a"b\\c\n' })).toBe(
      '{"title":"a\\"b\\\\c\\n"}',
    );
  });

  it("nästlade GoodPriceRequest sorteras också", () => {
    expect(
      canonicalBody("CreateGoodRequest", {
        name: "Pack",
        description: "Ett pack",
        prices: [{ price: "79.00", currency_id: "1", id: "0", original_price: "99.00" }],
      }),
    ).toBe(
      '{"description":"Ett pack","name":"Pack","prices":[{"currency_id":1,"original_price":"99.00","price":"79.00"}]}',
    );
  });

  it("present_proto_order följer fältnumren", () => {
    expect(
      canonicalBody(
        "UpdateProductRequest",
        { status: true, id: "5", current_inventory: 2 },
        "present_proto_order",
      ),
    ).toBe('{"id":5,"status":true,"current_inventory":2}');
  });

  it("full_sorted tar med alla fält: null för optional, standardvärden annars", () => {
    expect(canonicalBody("PowerControlRequest", { machine_id: "1" }, "full_sorted")).toBe(
      '{"machine_id":1,"method":0}',
    );
    expect(canonicalBody("UpdateProductRequest", { id: "5" }, "full_sorted")).toBe(
      '{"category_id":null,"current_inventory":null,"good_id":null,"id":5,"status":null}',
    );
    expect(
      canonicalBody(
        "UpdateGoodRequest",
        { id: "1", prices: [{ price: "1.00", currency_id: "1" }] },
        "full_sorted",
      ),
    ).toContain(
      '"prices":[{"cost_price":null,"currency_id":1,"id":0,"member_price":null,"original_price":null,"price":"1.00"}]',
    );
  });

  it("stora id behåller alla siffror", () => {
    expect(canonicalBody("DeleteGoodRequest", { id: "18446744073709551615" })).toBe(
      '{"id":18446744073709551615}',
    );
  });

  it("okända fält och fel typ kastar (inget skickas)", () => {
    expect(() => canonicalBody("DeleteGoodRequest", { id: "1", extra: 1 })).toThrow(TypeError);
    expect(() => canonicalBody("DeleteGoodRequest", { id: "abc" })).toThrow(TypeError);
    expect(() => canonicalBody("UpdateProductRequest", { id: "1", status: "ja" })).toThrow(
      TypeError,
    );
  });

  it("virtuella oneof-fält från proto-loader ignoreras", () => {
    expect(
      canonicalBody("UpdateProductRequest", { id: "1", status: true, _status: "status" }),
    ).toBe('{"id":1,"status":true}');
  });
});

describe("verifyAwishSignature", () => {
  const signed = signRequest("DeleteCategoryRequest", { id: "42" }, "app-test", {
    nowSeconds: TS,
  });
  const verify = (nowSeconds: number, request = signed, toleranceS?: number | null) =>
    verifyAwishSignature({
      appId: "app-test",
      messageType: "DeleteCategoryRequest",
      request,
      mode: "present_sorted",
      nowSeconds,
      ...(toleranceS === undefined ? {} : { toleranceS }),
    });

  it("godtar 300 s men inte 301 s", () => {
    expect(AWISH_SIGN_TOLERANCE_S).toBe(300);
    expect(verify(TS)).toBe("ok");
    expect(verify(TS + 300)).toBe("ok");
    expect(verify(TS - 300)).toBe("ok");
    expect(verify(TS + 301)).toBe("out_of_window");
  });

  it("null hoppar över tidskontrollen", () => {
    expect(verify(TS + 100_000, signed, null)).toBe("ok");
  });

  it("fel nyckel, ändrad begäran och sign som inte är hex ger bad_sign", () => {
    expect(
      verifyAwishSignature({
        appId: "annan",
        messageType: "DeleteCategoryRequest",
        request: signed,
        mode: "present_sorted",
        nowSeconds: TS,
      }),
    ).toBe("bad_sign");
    expect(verify(TS, { ...signed, id: "43" })).toBe("bad_sign");
    expect(verify(TS, { ...signed, sign: "zz".repeat(32) })).toBe("bad_sign");
    expect(verify(TS, { ...signed, sign: signed.sign.toUpperCase() })).toBe("bad_sign");
  });

  it("en server i full_sorted godtar inte present_sorted när ett optional-fält saknas", () => {
    const req = signRequest("UpdateProductRequest", { id: "1", status: true }, "app-test", {
      nowSeconds: TS,
    });
    expect(
      verifyAwishSignature({
        appId: "app-test",
        messageType: "UpdateProductRequest",
        request: req,
        mode: "full_sorted",
        nowSeconds: TS,
      }),
    ).toBe("bad_sign");
  });
});

describe("withoutSignature", () => {
  it("tar bort sign och timestamp", () => {
    expect(withoutSignature({ id: "1", sign: "x", timestamp: 2 })).toEqual({ id: "1" });
  });
});

describe("dokumentationens fältnummer (10/11) i sju skrivningar", () => {
  it("timestamp och sign skickas på båda ställena; request_body räknar inte med något av dem", () => {
    const req = signRequest("UpdateProductRequest", { id: "1", current_inventory: 5 }, "app-test", {
      nowSeconds: TS,
      fields: "both",
    }) as Record<string, unknown>;
    expect(req.doc_sign).toBe(req.sign);
    expect(req.doc_timestamp).toBe(TS);
    expect(canonicalBody("UpdateProductRequest", req)).toBe('{"current_inventory":5,"id":1}');
    const proto = signRequest("UpdateProductRequest", { id: "1" }, "app-test", {
      nowSeconds: TS,
      fields: "proto",
    }) as Record<string, unknown>;
    expect("doc_sign" in proto).toBe(false);
    const doc = signRequest("UpdateProductRequest", { id: "1" }, "app-test", {
      nowSeconds: TS,
      fields: "doc",
    }) as Record<string, unknown>;
    expect("sign" in doc).toBe(false);
    expect(
      verifyAwishSignature({
        appId: "app-test",
        messageType: "UpdateProductRequest",
        request: doc,
        mode: "present_sorted",
        nowSeconds: TS,
        fields: "doc",
      }),
    ).toBe("ok");
    expect(
      verifyAwishSignature({
        appId: "app-test",
        messageType: "UpdateProductRequest",
        request: doc,
        mode: "present_sorted",
        nowSeconds: TS,
      }),
    ).toBe("missing");
  });

  it("övriga meddelanden får inga extra fält", () => {
    const req = signRequest("DeleteCategoryRequest", { id: "42" }, "app-test", {
      nowSeconds: TS,
      fields: "both",
    }) as Record<string, unknown>;
    expect(Object.keys(req).sort()).toEqual(["id", "sign", "timestamp"]);
  });

  it("withoutSignature tar bort även doc-fälten", () => {
    expect(
      withoutSignature({ id: "1", sign: "x", timestamp: 2, doc_sign: "x", doc_timestamp: 2 }),
    ).toEqual({
      id: "1",
    });
  });
});
