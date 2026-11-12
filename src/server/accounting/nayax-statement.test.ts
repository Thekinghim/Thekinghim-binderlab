import { describe, expect, it } from "vitest";

import {
  NayaxStatementError,
  nayaxReference,
  nayaxSourceHash,
  parseNayaxDate,
  parseNayaxMoney,
  parseNayaxStatement,
  readPayoutStatement,
  statementCardFeeBp,
  statementExtraOre,
  statementForReconciliation,
} from "./nayax-statement";
import { parsePayoutFile } from "./payout-csv";
import { extractPdfLines, PdfTextError } from "./pdf-text";
import { NAYAX_OCTOBER } from "./testing/nayax-fixture";
import { buildPdf, editLines, octoberPdf, type FixtureLine } from "./testing/nayax-pdf";

const parse = (lines: readonly FixtureLine[]) => parseNayaxStatement(extractPdfLines(buildPdf(lines)));

describe("belopp och datum på Nayax vis", () => {
  it("engelskt format, parentes är minus", () => {
    expect(parseNayaxMoney("kr 76,245.00")).toBe(7_624_500);
    expect(parseNayaxMoney("(kr 3,089.80)")).toBe(-308_980);
    expect(parseNayaxMoney("kr 0.00")).toBe(0);
    expect(parseNayaxMoney("kr 1,234,567.89")).toBe(123_456_789);
    expect(parseNayaxMoney("kr -40.00")).toBe(-4_000);
  });

  it("annat än ett helt belopp tolkas inte", () => {
    for (const bad of ["76,245.00", "kr 76.245,00", "kr 12", "(kr 5.00", "kr 1,23.00", "", "kr"]) {
      expect(parseNayaxMoney(bad), bad).toBeNull();
    }
  });

  it("datum dd/mm/åååå", () => {
    expect(parseNayaxDate("31/10/2026")).toBe("2026-10-31");
    expect(parseNayaxDate("16/11/2026")).toBe("2026-11-16");
    expect(parseNayaxDate("31/02/2026")).toBeNull();
    expect(parseNayaxDate("2026-10-31")).toBeNull();
  });
});

describe("oktoberrapporten (riktiga siffror, påhittat företag)", () => {
  const { period, statement } = parseNayaxStatement(extractPdfLines(octoberPdf()));

  it("PDF-läsningen ger samma rader som rapporten", () => {
    const lines = extractPdfLines(octoberPdf());
    expect(lines.map((l) => l.cells.map((c) => c.text))).toEqual(
      NAYAX_OCTOBER.map((l) => l[2].map((c) => c[2])),
    );
  });

  it("period, belopp, avgifter och utbetalningsdag", () => {
    expect(period).toEqual({ start: "2026-10-01", end: "2026-10-31" });
    expect(statement.grossOre).toBe(7_624_500);
    expect(statement.reimbursedOre).toBe(7_624_500);
    expect(statement.feesOre).toBe(308_980);
    expect(statement.cardFeeOre).toBe(304_980);
    expect(statement.totalOre).toBe(7_233_048);
    expect(statement.payoutUntil).toBe("2026-11-16");
    expect(statement.transactions).toBe(441);
    expect(statementCardFeeBp(statement)).toBe(400);
  });

  it("bankavgiften och engångsavgiften är egna rader med orsak", () => {
    expect(statement.deductions).toEqual([
      { kind: "bank_fee", reason: "Processing Bank Wire Fee", amountOre: 4_000 },
      { kind: "adjustment", reason: "Onboarding fee", amountOre: 82_472 },
    ]);
    expect(statementExtraOre(statement)).toBe(82_472);
  });

  it("automaterna, störst först, summerar till försäljningen", () => {
    expect(statement.devices).toEqual([
      {
        name: "Sega Gubben",
        serial: "2222000022220002",
        transactions: 420,
        amountOre: 7_251_100,
        feeOre: 290_044,
      },
      {
        name: "Ny 3 20261016",
        serial: "1111000011110001",
        transactions: 21,
        amountOre: 373_400,
        feeOre: 14_936,
      },
    ]);
  });

  it("avstämningen får kortavgiften som avgift och resten som kända avdrag", () => {
    const r = statementForReconciliation(statement);
    expect(r).toEqual({ amountOre: 7_233_048, feesOre: 304_980, deductionsOre: 86_472 });
    // utbetalt + kortavgift + avdrag = försäljningen
    expect(r.amountOre + r.feesOre + r.deductionsOre).toBe(statement.reimbursedOre);
  });

  it("referens och fingeravtryck", () => {
    expect(nayaxReference(period)).toBe("Nayax 2026-10");
    expect(nayaxReference({ start: "2026-10-01", end: "2026-10-14" })).toBe(
      "Nayax 2026-10-01 till 2026-10-14",
    );
    const again = parseNayaxStatement(extractPdfLines(octoberPdf()));
    expect(nayaxSourceHash(again)).toBe(nayaxSourceHash({ period, statement }));
    expect(nayaxSourceHash({ period, statement: { ...statement, totalOre: 1 } })).not.toBe(
      nayaxSourceHash({ period, statement }),
    );
  });

  it("den sparade formen går att läsa tillbaka, och skräp gör det inte", () => {
    expect(readPayoutStatement(JSON.parse(JSON.stringify(statement)))).toEqual(statement);
    expect(readPayoutStatement(null)).toBeNull();
    expect(readPayoutStatement({ v: 2, provider: "nayax" })).toBeNull();
    expect(readPayoutStatement({ ...statement, totalOre: "1" })).toBeNull();
  });

  it("företagets uppgifter sparas inte", () => {
    const saved = JSON.stringify(statement);
    for (const secret of ["Exempel Automat AB", "1000000001", "C100001", "example.com"]) {
      expect(saved).not.toContain(secret);
    }
  });
});

describe("andra rapporter", () => {
  it("två justeringar blir två rader", () => {
    // En rad till i tabellen Adjustments, och summorna ändrade så att de går ihop.
    const extra: FixtureLine = [
      1,
      -621.9,
      [
        [306.4, 352.0, "Chargeback"],
        [497.6, 527.0, "kr 200.00"],
      ],
    ];
    const lines = [
      ...editLines(NAYAX_OCTOBER, (text) =>
        text === "(kr 824.72)"
          ? "(kr 1,024.72)"
          : text === "kr 824.72"
            ? undefined
            : text === "kr 72,330.48"
              ? "kr 72,130.48"
              : undefined,
      ).map((l): FixtureLine =>
        // Summaraden i Adjustments (den andra "Total:" på raden).
        l[1] === -535.7
          ? [l[0], l[1], l[2].map((c) => (c[2] === "kr 824.72" ? [c[0], c[1], "kr 1,024.72"] : c))]
          : l,
      ),
      extra,
    ];
    const { statement } = parse(lines);
    expect(statement.totalOre).toBe(7_213_048);
    expect(statement.deductions.filter((d) => d.kind === "adjustment")).toEqual([
      { kind: "adjustment", reason: "Onboarding fee", amountOre: 82_472 },
      { kind: "adjustment", reason: "Chargeback", amountOre: 20_000 },
    ]);
  });

  it("ingen justering alls", () => {
    const lines = editLines(NAYAX_OCTOBER, (text, line) =>
      text === "(kr 824.72)"
        ? "kr 0.00"
        : text === "kr 72,330.48"
          ? "kr 73,155.20"
          : text === "Onboarding fee" || (text === "kr 824.72" && line[1] === -636.9)
            ? null
            : text === "kr 824.72"
              ? "kr 0.00"
              : undefined,
    );
    const { statement } = parse(lines);
    expect(statement.totalOre).toBe(7_315_520);
    expect(statement.deductions).toEqual([
      { kind: "bank_fee", reason: "Processing Bank Wire Fee", amountOre: 4_000 },
    ]);
  });

  it("en siffra som saknas: nekas, med vad som saknas", () => {
    const lines = editLines(NAYAX_OCTOBER, (text) => (text === "kr 72,330.48" ? null : undefined));
    expect(() => parse(lines)).toThrow(NayaxStatementError);
    expect(() => parse(lines)).toThrow(/Total To Transfer saknas\. Inget är sparat/);
    const noPeriod = editLines(NAYAX_OCTOBER, (text) =>
      text === "01/10/2026 - 31/10/2026" ? "oktober" : undefined,
    );
    expect(() => parse(noPeriod)).toThrow(/perioden \(Reimbursement Period\) saknas/);
    const noFee = editLines(NAYAX_OCTOBER, (text) => (text === "Processing Fee:" ? null : undefined));
    expect(() => parse(noFee)).toThrow(/Processing Fee saknas/);
  });

  it("summor som inte går ihop: nekas", () => {
    const lines = editLines(NAYAX_OCTOBER, (text) =>
      text === "kr 72,330.48" ? "kr 72,430.48" : undefined,
    );
    expect(() => parse(lines)).toThrow(/summa går inte ihop/);
    // En krona fel är fortfarande fel åt det hållet: 1,01 kr nekas, 1,00 kr går.
    const off = (total: string) =>
      editLines(NAYAX_OCTOBER, (text) => (text === "kr 72,330.48" ? total : undefined));
    expect(() => parse(off("kr 72,331.49"))).toThrow(/summa går inte ihop/);
    expect(parse(off("kr 72,331.48")).statement.totalOre).toBe(7_233_148);
  });

  it("automater som inte summerar till försäljningen visas inte (men rapporten läses)", () => {
    const lines = editLines(NAYAX_OCTOBER, (text) => (text === "72,511.00" ? "72,000.00" : undefined));
    const { statement } = parse(lines);
    expect(statement.devices).toEqual([]);
    expect(statement.totalOre).toBe(7_233_048);
  });

  it("avgiftstabell som inte summerar: hela avgiften räknas som kortavgift okänd", () => {
    const lines = editLines(NAYAX_OCTOBER, (text) => (text === "kr 40.00" ? "kr 41.00" : undefined));
    const { statement } = parse(lines);
    expect(statement.cardFeeOre).toBeNull();
    expect(statementCardFeeBp(statement)).toBeNull();
    expect(statementForReconciliation(statement)).toEqual({
      amountOre: 7_233_048,
      feesOre: 308_980,
      deductionsOre: 82_472,
    });
  });

  it("en PDF som inte är från Nayax nekas", () => {
    const other: FixtureLine[] = [
      [1, -800, [[40, 120, "Faktura 1234"]]],
      [
        1,
        -780,
        [
          [40, 100, "Att betala:"],
          [200, 260, "kr 1,000.00"],
        ],
      ],
    ];
    expect(() => parse(other)).toThrow(/inte en utbetalningsrapport från Nayax/);
  });

  it("en fil som inte är en PDF, eller är trasig, ger PdfTextError", () => {
    expect(() => extractPdfLines(new TextEncoder().encode("Referens;Belopp\n1;2"))).toThrow(
      PdfTextError,
    );
    const broken = octoberPdf().slice(0, 600);
    expect(() => parseNayaxStatement(extractPdfLines(broken))).toThrow();
  });

  it("en CSV-fil läses som förut", () => {
    const csv =
      "Referens;Period från;Period till;Utbetald;Belopp;Avgifter\r\nAW-1;2026-10-01;2026-10-31;2026-11-03;72330,48;3089,80\r\n";
    const parsed = parsePayoutFile(csv);
    expect(parsed.format).toBe("payouts");
    expect(parsed.payouts[0]).toMatchObject({ amountOre: 7_233_048, feesOre: 308_980 });
  });
});
