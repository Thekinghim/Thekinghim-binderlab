import { describe, expect, it } from "vitest";

import type { AwishPickupCode, AwishProduct } from "../awish/grpc-client";

import {
  createdCodes,
  freePackCost,
  freePackInputSchema,
  freePackOptions,
  shareText,
} from "./model";

const slot = (id: string, channel: string, good: string | null, current: number): AwishProduct => ({
  id,
  machineId: "2",
  channel,
  goodId: good ? `g-${good}` : null,
  goodName: good,
  currentInventory: current,
  capacity: 8,
});

describe("freePackOptions", () => {
  it("en rad per vara, facket med flest pack, tomma fack utan vara hoppas över", () => {
    const options = freePackOptions([
      slot("1", "A1", "Surging Sparks", 2),
      slot("2", "A2", "surging  sparks", 5),
      slot("3", "A3", "Black Bolt", 0),
      slot("4", "A4", null, 0),
    ]);
    expect(options).toEqual([
      {
        productId: "2",
        goodName: "Surging Sparks",
        key: "surging sparks",
        inMachine: 7,
        channels: "A1, A2",
      },
      { productId: "3", goodName: "Black Bolt", key: "black bolt", inMachine: 0, channels: "A3" },
    ]);
  });
});

describe("createdCodes", () => {
  const code = (id: string, productId: string, c: string): AwishPickupCode => ({
    id,
    machineId: "2",
    productId,
    code: c,
    quantity: 1,
    expiredAtMillis: null,
    expiredAt: null,
    active: true,
  });
  it("bara nya koder för facket", () => {
    const before = [code("1", "2", "AAAA")];
    const after = [
      code("1", "2", "AAAA"),
      code("2", "2", "BBBB"),
      code("3", "9", "CCCC"),
      code("4", "2", ""),
    ];
    expect(createdCodes(before, after, "2").map((c) => c.code)).toEqual(["BBBB"]);
  });
});

describe("indata och kostnad", () => {
  const base = {
    machineId: "00000000-0000-4000-8000-000000000001",
    productId: "12",
    quantity: 2,
    days: 14,
    reason: "compensation",
    recipient: "  ",
    note: "Fastnade i A3",
  };
  it("tom mottagare blir null; okända fält, för många och fel skäl nekas", () => {
    const v = freePackInputSchema.parse(base);
    expect(v.recipient).toBeNull();
    expect(v.note).toBe("Fastnade i A3");
    expect(() => freePackInputSchema.parse({ ...base, quantity: 21 })).toThrow();
    expect(() => freePackInputSchema.parse({ ...base, quantity: 0 })).toThrow();
    expect(() => freePackInputSchema.parse({ ...base, days: 365 })).toThrow();
    expect(() => freePackInputSchema.parse({ ...base, reason: "vän" })).toThrow();
    expect(() => freePackInputSchema.parse({ ...base, productId: "1; drop" })).toThrow();
    expect(() => freePackInputSchema.parse({ ...base, organizationId: "x" })).toThrow();
  });
  it("kostnad = pris × antal, null utan pris", () => {
    expect(freePackCost(4_500, 3)).toEqual({ unitCostOre: 4_500, costOre: 13_500 });
    expect(freePackCost(null, 3)).toEqual({ unitCostOre: null, costOre: null });
  });
  it("texten att skicka", () => {
    expect(
      shareText({
        codes: ["K7Q2M9XA"],
        goodName: "Surging Sparks",
        place: "Sega gubben",
        expiresOn: "2026-11-17",
      }),
    ).toBe(
      "Här är din kod för ett gratis pack Surging Sparks i automaten Sega gubben:\nK7Q2M9XA\nAnge koden på automatens skärm. Gäller till och med 17 november.",
    );
  });
});
