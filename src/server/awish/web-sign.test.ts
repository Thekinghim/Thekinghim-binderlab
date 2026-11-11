import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { encodeGoodInput } from "./goods";
import {
  AWISH_WEB_APP_KEY,
  awishCanonicalJson,
  awishCheckSignature,
  awishDecode,
  awishEncode,
  awishHmacSignature,
  awishSignature,
  awishSignedBody,
  awishSignFields,
  awishSignInput,
  awishVerifyInput,
} from "./web-sign";

/**
 * Referensen är panelens egen uträkning (klassen som konstrueras med appKey),
 * återskapad rad för rad i JavaScript och körd på samma indata:
 *
 *   genSignature({email,password,timestamp}) för appKey "k" ger samma MD5 som
 *   web-sign.ts. Testet låser fast varje regel: utelämnade "" och "NULL", encodeURI
 *   (inte encodeURIComponent), sorteringen, och hur objekt och listor plattas ut.
 */

// Oberoende referensport av panelens genSignature, i testet, för att jämföra mot modulen.
function refSignature(payload: Record<string, unknown>, appKey: string): string {
  const copy: Record<string, unknown> = { ...payload };
  delete copy.sign;
  const out: string[] = [];
  const walk = (key: string, val: unknown): void => {
    if (typeof val === "object" && val !== null) {
      if (Array.isArray(val)) val.forEach((v, i) => walk(`${key}[${i}]`, v));
      else
        for (const k of Object.keys(val as Record<string, unknown>))
          walk(`${key}[${k}]`, (val as Record<string, unknown>)[k]);
      return;
    }
    const s = val === null ? "null" : String(val);
    if (s === "" || s === "NULL") return;
    out.push(`${key}=${encodeURI(s)}`);
  };
  for (const k of Object.keys(copy)) walk(k, copy[k]);
  out.sort();
  let n = encodeURI(out.join("&"));
  n = `${n}&key=${appKey}`;
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require("node:crypto").createHash("md5").update(n, "utf8").digest("hex").toUpperCase();
}

describe("awishSignature", () => {
  it("matchar en oberoende port av panelens uträkning", () => {
    const cases: Record<string, unknown>[] = [
      { email: "a@b.se", password: "hej123", timestamp: "1762250000" },
      { email: "ägg@b.se", password: "x y&z", timestamp: "1762250000" },
      { machine_id: 42, ids: [1, 2, 3], timestamp: "1762250000" },
      {
        id: 7,
        input: { good_id: 3, status: true, current_inventory: 12 },
        timestamp: "1762250000",
      },
    ];
    for (const c of cases) {
      expect(awishSignature(c as never, "k")).toBe(refSignature(c, "k"));
    }
  });

  it("tar bort sign innan uträkningen, så checkSignature stämmer", () => {
    const p = { email: "a@b.se", password: "p", timestamp: "1762250000" };
    const sign = awishSignature(p as never, AWISH_WEB_APP_KEY);
    expect(awishCheckSignature({ ...p, sign } as never, AWISH_WEB_APP_KEY)).toBe(true);
    expect(awishCheckSignature({ ...p, sign: "FEL" } as never, AWISH_WEB_APP_KEY)).toBe(false);
    expect(awishCheckSignature(p as never, AWISH_WEB_APP_KEY)).toBe(false);
  });

  it("hoppar över tomma värden och NULL", () => {
    const withEmpty = awishSignature({ a: "1", b: "", c: "NULL", timestamp: "1" } as never, "k");
    const without = awishSignature({ a: "1", timestamp: "1" } as never, "k");
    expect(withEmpty).toBe(without);
  });

  it("encodeURI, inte encodeURIComponent: & och = i värdet kodas, men / och : inte", () => {
    const s = awishSignature({ a: "x/y:z", timestamp: "1" } as never, "k");
    // x/y:z ska ge a=x/y:z (encodeURI rör inte / eller :)
    const ref = refSignature({ a: "x/y:z", timestamp: "1" }, "k");
    expect(s).toBe(ref);
  });
});

describe("awishEncode/Decode", () => {
  it("lägger till timestamp i sekunder och sign, och går att avkoda", () => {
    const enc = awishEncode(
      { email: "a@b.se", password: "p" } as never,
      AWISH_WEB_APP_KEY,
      1_762_250_123_456,
    );
    const back = awishDecode(enc);
    expect(back.email).toBe("a@b.se");
    expect(back.timestamp).toBe("1762250124"); // Math.ceil(…/1000)
    expect(typeof back.sign).toBe("string");
    expect(awishCheckSignature(back, AWISH_WEB_APP_KEY)).toBe(true);
  });

  it("behåller en redan satt timestamp", () => {
    const enc = awishEncode({ x: "1", timestamp: "999" } as never, "k", 1_762_250_123_456);
    expect(awishDecode(enc).timestamp).toBe("999");
  });
});

/**
 * Panelen 1.30.5: HMAC-SHA256 på indata (HmacSha256Signer). Vektorerna i
 * test/fixtures/awish/hmac-sign-vectors.json är uträknade utanför Binderlab (openssl och
 * Pythons hmac) på texten som panelens signerare bygger: "<timestamp>.<kanonisk JSON>".
 * De låser nyckelordning, talformat, null/tom text, å ä ö och emoji, och nyckeln.
 */
interface Vector {
  name: string;
  timestamp: number;
  input: Record<string, unknown>;
  body: string;
  sign: string;
}
const FIXTURE = JSON.parse(
  readFileSync(join(process.cwd(), "test/fixtures/awish/hmac-sign-vectors.json"), "utf8"),
) as { appKey: string; vectors: Vector[] };

describe("awish HMAC-signering av indata (panelen 1.30.5)", () => {
  it("nyckeln är panelens appKey", () => {
    expect(FIXTURE.appKey).toBe(AWISH_WEB_APP_KEY);
    expect(FIXTURE.vectors.length).toBeGreaterThanOrEqual(10);
  });

  for (const v of FIXTURE.vectors) {
    it(`vektor: ${v.name}`, () => {
      expect(awishSignedBody(v.input)).toBe(v.body);
      expect(awishHmacSignature(v.input, FIXTURE.appKey, v.timestamp)).toBe(v.sign);
    });
  }

  it("Binderlabs egen GoodInput ger exakt vektorns text och signatur", () => {
    const v = FIXTURE.vectors[0]!;
    const input = encodeGoodInput({
      name: "Pokémon Booster",
      salePriceOre: 7950,
      currencyId: 7,
      imageUrl: "https://dash.awish.vip/storage/p50v9ggY/a.png",
    });
    expect(input).toEqual(v.input);
    const signed = awishSignInput(input, AWISH_WEB_APP_KEY, v.timestamp * 1000 + 999);
    expect(signed.timestamp).toBe(v.timestamp);
    expect(signed.sign).toBe(v.sign);
    // Fälten läggs sist, som panelens { ...input, ...sign(input) }.
    expect(Object.keys(signed).slice(-2)).toEqual(["timestamp", "sign"]);
    expect({ ...signed, timestamp: undefined, sign: undefined }).toMatchObject(input);
  });

  it("timestamp är hela sekunder (avrundat nedåt) som tal, sign är 64 hex i gemener", () => {
    const f = awishSignFields({ a: 1 }, "k", 1_700_000_000_999);
    expect(f.timestamp).toBe(1_700_000_000);
    expect(typeof f.timestamp).toBe("number");
    expect(f.sign).toMatch(/^[0-9a-f]{64}$/);
  });

  it("RFC 8785: exemplet ur standarden", () => {
    const input = JSON.parse(
      String.raw`{"numbers":[333333333.33333329,1E30,4.50,2e-3,0.000000000000000000000000001],"string":"\u20ac$\u000F\u000aA'\u0042\u0022\u005c\\\"\/","literals":[null,true,false]}`,
    ) as unknown;
    expect(awishCanonicalJson(input)).toBe(
      String.raw`{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"€$\u000f\nA'B\"\\\\\"/"}`,
    );
  });

  it("undefined-fält försvinner, NaN blir null, -0 blir 0 (som JSON.stringify i panelen)", () => {
    expect(awishSignedBody({ b: undefined, a: Number.NaN, c: -0 })).toBe('{"a":null,"c":0}');
  });

  it("timestamp och sign tas bara bort på översta nivån", () => {
    expect(awishSignedBody({ a: { sign: "x", timestamp: 1 }, sign: "y", timestamp: 2 })).toBe(
      '{"a":{"sign":"x","timestamp":1}}',
    );
  });

  it("nycklarna sorteras på UTF-16-kodenheter (versaler före gemener, å efter z)", () => {
    expect(awishCanonicalJson({ å: 1, z: 2, a: 3, Z: 4, "1": 5 })).toBe(
      '{"1":5,"Z":4,"a":3,"z":2,"å":1}',
    );
  });

  it("trasig text (ensamt surrogat) nekas, som i panelen", () => {
    expect(() => awishSignedBody({ name: "\ud83c" })).toThrow();
  });

  it("annan nyckel, annan tid eller ändrat fält ger annan signatur", () => {
    const input = { good_id: 42, status: true, current_inventory: 12 };
    const base = awishHmacSignature(input, AWISH_WEB_APP_KEY, 1_794_300_000);
    expect(awishHmacSignature(input, "annan", 1_794_300_000)).not.toBe(base);
    expect(awishHmacSignature(input, AWISH_WEB_APP_KEY, 1_794_300_001)).not.toBe(base);
    expect(
      awishHmacSignature({ ...input, current_inventory: 13 }, AWISH_WEB_APP_KEY, 1_794_300_000),
    ).not.toBe(base);
  });

  it("awishVerifyInput: godkänner rätt signatur och säger varför den nekar", () => {
    const now = 1_794_300_000_000;
    const signed = awishSignInput({ good_id: 42, status: true }, AWISH_WEB_APP_KEY, now);
    expect(awishVerifyInput(signed, AWISH_WEB_APP_KEY, now)).toBeNull();
    expect(awishVerifyInput(signed, AWISH_WEB_APP_KEY, now + 299_000)).toBeNull();
    expect(awishVerifyInput(signed, AWISH_WEB_APP_KEY, now + 301_000)).toMatch(/time window/);
    expect(awishVerifyInput({ ...signed, status: false }, AWISH_WEB_APP_KEY, now)).toMatch(
      /mismatch/,
    );
    expect(awishVerifyInput(signed, "annan", now)).toMatch(/mismatch/);
    expect(awishVerifyInput({ ...signed, sign: "ABC" }, AWISH_WEB_APP_KEY, now)).toMatch(
      /hexadecimal/,
    );
    expect(awishVerifyInput({ good_id: 42 }, AWISH_WEB_APP_KEY, now)).toMatch(/timestamp/);
    expect(
      awishVerifyInput({ ...signed, timestamp: "1794300000" }, AWISH_WEB_APP_KEY, now),
    ).toMatch(/timestamp/);
  });
});
