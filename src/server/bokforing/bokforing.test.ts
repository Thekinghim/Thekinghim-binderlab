import { inflateRawSync } from "node:zlib";

import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { decodeCp437 } from "@/reports";

import type { AccountantReport } from "@/reports";

import {
  bookMonths,
  monthFiguresFromReport,
  monthResult,
  VmbVatRateError,
  type MonthFigures,
} from "./month";
import { buildMonthPackage } from "./package";
import { DEFAULT_PLAN, parseAccountPlan, PLAN_KEYS, PROPOSED_PLAN } from "./plan";
import { checkReceipt, receiptStoragePath, sniffReceipt, zipReceiptName } from "./receipts";
import { buildSieText, monthVerification } from "./sie";
import { summaryHtml } from "./summary";
import { vmbChain, vmbVat } from "./vmb";
import { assertZipName, buildZip, crc32 } from "./zip";

// ---------------------------------------------------------------------------
// Hjälp
// ---------------------------------------------------------------------------

/** Månaderna med "VMB i bokföringen" på (samma utfall som före valet). */
const bookVmb = (f: readonly MonthFigures[], opening: number) =>
  bookMonths(f, opening, new Map(), true);

function figures(month: string, over: Partial<MonthFigures> = {}): MonthFigures {
  return {
    month,
    orders: 10,
    salesInclVatOre: 100_000,
    refundsOre: 0,
    cardFeesOre: 1_500,
    purchasesOre: 40_000,
    purchaseBasis: "received_purchases",
    costOfGoodsOre: 35_000,
    receivedPurchasesOre: 40_000,
    unpricedOrders: 0,
    profitSplitUnpricedOrders: 0,
    stores: [
      {
        storeId: "s1",
        name: "Butik Ett",
        orders: 6,
        salesInclVatOre: 60_000,
        shareOre: 9_000,
        rentOre: 0,
        totalOre: 9_000,
      },
      {
        storeId: "s2",
        name: 'Butik "Två" & Co',
        orders: 4,
        salesInclVatOre: 40_000,
        shareOre: 5_000,
        rentOre: 2_000,
        totalOre: 7_000,
      },
    ],
    storeShareOre: 16_000,
    days: [{ date: `${month}-05`, orders: 10, salesInclVatOre: 100_000 }],
    ...over,
  };
}

interface ZipFile {
  name: string;
  data: Buffer;
}

/** Läser ett arkiv via centralkatalogen och kontrollerar CRC och storlekar. */
function readZip(bytes: Uint8Array): ZipFile[] {
  const b = Buffer.from(bytes);
  const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThan(0);
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out: ZipFile[] = [];
  for (let i = 0; i < count; i++) {
    expect(b.readUInt32LE(p)).toBe(0x02014b50);
    const method = b.readUInt16LE(p + 10);
    const crc = b.readUInt32LE(p + 16);
    const csize = b.readUInt32LE(p + 20);
    const size = b.readUInt32LE(p + 24);
    const nlen = b.readUInt16LE(p + 28);
    const elen = b.readUInt16LE(p + 30);
    const clen = b.readUInt16LE(p + 32);
    const off = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nlen).toString("utf8");
    expect(b.readUInt32LE(off)).toBe(0x04034b50);
    const lnlen = b.readUInt16LE(off + 26);
    const lelen = b.readUInt16LE(off + 28);
    const body = b.subarray(off + 30 + lnlen + lelen, off + 30 + lnlen + lelen + csize);
    const data = method === 8 ? inflateRawSync(body) : Buffer.from(body);
    expect(data.length).toBe(size);
    expect(crc32(data)).toBe(crc);
    out.push({ name, data });
    p += 46 + nlen + elen + clen;
  }
  return out;
}

/** Tolkar SIE-texten enligt SIE 4: poster, #VER-block med #TRANS, balans per verifikation. */
function parseSie(text: string) {
  expect(text.endsWith("\r\n")).toBe(true);
  const lines = text.split("\r\n").slice(0, -1);
  expect(lines.every((l) => !l.includes("\n") && !l.includes("\r"))).toBe(true);
  expect(lines[0]).toBe("#FLAGGA 0");
  const labels = lines.filter((l) => l.startsWith("#")).map((l) => l.split(" ")[0]);
  for (const required of [
    "#FORMAT",
    "#SIETYP",
    "#PROGRAM",
    "#GEN",
    "#FNAMN",
    "#RAR",
    "#KONTO",
    "#VER",
  ]) {
    expect(labels).toContain(required);
  }
  const konton = new Set(lines.filter((l) => l.startsWith("#KONTO ")).map((l) => l.split(" ")[1]!));
  const vers: { head: string; trans: { account: string; ore: number; date: string }[] }[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i]!;
    if (!l.startsWith("#VER ")) continue;
    expect(lines[i + 1]).toBe("{");
    const trans = [];
    let j = i + 2;
    for (; lines[j] !== "}"; j++) {
      const m = /^ {3}#TRANS (\d{4}) \{\} (-?\d+\.\d{2}) (\d{8}) "(?:[^"\\]|\\.)*"$/.exec(
        lines[j]!,
      );
      expect(m, lines[j]).not.toBeNull();
      const [whole, frac] = m![2]!.replace("-", "").split(".");
      const ore = (Number(whole) * 100 + Number(frac)) * (m![2]!.startsWith("-") ? -1 : 1);
      expect(konton.has(m![1]!)).toBe(true);
      trans.push({ account: m![1]!, ore, date: m![3]! });
    }
    vers.push({ head: l, trans });
    i = j;
  }
  return { lines, vers, konton };
}

// ---------------------------------------------------------------------------
// VMB
// ---------------------------------------------------------------------------

describe("VMB (samlad beräkning per månad)", () => {
  it("moms = 20 % av en positiv marginal, underlaget = marginal − moms", () => {
    const r = vmbVat({ salesInclVatOre: 100_000, purchasesOre: 40_000, carryInOre: 0 });
    expect(r).toMatchObject({ marginOre: 60_000, vatOre: 12_000, baseOre: 48_000, carryOutOre: 0 });
  });

  it("avrundar till hela ören, halva öre bort från noll", () => {
    // 20 % av 1 öre = 0,2 → 0; av 3 öre = 0,6 → 1; av 5 öre = 1 exakt; av 7 = 1,4 → 1; 12 495 × 0,2 = 2 499
    expect(vmbVat({ salesInclVatOre: 1, purchasesOre: 0, carryInOre: 0 }).vatOre).toBe(0);
    expect(vmbVat({ salesInclVatOre: 3, purchasesOre: 0, carryInOre: 0 }).vatOre).toBe(1);
    expect(vmbVat({ salesInclVatOre: 7, purchasesOre: 0, carryInOre: 0 }).vatOre).toBe(1);
    // 0,5 öre avrundas upp: 20 % av 2,5 finns inte i heltal; 20 % av 12 = 2,4 → 2; av 13 = 2,6 → 3
    expect(vmbVat({ salesInclVatOre: 12, purchasesOre: 0, carryInOre: 0 }).vatOre).toBe(2);
    expect(vmbVat({ salesInclVatOre: 13, purchasesOre: 0, carryInOre: 0 }).vatOre).toBe(3);
    const r = vmbVat({ salesInclVatOre: 12_345_67, purchasesOre: 2_345_00, carryInOre: 0 });
    expect(r.vatOre + r.baseOre).toBe(r.marginOre);
  });

  it("negativ marginal ger ingen moms och ett underskott som förs vidare", () => {
    const r = vmbVat({ salesInclVatOre: 10_000, purchasesOre: 30_000, carryInOre: 5_000 });
    expect(r).toMatchObject({ marginOre: -25_000, vatOre: 0, baseOre: 0, carryOutOre: 25_000 });
    const zero = vmbVat({ salesInclVatOre: 10_000, purchasesOre: 10_000, carryInOre: 0 });
    expect(Object.is(zero.carryOutOre, -0)).toBe(false);
    expect(zero).toMatchObject({ vatOre: 0, carryOutOre: 0 });
  });

  it("kedjan för underskottet vidare månad för månad tills det är förbrukat", () => {
    const chain = vmbChain(
      [
        { month: "2026-08", salesInclVatOre: 50_000, purchasesOre: 80_000 },
        { month: "2026-09", salesInclVatOre: 20_000, purchasesOre: 0 },
        { month: "2026-10", salesInclVatOre: 30_000, purchasesOre: 0 },
      ],
      1_000,
    );
    expect(chain.get("2026-08")).toMatchObject({
      carryInOre: 1_000,
      vatOre: 0,
      carryOutOre: 31_000,
    });
    expect(chain.get("2026-09")).toMatchObject({
      carryInOre: 31_000,
      vatOre: 0,
      carryOutOre: 11_000,
    });
    expect(chain.get("2026-10")).toMatchObject({
      carryInOre: 11_000,
      marginOre: 19_000,
      vatOre: 3_800,
      carryOutOre: 0,
    });
  });

  it("en skickad månads underskott gäller för nästa månad", () => {
    const chain = vmbChain([
      { month: "2026-09", salesInclVatOre: 0, purchasesOre: 10_000, fixedCarryOutOre: 4_000 },
      { month: "2026-10", salesInclVatOre: 10_000, purchasesOre: 0 },
    ]);
    expect(chain.get("2026-10")!.carryInOre).toBe(4_000);
  });

  it("nekar inköp och underskott som är negativa eller inte heltal", () => {
    expect(() => vmbVat({ salesInclVatOre: 1, purchasesOre: -1, carryInOre: 0 })).toThrow();
    expect(() => vmbVat({ salesInclVatOre: 1, purchasesOre: 0, carryInOre: -1 })).toThrow();
    expect(() => vmbVat({ salesInclVatOre: 1.5, purchasesOre: 0, carryInOre: 0 })).toThrow();
  });

  it("resultat = försäljning − moms − inköp − kortavgifter − butikernas andel", () => {
    const [b] = bookVmb([figures("2026-10")], 0);
    expect(b!.vmb.vatOre).toBe(12_000);
    expect(b!.resultOre).toBe(100_000 - 12_000 - 40_000 - 1_500 - 16_000);
    expect(monthResult(b!, b!.vmb.vatOre)).toBe(b!.resultOre);
  });
});

// ---------------------------------------------------------------------------
// Kontoplan
// ---------------------------------------------------------------------------

describe("kontoplan", () => {
  it("förslaget är fyrsiffriga BAS-konton och saknade värden blir förslaget", () => {
    for (const k of PLAN_KEYS) expect(PROPOSED_PLAN[k].account).toMatch(/^[1-8]\d{3}$/);
    expect(parseAccountPlan(null)).toEqual(DEFAULT_PLAN);
    const p = parseAccountPlan({ sales_vmb: "3212", vat_vmb: 2611, card_fees: "x", rent: "99" });
    expect(p.sales_vmb).toBe("3212");
    expect(p.vat_vmb).toBe("2611");
    expect(p.card_fees).toBe(DEFAULT_PLAN.card_fees);
    expect(p.rent).toBe(DEFAULT_PLAN.rent);
  });
});

// ---------------------------------------------------------------------------
// SIE 4
// ---------------------------------------------------------------------------

describe("SIE 4", () => {
  const [book] = bookVmb([figures("2026-10")], 0);
  const ver = monthVerification(book!, DEFAULT_PLAN, "A", 10);
  const text = buildSieText({
    company: "Binderlab AB",
    orgNumber: "559000-1234",
    fiscalYear: { start: "2026-01-01", end: "2026-12-31" },
    plan: DEFAULT_PLAN,
    verifications: [ver],
    generatedOn: "2026-11-03",
  });

  it("verifikationen balanserar och konterar VMB, kortavgifter och butikernas andel", () => {
    expect(ver.rows.reduce((s, r) => s + r.amountOre, 0)).toBe(0);
    const by = (acc: string) =>
      ver.rows.filter((r) => r.account === acc).reduce((s, r) => s + r.amountOre, 0);
    expect(by("1580")).toBe(100_000 - 1_500);
    expect(by("3211")).toBe(-(100_000 - 12_000));
    expect(by("2616")).toBe(-12_000);
    expect(by("6040")).toBe(1_500);
    expect(by("6090")).toBe(14_000);
    expect(by("5010")).toBe(2_000);
    expect(by("2990")).toBe(-16_000);
    expect(ver.date).toBe("2026-10-31");
  });

  it("filen följer SIE 4: rubriker, #KONTO för varje använt konto, #VER/#TRANS i balans", () => {
    const { lines, vers, konton } = parseSie(text);
    expect(lines).toContain("#FORMAT PC8");
    expect(lines).toContain("#SIETYP 4");
    expect(lines).toContain("#GEN 20261103");
    expect(lines).toContain("#ORGNR 559000-1234");
    expect(lines).toContain("#RAR 0 20260101 20261231");
    expect(vers).toHaveLength(1);
    expect(vers[0]!.head).toBe('#VER "A" "10" 20261031 "Binderlab oktober 2026"');
    expect(vers[0]!.trans.reduce((s, t) => s + t.ore, 0)).toBe(0);
    expect(vers[0]!.trans.every((t) => t.date === "20261031")).toBe(true);
    expect([...konton].sort()).toEqual([...new Set(ver.rows.map((r) => r.account))].sort());
    // Citattecken skyddas
    expect(text).toContain('"Andel Butik \\"Två\\" & Co"');
  });

  it("noll VMB-moms ger ingen momsrad, och en negativ butiksandel byter sida", () => {
    const [b] = bookVmb(
      [
        figures("2026-10", {
          purchasesOre: 200_000,
          cardFeesOre: 0,
          stores: [
            {
              storeId: "s1",
              name: "Butik",
              orders: 1,
              salesInclVatOre: 100_000,
              shareOre: -3_000,
              rentOre: 0,
              totalOre: -3_000,
            },
          ],
          storeShareOre: -3_000,
        }),
      ],
      0,
    );
    const v = monthVerification(b!, DEFAULT_PLAN, "A", 1);
    expect(v.rows.some((r) => r.account === "2616")).toBe(false);
    expect(v.rows.find((r) => r.key === "store_share")!.amountOre).toBe(-3_000);
    expect(v.rows.find((r) => r.key === "store_payable")!.amountOre).toBe(3_000);
    expect(b!.vmb.carryOutOre).toBe(100_000);
  });

  it("nekar en verifikation utanför räkenskapsåret och ogiltig serie", () => {
    expect(() =>
      buildSieText({
        company: "X",
        orgNumber: null,
        fiscalYear: { start: "2025-01-01", end: "2025-12-31" },
        plan: DEFAULT_PLAN,
        verifications: [ver],
        generatedOn: "2026-11-03",
      }),
    ).toThrow(/räkenskapsåret/);
    expect(() => monthVerification(book!, DEFAULT_PLAN, "a b", 1)).toThrow();
  });

  it("kodas i CP437 och avkodas till samma text", async () => {
    const pkg = await buildMonthPackage({
      company: "Binderlab AB",
      orgNumber: null,
      book: book!,
      plan: DEFAULT_PLAN,
      series: "A",
      number: 10,
      fiscalYear: { start: "2026-01-01", end: "2026-12-31" },
      generatedOn: "2026-11-03",
      sentOn: null,
      receipts: [],
      renderPdf: null,
    });
    const sie = readZip(pkg.bytes).find((f) => f.name === "verifikation-2026-10.si")!;
    expect(sie.data.includes(0x86)).toBe(true); // å i CP437
    expect(decodeCp437(new Uint8Array(sie.data))).toContain('#FNAMN "Binderlab AB"');
  });
});

// ---------------------------------------------------------------------------
// Kvitton
// ---------------------------------------------------------------------------

describe("kvitton", () => {
  const pdf = new TextEncoder().encode("%PDF-1.4\n%test\n");
  const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]);
  const jpg = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0]);
  const heic = new Uint8Array([0, 0, 0, 0x18, ...new TextEncoder().encode("ftypheic"), 0, 0]);

  it("typen avgörs av innehållet", () => {
    expect(sniffReceipt(pdf)).toBe("application/pdf");
    expect(sniffReceipt(png)).toBe("image/png");
    expect(sniffReceipt(jpg)).toBe("image/jpeg");
    expect(sniffReceipt(heic)).toBe("image/heic");
    expect(sniffReceipt(new TextEncoder().encode("<html>"))).toBeNull();
  });

  it("nekar tomma, för stora och okända filer", () => {
    expect(checkReceipt(new Uint8Array())).toMatchObject({ ok: false });
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    big.set([0x25, 0x50, 0x44, 0x46, 0x2d]);
    expect(checkReceipt(big)).toMatchObject({ ok: false, error: expect.stringMatching(/10 MB/) });
    expect(checkReceipt(new TextEncoder().encode("MZ"))).toMatchObject({ ok: false });
    expect(checkReceipt(pdf)).toEqual({ ok: true, contentType: "application/pdf" });
  });

  it("sökvägen är organisation/månad/sha.ext och filnamnen i arkivet är säkra", () => {
    const org = "11111111-2222-3333-4444-555555555555";
    expect(receiptStoragePath(org, "2026-10", "a".repeat(64), "image/heic")).toBe(
      `${org}/2026-10/${"a".repeat(64)}.heic`,
    );
    expect(() => receiptStoragePath(org, "2026-13", "a".repeat(64), "image/png")).toThrow();
    expect(zipReceiptName(3, "../Kvitto Åhléns 2026.JPG", "image/jpeg")).toBe(
      "003-Kvitto-Ahlens-2026.jpg",
    );
    expect(zipReceiptName(1, "...", "application/pdf")).toBe("001-kvitto.pdf");
  });
});

// ---------------------------------------------------------------------------
// ZIP och månadspaketet
// ---------------------------------------------------------------------------

describe("zip", () => {
  it("skriver ett arkiv som går att läsa tillbaka (deflate och lagrat)", () => {
    const text = new TextEncoder().encode("hej ".repeat(500));
    const random = new Uint8Array(256).map((_, i) => (i * 97 + 13) % 256);
    const z = buildZip(
      [
        { name: "a.txt", data: text },
        { name: "mapp/b.bin", data: random },
        { name: "tom.txt", data: new Uint8Array() },
      ],
      new Date("2026-10-31T12:00:00Z"),
    );
    const files = readZip(z);
    expect(files.map((f) => f.name)).toEqual(["a.txt", "mapp/b.bin", "tom.txt"]);
    expect(files[0]!.data.toString()).toBe("hej ".repeat(500));
    expect(new Uint8Array(files[1]!.data)).toEqual(random);
    // Deterministiskt
    expect(buildZip([{ name: "a.txt", data: text }], new Date("2026-10-31T12:00:00Z"))).toEqual(
      buildZip([{ name: "a.txt", data: text }], new Date("2026-10-31T12:00:00Z")),
    );
  });

  it("nekar farliga namn och dubbletter", () => {
    for (const bad of ["../x", "/abs", "a//b", "a\\b", "", "./a"]) {
      expect(() => assertZipName(bad)).toThrow();
    }
    expect(() =>
      buildZip(
        [
          { name: "a", data: new Uint8Array() },
          { name: "a", data: new Uint8Array() },
        ],
        new Date(),
      ),
    ).toThrow();
  });

  it("CRC-32 stämmer med kända värden", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
  });
});

describe("månadspaketet", () => {
  const [, book] = bookVmb(
    [figures("2026-09", { salesInclVatOre: 10_000, purchasesOre: 50_000 }), figures("2026-10")],
    0,
  );
  const receipt = (name: string, data: Uint8Array, contentType: string) => ({
    fileName: name,
    contentType,
    sizeBytes: data.byteLength,
    sha256: "f".repeat(64),
    uploadedOn: "2026-10-20",
    data,
  });
  const pdfBytes = new TextEncoder().encode("%PDF-1.4 kvitto");
  const pngBytes = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

  it("förteckningen gör inte ett uppladdat filnamn till en Excel-formel", async () => {
    const pkg = await buildMonthPackage({
      company: "Binderlab AB",
      orgNumber: null,
      book: book!,
      plan: DEFAULT_PLAN,
      series: "A",
      number: 10,
      fiscalYear: { start: "2026-01-01", end: "2026-12-31" },
      generatedOn: "2026-11-03",
      sentOn: null,
      receipts: [receipt('=HYPERLINK("http://x")', pdfBytes, "application/pdf")],
      renderPdf: null,
    });
    const index = readZip(pkg.bytes)
      .find((f) => f.name === "kvitton/index.csv")!
      .data.toString("utf8");
    expect(index).toContain(`;"'=HYPERLINK(""http://x"")";`);
  });

  it("innehåller SIE, sammanfattning, Excel, kvitton med förteckning och läs mig", async () => {
    const pkg = await buildMonthPackage({
      company: "Binderlab AB",
      orgNumber: "559000-1234",
      book: book!,
      plan: DEFAULT_PLAN,
      series: "A",
      number: 10,
      fiscalYear: { start: "2026-01-01", end: "2026-12-31" },
      generatedOn: "2026-11-03",
      sentOn: null,
      receipts: [
        receipt("Inköp; Dragon Shield.pdf", pdfBytes, "application/pdf"),
        receipt("IMG_0001.PNG", pngBytes, "image/png"),
      ],
      renderPdf: async () => new TextEncoder().encode("%PDF-1.7 sammanfattning"),
    });
    expect(pkg.fileName).toBe("bokforing-2026-10.zip");
    expect(pkg.pdf).toBe(true);
    const files = readZip(pkg.bytes);
    expect(files.map((f) => f.name)).toEqual([
      "verifikation-2026-10.si",
      "sammanfattning-2026-10.pdf",
      "rader-2026-10.xlsx",
      "kvitton/001-Inkop-Dragon-Shield.pdf",
      "kvitton/002-IMG_0001.png",
      "kvitton/index.csv",
      "LAS-MIG.txt",
    ]);
    const get = (n: string) => files.find((f) => f.name === n)!.data;
    expect(new Uint8Array(get("kvitton/001-Inkop-Dragon-Shield.pdf"))).toEqual(pdfBytes);
    expect(new Uint8Array(get("kvitton/002-IMG_0001.png"))).toEqual(pngBytes);
    const index = get("kvitton/index.csv").toString("utf8");
    expect(index).toContain(
      'kvitton/001-Inkop-Dragon-Shield.pdf;"Inköp; Dragon Shield.pdf";2026-10-20',
    );
    expect(get("LAS-MIG.txt").toString("utf8")).toContain("Bokföring → Importera SIE");

    // Underskottet från september minskar oktobers marginal.
    expect(book!.vmb.carryInOre).toBe(40_000);
    expect(book!.vmb.vatOre).toBe(4_000);
    const sie = decodeCp437(new Uint8Array(get("verifikation-2026-10.si")));
    expect(sie).toContain('#TRANS 2616 {} -40.00 20261031 "VMB-moms oktober 2026"');

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(get("rader-2026-10.xlsx") as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual([
      "Verifikation",
      "Butiker",
      "Dagar",
      "Kvitton",
    ]);
    expect(wb.getWorksheet("Verifikation")!.rowCount).toBe(1 + pkg.verification.rows.length);
    expect(wb.getWorksheet("Kvitton")!.rowCount).toBe(3);
  });

  it("utan PDF (eller om utskriften misslyckas) läggs sammanfattningen som HTML", async () => {
    const base = {
      company: "Binderlab AB",
      orgNumber: null,
      book: book!,
      plan: DEFAULT_PLAN,
      series: "A",
      number: 10,
      fiscalYear: { start: "2026-01-01", end: "2026-12-31" },
      generatedOn: "2026-11-03",
      sentOn: "2026-11-03",
      receipts: [],
    };
    const off = await buildMonthPackage({ ...base, renderPdf: null });
    const failed = await buildMonthPackage({
      ...base,
      renderPdf: async () => {
        throw new Error("ingen Chromium");
      },
    });
    for (const p of [off, failed]) {
      expect(p.pdf).toBe(false);
      expect(p.entries).toContain("sammanfattning-2026-10.html");
    }
  });
});

describe("preliminärt paket", () => {
  it("har en rad om varför i läs mig och preliminar i filnamnet", async () => {
    const [book] = bookVmb([figures("2026-10")], 0);
    const base = {
      company: "Binderlab AB",
      orgNumber: null,
      book: book!,
      plan: DEFAULT_PLAN,
      series: "A",
      number: 10,
      fiscalYear: { start: "2026-01-01", end: "2026-12-31" },
      generatedOn: "2026-11-03",
      sentOn: null,
      receipts: [],
      renderPdf: null,
    };
    const final = await buildMonthPackage(base);
    const prel = await buildMonthPackage({
      ...base,
      preliminary: "3 order saknar inköpspris, så butikens andel är inte klar.",
    });
    expect(final.fileName).toBe("bokforing-2026-10.zip");
    expect(prel.fileName).toBe("bokforing-2026-10-preliminar.zip");
    const readme = (p: typeof prel) =>
      readZip(p.bytes)
        .find((f) => f.name === "LAS-MIG.txt")!
        .data.toString("utf8");
    expect(readme(final)).not.toContain("PRELIMINÄR");
    expect(readme(prel).split("\r\n")[1]).toBe(
      "PRELIMINÄR: 3 order saknar inköpspris, så butikens andel är inte klar. Bokför inte förrän ett nytt paket finns.",
    );
  });
});

describe("sammanfattningen", () => {
  it("visar VMB steg för steg, butikerna och verifikationen, och skyddar texten", () => {
    const [b] = bookVmb([figures("2026-10")], 2_500);
    const v = monthVerification(b!, DEFAULT_PLAN, "A", 10);
    const html = summaryHtml({
      company: "Binderlab <AB>",
      orgNumber: null,
      book: b!,
      verification: v,
      accountNames: new Map([["2616", "Utgående moms VMB 25 %"]]),
      receipts: 2,
      generatedOn: "2026-11-03",
      sentOn: null,
    });
    expect(html).toContain("Binderlab &lt;AB&gt;");
    expect(html).toContain("Butik &quot;Två&quot; &amp; Co");
    expect(html).toContain("= Marginal");
    expect(html).toContain("− Underskott från förra månaden");
    expect(html).toContain("20 % av marginalen");
    expect(html).toContain("kontrolleras av Talenom");
    expect(html).not.toMatch(/<script/i);
  });
});

describe("granskning: återbetalningar, tomma månader, momssats", () => {
  it("återbetalningar dras från försäljningen i VMB, verifikationen och resultatet", () => {
    const [b] = bookVmb([figures("2026-10", { refundsOre: 5_000 })], 0);
    // Marginal = 100 000 − 5 000 − 40 000 = 55 000 → moms 11 000.
    expect(b!.vmb).toMatchObject({ salesInclVatOre: 95_000, marginOre: 55_000, vatOre: 11_000 });
    expect(b!.resultOre).toBe(95_000 - 11_000 - 40_000 - 1_500 - 16_000);
    const v = monthVerification(b!, DEFAULT_PLAN, "BL", 10);
    const by = (acc: string) =>
      v.rows.filter((r) => r.account === acc).reduce((s, r) => s + r.amountOre, 0);
    expect(by("1580")).toBe(95_000 - 1_500);
    expect(by("3211")).toBe(-(95_000 - 11_000));
    expect(by("2616")).toBe(-11_000);
    const html = summaryHtml({
      company: "Binderlab AB",
      orgNumber: null,
      book: b!,
      verification: v,
      accountNames: new Map(),
      receipts: 0,
      generatedOn: "2026-11-03",
      sentOn: null,
    });
    expect(html).toContain("− Återbetalningar till kunder");
    // Avdragna belopp visas utan minustecken efter "− ".
    expect(html).toMatch(/− Inköp \([^)]*\)<\/td><td class="n">400,00/);
    expect(html).not.toMatch(/<td>− [^<]*<\/td><td class="n">[−-]/);
    expect(html).toContain("Ingående moms på butikernas fakturor bokförs från fakturan");
  });

  it("en månad utan transaktioner ger ingen tom #VER och ingen SIE-fil i paketet", async () => {
    const [b] = bookVmb(
      [
        figures("2026-10", {
          orders: 0,
          salesInclVatOre: 0,
          cardFeesOre: 0,
          purchasesOre: 0,
          stores: [],
          storeShareOre: 0,
          days: [],
        }),
      ],
      0,
    );
    const v = monthVerification(b!, DEFAULT_PLAN, "BL", 10);
    expect(v.rows).toEqual([]);
    const text = buildSieText({
      company: "Binderlab AB",
      orgNumber: null,
      fiscalYear: { start: "2026-01-01", end: "2026-12-31" },
      plan: DEFAULT_PLAN,
      verifications: [v],
      generatedOn: "2026-11-03",
    });
    expect(text).not.toContain("#VER");
    const pkg = await buildMonthPackage({
      company: "Binderlab AB",
      orgNumber: null,
      book: b!,
      plan: DEFAULT_PLAN,
      series: "BL",
      number: 10,
      fiscalYear: { start: "2026-01-01", end: "2026-12-31" },
      generatedOn: "2026-11-03",
      sentOn: null,
      receipts: [],
      renderPdf: null,
    });
    expect(pkg.entries.some((e) => e.startsWith("verifikation-"))).toBe(false);
    const readme = readZip(pkg.bytes)
      .find((f) => f.name === "LAS-MIG.txt")!
      .data.toString();
    expect(readme).toContain("Ingen verifikation");
  });

  it("ofärdig vinstdelning syns i sammanfattningen", () => {
    const [b] = bookVmb([figures("2026-10", { profitSplitUnpricedOrders: 3 })], 0);
    const html = summaryHtml({
      company: "Binderlab AB",
      orgNumber: null,
      book: b!,
      verification: monthVerification(b!, DEFAULT_PLAN, "BL", 10),
      accountNames: new Map(),
      receipts: 0,
      generatedOn: "2026-11-03",
      sentOn: null,
    });
    expect(html).toContain("Butikernas andel är inte färdigräknad: 3 order");
  });

  it("bokföringen nekas när momssatsen i Inställningar inte är 0", () => {
    const report = {
      vatRateBp: 2_500,
      totals: { grossOre: 0, feesOre: 0, costOre: 0, unpricedOrders: 0, orders: 0 },
      stores: [],
      days: [],
    } as unknown as AccountantReport;
    expect(() => monthFiguresFromReport("2026-10", report, 0, "received_purchases")).toThrow(
      VmbVatRateError,
    );
    const ok = monthFiguresFromReport(
      "2026-10",
      { ...report, vatRateBp: 0, profitSplitUnpricedOrders: 2 } as AccountantReport,
      0,
      "received_purchases",
      1_000,
    );
    expect(ok).toMatchObject({ refundsOre: 1_000, profitSplitUnpricedOrders: 2 });
  });
});

describe('"VMB i bokföringen" (standard av)', () => {
  const sie = (b: Parameters<typeof monthVerification>[0]) =>
    buildSieText({
      company: "Binderlab AB",
      orgNumber: null,
      fiscalYear: { start: "2026-01-01", end: "2026-12-31" },
      plan: DEFAULT_PLAN,
      verifications: [monthVerification(b, DEFAULT_PLAN, "BL", 10)],
      generatedOn: "2026-11-03",
    });

  it("av som standard: ingen VMB-moms, inga VMB-rader och resultatet utan VMB", () => {
    const [b] = bookMonths([figures("2026-10")], 0);
    expect(b!.vmbEnabled).toBe(false);
    expect(b!.vmb).toMatchObject({ vatOre: 0, carryInOre: 0, carryOutOre: 0, marginOre: 60_000 });
    expect(b!.resultOre).toBe(100_000 - 40_000 - 1_500 - 16_000);
    const v = monthVerification(b!, DEFAULT_PLAN, "BL", 10);
    expect(v.rows.reduce((s, r) => s + r.amountOre, 0)).toBe(0);
    expect(v.rows.some((r) => r.key === "vat_vmb" || r.key === "sales_vmb")).toBe(false);
    const by = (acc: string) =>
      v.rows.filter((r) => r.account === acc).reduce((s, r) => s + r.amountOre, 0);
    expect(by("3000")).toBe(-100_000);
    expect(by("2616")).toBe(0);
    expect(by("3211")).toBe(0);
    expect(by("1580")).toBe(100_000 - 1_500);
    const text = sie(b!);
    expect(text).not.toContain("2616");
    expect(text).not.toContain("3211");
    expect(text).toContain('#KONTO 3000 "Försäljning inom Sverige"');
  });

  it("på ger exakt samma verifikation och resultat som före valet", () => {
    const [on] = bookMonths([figures("2026-10")], 0, new Map(), true);
    const [old] = bookVmb([figures("2026-10")], 0);
    expect(on).toEqual(old);
    expect(on!.vmbEnabled).toBe(true);
    expect(on!.vmb.vatOre).toBe(12_000);
    const rows = monthVerification(on!, DEFAULT_PLAN, "BL", 10).rows;
    expect(rows.map((r) => [r.account, r.amountOre])).toEqual([
      ["1580", 100_000],
      ["3211", -88_000],
      ["2616", -12_000],
      ["6040", 1_500],
      ["1580", -1_500],
      ["6090", 9_000],
      ["2990", -9_000],
      ["6090", 5_000],
      ["5010", 2_000],
      ["2990", -7_000],
    ]);
    expect(sie(on!)).not.toContain("#KONTO 3000");
  });

  it("en månad utan VMB för inget underskott vidare; skickade månader behåller sitt val", () => {
    const f = [
      figures("2026-08", { salesInclVatOre: 10_000, purchasesOre: 50_000 }),
      figures("2026-09", { salesInclVatOre: 10_000, purchasesOre: 50_000 }),
      figures("2026-10"),
    ];
    // Augusti skickad med VMB (underskott 40 000), september av, oktober på.
    const [aug, sep, oct] = bookMonths(
      f,
      0,
      new Map([["2026-08", 40_000]]),
      (m) => m !== "2026-09",
    );
    expect(aug!.vmb).toMatchObject({ vatOre: 0, carryOutOre: 40_000 });
    expect(sep!.vmbEnabled).toBe(false);
    expect(sep!.vmb).toMatchObject({ vatOre: 0, carryInOre: 0, carryOutOre: 0 });
    expect(oct!.vmb).toMatchObject({ carryInOre: 0, vatOre: 12_000 });
    // Alla på: septembers underskott förs till oktober.
    const [, , octOn] = bookMonths(f, 0, new Map([["2026-08", 40_000]]), true);
    expect(octOn!.vmb.carryInOre).toBe(80_000);
  });

  it("sammanfattningen och läs mig säger om VMB tillämpades", async () => {
    const [off] = bookMonths([figures("2026-10")], 0);
    const [on] = bookVmb([figures("2026-10")], 0);
    const html = (b: typeof off) =>
      summaryHtml({
        company: "Binderlab AB",
        orgNumber: null,
        book: b!,
        verification: monthVerification(b!, DEFAULT_PLAN, "BL", 10),
        accountNames: new Map(),
        receipts: 0,
        generatedOn: "2026-11-03",
        sentOn: null,
      });
    expect(html(off)).toContain("· utan VMB ·");
    expect(html(off)).not.toContain("VMB-moms (samlad beräkning)");
    expect(html(off)).not.toContain("− VMB-moms");
    expect(html(off)).not.toContain("Underskott");
    expect(html(on)).toContain("· med VMB ·");
    expect(html(on)).toContain("VMB-moms (samlad beräkning)");
    const pkg = await buildMonthPackage({
      company: "Binderlab AB",
      orgNumber: null,
      book: off!,
      plan: DEFAULT_PLAN,
      series: "BL",
      number: 10,
      fiscalYear: { start: "2026-01-01", end: "2026-12-31" },
      generatedOn: "2026-11-03",
      sentOn: null,
      receipts: [],
      renderPdf: null,
    });
    expect(pkg.verification.rows.some((r) => r.key === "vat_vmb")).toBe(false);
  });

  it("momssats 0 krävs även utan VMB (annars blir momsen försäljning i SIE-filen)", () => {
    const report = {
      vatRateBp: 2_500,
      totals: { grossOre: 0, feesOre: 0, costOre: 0, unpricedOrders: 0, orders: 0 },
      stores: [],
      days: [],
    } as unknown as AccountantReport;
    expect(() => monthFiguresFromReport("2026-10", report, 0, "received_purchases", 0)).toThrow(
      VmbVatRateError,
    );
  });
});
