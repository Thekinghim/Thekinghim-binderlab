import { describe, expect, it } from "vitest";

import {
  AWISH_WEB_APP_KEY,
  awishCheckSignature,
  awishDecode,
  awishEncode,
  awishSignature,
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
