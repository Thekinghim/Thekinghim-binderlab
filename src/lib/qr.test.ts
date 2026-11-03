import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import { encodeQr, qrByteCapacity, qrPath, qrPenalty, qrRows } from "./qr";

// Referensmatriser från python-biblioteket qrcode 8.2 (samma text, nivå och mask).
const SHORT_M_MASK2 = [
  "111111100101001111111",
  "100000100010001000001",
  "101110101100001011101",
  "101110101100101011101",
  "101110101010101011101",
  "100000101101001000001",
  "111111101010101111111",
  "000000001010000000000",
  "101111100111001111100",
  "001011011111101001111",
  "100010110110100001000",
  "011001001011110001111",
  "111111100100100111101",
  "000000001100100010100",
  "111111100111010101110",
  "100000101010000000110",
  "101110101001000011001",
  "101110101001111100100",
  "101110101000101000000",
  "100000100001111000100",
  "111111101100100010010",
];

describe("encodeQr", () => {
  it("version 1-M stämmer med referensen", () => {
    const m = encodeQr("K7Q2-M9XA", { level: "M", mask: 2 });
    expect(m.version).toBe(1);
    expect(qrRows(m)).toEqual(SHORT_M_MASK2);
  });

  it("version 7 (versionsinformation) stämmer med referensen", () => {
    const m = encodeQr(
      "https://binderlab.se/signera/abc123def456ghi789jkl012mno345pqr678stu901-xyz",
      { level: "M", mask: 6, minVersion: 7 },
    );
    expect(m.size).toBe(45);
    const hash = createHash("sha256").update(qrRows(m).join("\n")).digest("hex");
    expect(hash).toBe("7617c312c7b5e4b75aa559ffb409f3cc8198f89b79dffcc5e2d38e57ae810abe");
  });

  it("väljer minsta version och masken med lägst straff", () => {
    const auto = encodeQr("K7Q2-M9XA");
    const scores = [0, 1, 2, 3, 4, 5, 6, 7].map((mask) =>
      qrPenalty(encodeQr("K7Q2-M9XA", { mask }).modules),
    );
    expect(auto.version).toBe(1);
    expect(qrPenalty(auto.modules)).toBe(Math.min(...scores));
  });

  it("kapacitet och för lång text", () => {
    expect(qrByteCapacity(1, "M")).toBe(14);
    expect(qrByteCapacity(10, "L")).toBe(271);
    expect(encodeQr("x".repeat(15)).version).toBe(2);
    expect(() => encodeQr("x".repeat(300), { level: "L" })).toThrow(RangeError);
  });

  it("SVG-sökvägen ritar varje mörk modul en gång", () => {
    const m = encodeQr("A");
    const path = qrPath(m, 4);
    const widths = [...path.matchAll(/h(\d+)v1/g)].reduce((n, x) => n + Number(x[1]), 0);
    const dark = m.modules.flat().filter(Boolean).length;
    expect(widths).toBe(dark);
    expect(path.startsWith("M4 4h7")).toBe(true);
  });
});
