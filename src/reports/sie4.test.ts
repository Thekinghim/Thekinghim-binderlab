import { describe, expect, it } from "vitest";
import { DomainError } from "@/domain";
import { buildAccountantReport } from "./accountant-report";
import { decodeCp437, encodeCp437 } from "./cp437";
import {
  buildSie4Text,
  exportSie4,
  sie4Verifications,
  sieAmount,
  sieString,
  type Sie4Options,
} from "./sie4";
import { NO_TAX, agreement, ord, placement, price, sources } from "./testing/fixtures";

const NOV = { start: "2026-11-01", end: "2026-11-30" };
const ACCOUNTS: Sie4Options["ledgerAccounts"] = [
  { key: "settlement", account: "1580", name: "Fordran på kortinlösen" },
  { key: "sales", account: "3001", name: "Försäljning varor" },
  { key: "vat_out", account: "2611", name: "Utgående moms 25 %" },
  { key: "card_fees", account: "6570", name: "Bankkostnader" },
  { key: "store_commission", account: "5090", name: "Provision butik" },
  { key: "rent", account: "5010", name: "Lokalhyra" },
  { key: "store_payable", account: "2440", name: "Leverantörsskulder" },
  { key: "cogs", account: "4010", name: "Inköp varor" },
  { key: "inventory", account: "1460", name: "Lager av handelsvaror" },
];
const OPTIONS: Sie4Options = {
  company: "Binderlab Å Ä Ö AB",
  orgNumber: "559999-0000",
  ledgerAccounts: ACCOUNTS,
  fiscalYear: { start: "2026-01-01", end: "2026-12-31" },
  verificationSeries: "B",
};

function report(settings = NO_TAX) {
  return buildAccountantReport(
    sources({
      settings,
      orders: [
        ord("2026-11-01", { externalId: "1" }),
        ord("2026-11-01", { externalId: "2", amountOre: 5950 }),
        ord("2026-11-03", { externalId: "3", machineId: "m-2", amountOre: 12_900 }),
      ],
      placements: [
        placement("m-1", "s-1", "2025-01-01", null),
        placement("m-2", "s-2", "2025-01-01", null),
      ],
      prices: [price("t-a", 2000, "2025-01-01")],
      agreements: [
        agreement("s-1", "2025-01-01", null, { commissionBp: 1000, monthlyRentOre: 6200 }),
        agreement("s-2", "2025-01-01", null, { commissionBp: 1500 }),
      ],
    }),
    NOV,
  );
}

/** Läser #VER-blocken ur texten och summerar #TRANS per verifikation. */
function parseVerifications(text: string): { head: string; sum: number; rows: string[] }[] {
  const out: { head: string; sum: number; rows: string[] }[] = [];
  const lines = text.split("\r\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.startsWith("#VER")) continue;
    const v = { head: lines[i]!, sum: 0, rows: [] as string[] };
    expect(lines[i + 1]).toBe("{");
    let j = i + 2;
    for (; lines[j] !== "}"; j++) {
      const m = /^ {3}#TRANS (\d+) \{\} (-?\d+)\.(\d{2})$/.exec(lines[j]!);
      expect(m, lines[j]).not.toBeNull();
      const sign = m![2]!.startsWith("-") ? -1 : 1;
      v.sum += sign * (Math.abs(Number(m![2])) * 100 + Number(m![3]));
      v.rows.push(lines[j]!);
    }
    out.push(v);
    i = j;
  }
  return out;
}

describe("SIE-belopp och strängar", () => {
  it("kronor med punkt och två decimaler, från heltal", () => {
    expect(sieAmount(490_050)).toBe("4900.50");
    expect(sieAmount(-12)).toBe("-0.12");
    expect(sieAmount(5)).toBe("0.05");
    expect(sieAmount(0)).toBe("0.00");
    expect(sieAmount(-490_000)).toBe("-4900.00");
    expect(sieAmount(900_719_925_474_099)).toBe("9007199254740.99");
    expect(() => sieAmount(1.5)).toThrow(DomainError);
  });

  it("citattecken och bakstreck skyddas, styrtecken tas bort", () => {
    expect(sieString('Butik "Nord"')).toBe('"Butik \\"Nord\\""');
    expect(sieString("a\\b")).toBe('"a\\\\b"');
    expect(sieString("rad1\nrad2")).toBe('"rad1 rad2"');
  });
});

describe("SIE 4-filen", () => {
  const text = buildSie4Text(report(), OPTIONS);
  const lines = text.split("\r\n");

  it("huvud i rätt ordning och format", () => {
    expect(lines.slice(0, 9)).toEqual([
      "#FLAGGA 0",
      "#FORMAT PC8",
      "#SIETYP 4",
      expect.stringMatching(/^#PROGRAM "Binderlab" "\d+\.\d+\.\d+"$/),
      "#GEN 20261130",
      '#FNAMN "Binderlab Å Ä Ö AB"',
      "#ORGNR 559999-0000",
      "#RAR 0 20260101 20261231",
      "#VALUTA SEK",
    ]);
    expect(text.endsWith("\r\n")).toBe(true);
    expect(text).not.toMatch(/[^\r]\n/);
  });

  it("#KONTO för varje använt konto, sorterade", () => {
    const konton = lines.filter((l) => l.startsWith("#KONTO"));
    expect(konton).toEqual([
      '#KONTO 1460 "Lager av handelsvaror"',
      '#KONTO 1580 "Fordran på kortinlösen"',
      '#KONTO 2440 "Leverantörsskulder"',
      '#KONTO 3001 "Försäljning varor"',
      '#KONTO 4010 "Inköp varor"',
      '#KONTO 5010 "Lokalhyra"',
      '#KONTO 5090 "Provision butik"',
    ]);
  });

  it("en verifikation per försäljningsdag, butiksersättning per butik och inköpsvärde; alla balanserar", () => {
    const vers = parseVerifications(text);
    expect(vers.map((v) => v.head)).toEqual([
      '#VER "B" "1" 20261101 "Försäljning 1 nov. 2026 (2 order)"',
      '#VER "B" "2" 20261103 "Försäljning 3 nov. 2026 (1 order)"',
      '#VER "B" "3" 20261130 "Butiksersättning Mobilia november 2026"',
      '#VER "B" "4" 20261130 "Butiksersättning Nordstan november 2026"',
      '#VER "B" "5" 20261130 "Inköpsvärde sålda pack november 2026"',
    ]);
    for (const v of vers) expect(v.sum).toBe(0);
    expect(vers[0]!.rows).toEqual(["   #TRANS 1580 {} 108.50", "   #TRANS 3001 {} -108.50"]);
    expect(vers[3]!.rows).toEqual([
      "   #TRANS 5090 {} 10.85",
      "   #TRANS 5010 {} 62.00",
      "   #TRANS 2440 {} -72.85",
    ]);
    expect(vers[4]!.rows).toEqual(["   #TRANS 4010 {} 60.00", "   #TRANS 1460 {} -60.00"]);
  });

  it("moms 25 % och kortavgift: utgående moms och avgift, fortfarande balanserat", () => {
    const r = report({ vatRateBp: 2500, cardFeeBp: 250 });
    const vers = parseVerifications(buildSie4Text(r, OPTIONS));
    for (const v of vers) expect(v.sum).toBe(0);
    // 1 nov.: 4 900 + 5 950 = 10 850; moms 980 + 1 190 = 2 170; avgift 123 + 149 = 272.
    expect(vers[0]!.rows).toEqual([
      "   #TRANS 1580 {} 108.50",
      "   #TRANS 3001 {} -86.80",
      "   #TRANS 2611 {} -21.70",
      "   #TRANS 6570 {} 2.72",
      "   #TRANS 1580 {} -2.72",
    ]);
    const all = sie4Verifications(r, OPTIONS).flatMap((v) => v.transactions);
    const sales = all.filter((t) => t.account === "3001").reduce((s, t) => s + t.amountOre, 0);
    expect(-sales).toBe(r.totals.netOre);
  });

  it("utan konton för butiksersättning och inköp: bara försäljning", () => {
    const minimal = ACCOUNTS.filter((a) => a.key === "settlement" || a.key === "sales");
    const vers = sie4Verifications(report(), {
      ...OPTIONS,
      ledgerAccounts: minimal,
      firstVerificationNumber: 41,
    });
    expect(vers.map((v) => v.number)).toEqual([41, 42]);
  });

  it("fel: konto saknas, verifikation utanför räkenskapsåret, ogiltig serie", () => {
    expect(() =>
      exportSie4(report(), {
        ...OPTIONS,
        ledgerAccounts: ACCOUNTS.filter((a) => a.key !== "sales"),
      }),
    ).toThrow(/sales/);
    expect(() =>
      exportSie4(report({ vatRateBp: 2500, cardFeeBp: 0 }), {
        ...OPTIONS,
        ledgerAccounts: ACCOUNTS.filter((a) => a.key !== "vat_out"),
      }),
    ).toThrow(/vat_out/);
    expect(() =>
      exportSie4(report(), { ...OPTIONS, fiscalYear: { start: "2025-01-01", end: "2025-12-31" } }),
    ).toThrow(/räkenskapsåret/);
    expect(() => exportSie4(report(), { ...OPTIONS, verificationSeries: "A B" })).toThrow(
      DomainError,
    );
    expect(() =>
      exportSie4(report(), {
        ...OPTIONS,
        ledgerAccounts: [...ACCOUNTS, { key: "x", account: "30A1", name: "Fel" }],
      }),
    ).toThrow(/kontonummer/);
  });
});

describe("CP437-kodning", () => {
  it("svenska tecken och é får rätt byte", () => {
    expect([...encodeCp437("åäöÅÄÖé")]).toEqual([0x86, 0x84, 0x94, 0x8f, 0x8e, 0x99, 0x82]);
    expect([...encodeCp437("Aa1 #{}")]).toEqual([...Buffer.from("Aa1 #{}", "ascii")]);
  });

  it("hårda mellanslag, minustecken och tankstreck blir ASCII; okända tecken blir ?", () => {
    expect(encodeCp437("1 000−–€ø").toString("latin1")).toBe("1 000--??");
  });

  it("sammansatta tecken normaliseras (a + ring → å)", () => {
    expect([...encodeCp437("å")]).toEqual([0x86]);
  });

  it("avkodning ger tillbaka texten", () => {
    const s = "Försäljning Väla Åkersberga Östra Ängelholm café";
    expect(decodeCp437(encodeCp437(s))).toBe(s);
  });

  it("exportSie4 ger en Buffer i CP437 med svenska tecken", () => {
    const buf = exportSie4(report(), OPTIONS);
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(buf.includes(Buffer.from([0x46, 0x94, 0x72, 0x73, 0x84, 0x6c]))).toBe(true); // "Försäl"
    expect(buf.includes(Buffer.from("Försäljning", "utf8"))).toBe(false);
    expect(buf.every((b) => b !== 0xc3)).toBe(true); // ingen UTF-8
    expect(decodeCp437(buf)).toBe(buildSie4Text(report(), OPTIONS));
  });
});
