import { describe, expect, it } from "vitest";

import {
  hashSigningToken,
  isSigningToken,
  newSigningToken,
  normalizeSignerName,
  parseSignaturePng,
  SignatureInputError,
  signatureSheetFragment,
  signedAtText,
  signedDocumentHtml,
  signedFileName,
  type SignatureSheetInput,
} from "./signing-model";

/** PNG-huvud med måtten (resten behövs inte för kontrollen). */
function pngHeader(width: number, height: number, size = 200): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 73, 72, 68, 82]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}
const dataUrl = (b: Uint8Array) => `data:image/png;base64,${Buffer.from(b).toString("base64")}`;

const SHEET: SignatureSheetInput = {
  organizationName: "Binderlab AB",
  storeName: "Sega <b>gubben</b>",
  contractTitle: "Placeringsavtal",
  reference: "ABCD1234",
  signerName: 'Anna "<script>" Andersson',
  signedAt: new Date("2026-11-04T13:05:09Z"),
  timezone: "Europe/Stockholm",
  ip: "203.0.113.7",
  userAgent: "Mozilla/5.0 <img src=x onerror=alert(1)>",
  documentSha256: "a".repeat(64),
  documentName: "Placeringsavtal.pdf",
  signatureId: "11111111-2222-3333-4444-555555555555",
  signaturePng: pngHeader(60, 24),
};

describe("token", () => {
  it("är 64 hex-tecken, ny varje gång, och hashen är sha256", () => {
    const a = newSigningToken();
    const b = newSigningToken();
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    expect(a).not.toBe(b);
    expect(isSigningToken(a)).toBe(true);
    expect(isSigningToken(a.toUpperCase())).toBe(false);
    expect(isSigningToken(a.slice(1))).toBe(false);
    expect(isSigningToken(null)).toBe(false);
    expect(hashSigningToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe("signaturen", () => {
  it("tar emot en PNG med rimliga mått", () => {
    expect(parseSignaturePng(dataUrl(pngHeader(600, 180))).byteLength).toBe(200);
  });

  it.each([
    ["inte en sträng", 123],
    ["fel typ", "data:image/jpeg;base64,AAAA"],
    ["svg", "data:image/svg+xml;base64,PHN2Zz4="],
    ["inte base64", "data:image/png;base64,<<<>>>"],
    ["för liten", dataUrl(new Uint8Array(20))],
    ["inte PNG", dataUrl(new Uint8Array(200).fill(7))],
    ["för smal", dataUrl(pngHeader(10, 24))],
    ["för stor yta", dataUrl(pngHeader(9000, 24))],
    ["för många byte", `data:image/png;base64,${"A".repeat(500_000)}`],
  ])("nekar %s", (_label, value) => {
    expect(() => parseSignaturePng(value)).toThrow(SignatureInputError);
  });

  it("namnet trimmas och måste vara 2–100 tecken", () => {
    expect(normalizeSignerName("  Anna   Andersson ")).toBe("Anna Andersson");
    expect(() => normalizeSignerName("A")).toThrow(SignatureInputError);
    expect(() => normalizeSignerName("x".repeat(101))).toThrow(SignatureInputError);
    expect(() => normalizeSignerName(undefined)).toThrow(SignatureInputError);
  });
});

describe("signaturbladet", () => {
  it("visar namn, tid i organisationens tidszon, IP, webbläsare och kontrollsumma, escapat", () => {
    const html = signatureSheetFragment(SHEET);
    expect(html).toContain("Signaturblad");
    expect(html).toContain("Anna &quot;&lt;script&gt;&quot; Andersson");
    expect(html).not.toContain("<script>");
    expect(html).not.toContain("<img src=x");
    expect(html).toContain("Sega &lt;b&gt;gubben&lt;/b&gt;");
    expect(html).toContain("4 november 2026 kl. 14:05:09 (Europe/Stockholm)");
    expect(html).toContain("203.0.113.7");
    expect(html).toContain("a".repeat(64));
    expect(html).toContain("data:image/png;base64,");
  });

  it("läggs sist i avtalets HTML på en egen sida, eller blir ett eget dokument", () => {
    const contract =
      "<!doctype html><html><head><title>A</title></head><body><h1>Avtal</h1></body></html>";
    const merged = signedDocumentHtml(contract, SHEET);
    expect(merged.indexOf("<h1>Avtal</h1>")).toBeLessThan(merged.indexOf("Signaturblad"));
    expect(merged).toContain('class="bl-sig-page"');
    expect(merged.match(/<\/body>/g)).toHaveLength(1);
    const alone = signedDocumentHtml(null, SHEET);
    expect(alone).toMatch(/^<!doctype html>/);
    expect(alone).toContain("Signaturblad");
  });

  it("tiden och filnamnet", () => {
    expect(signedAtText(new Date("2026-07-01T10:00:00Z"), "Europe/Stockholm")).toBe(
      "1 juli 2026 kl. 12:00:00 (Europe/Stockholm)",
    );
    expect(signedFileName('ICA "Nära"/Väst')).toBe("Signerat avtal ICA Nära Väst.pdf");
  });
});
