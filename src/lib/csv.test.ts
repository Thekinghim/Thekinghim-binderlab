import { describe, expect, it } from "vitest";
import { BOM, csvDate, csvField, csvFileName, csvNumber, toCsv, type CsvColumn } from "./csv";

type Row = { name: string; amount: number; note?: string };

const columns: CsvColumn<Row>[] = [
  { header: "Produkt", csv: (r) => r.name },
  { header: "Belopp", csv: (r) => r.amount },
  { header: "Notering", csv: (r) => r.note },
];

/** Plockar bort BOM och delar upp i rader (sista tomma raden efter CRLF tas bort). */
function lines(csv: string): string[] {
  return csv.replace(BOM, "").split("\r\n").slice(0, -1);
}

describe("csvNumber", () => {
  it("skriver decimalkomma utan tusentalsavgränsare", () => {
    expect(csvNumber(79987.5)).toBe("79987,5");
    expect(csvNumber(1234567.25)).toBe("1234567,25");
    expect(csvNumber(69)).toBe("69");
  });

  it("använder bindestreck som minus, aldrig U+2212", () => {
    expect(csvNumber(-1240.5)).toBe("-1240,5");
    expect(csvNumber(-3)).toBe("-3");
    expect(csvNumber(-1240.5)).not.toContain("−");
  });

  it("undviker flyttalsbrus", () => {
    expect(csvNumber(0.1 + 0.2)).toBe("0,3");
  });

  it("lämnar icke ändliga tal tomma", () => {
    expect(csvNumber(Number.NaN)).toBe("");
    expect(csvNumber(Number.POSITIVE_INFINITY)).toBe("");
  });
});

describe("csvField", () => {
  it("citerar text med semikolon", () => {
    expect(csvField("Kort; Mobil")).toBe('"Kort; Mobil"');
  });

  it("dubblerar citattecken och citerar fältet", () => {
    expect(csvField('Booster "Surging Sparks"')).toBe('"Booster ""Surging Sparks"""');
  });

  it("citerar radbrytningar (LF och CRLF)", () => {
    expect(csvField("rad 1\nrad 2")).toBe('"rad 1\nrad 2"');
    expect(csvField("rad 1\r\nrad 2")).toBe('"rad 1\r\nrad 2"');
  });

  it("lämnar vanlig text och komma ociterade", () => {
    expect(csvField("Lorcana Kap. 7")).toBe("Lorcana Kap. 7");
    expect(csvField("12,5")).toBe("12,5");
  });

  it("skyddar mot formelinjektion i text men inte i tal", () => {
    expect(csvField("=SUMMA(A1:A2)")).toBe("'=SUMMA(A1:A2)");
    expect(csvField("-5 kr")).toBe("'-5 kr");
    expect(csvField("@id")).toBe("'@id");
    expect(csvField(-5)).toBe("-5");
    expect(csvField("=1", { escapeFormulas: false })).toBe("=1");
  });

  it("skriver tomma celler för null och undefined", () => {
    expect(csvField(null)).toBe("");
    expect(csvField(undefined)).toBe("");
  });

  it("skriver datum i ISO-liknande lokal form", () => {
    expect(csvField(new Date(2026, 10, 1, 17, 17, 5))).toBe("2026-11-01 17:17:05");
    expect(csvDate(new Date(Number.NaN))).toBe("");
  });

  it("skriver sanningsvärden på svenska", () => {
    expect(csvField(true)).toBe("Ja");
    expect(csvField(false)).toBe("Nej");
  });
});

describe("toCsv", () => {
  const rows: Row[] = [
    { name: "Pokémon SV8 Booster", amount: 69 },
    { name: "One Piece OP-09; display", amount: -59, note: 'kund sa "fel fack"' },
    { name: "Lorcana Kap. 7", amount: 1234.5, note: "rad 1\nrad 2" },
  ];

  it("börjar med UTF-8 BOM", () => {
    const csv = toCsv(rows, columns);
    expect(csv.charCodeAt(0)).toBe(0xfeff);
    expect(csv.startsWith(BOM)).toBe(true);
  });

  it("kan utelämna BOM", () => {
    expect(toCsv(rows, columns, { bom: false }).charCodeAt(0)).not.toBe(0xfeff);
  });

  it("har rubrikrad, semikolon som avgränsare och CRLF som radslut", () => {
    const csv = toCsv(rows, columns);
    expect(csv.endsWith("\r\n")).toBe(true);
    expect(lines(csv)[0]).toBe("Produkt;Belopp;Notering");
    expect(lines(csv)[1]).toBe("Pokémon SV8 Booster;69;");
  });

  it("citerar semikolon och citattecken, behåller negativa tal", () => {
    expect(lines(toCsv(rows, columns))[2]).toBe(
      '"One Piece OP-09; display";-59;"kund sa ""fel fack"""',
    );
  });

  it("behåller radbrytning inuti ett citerat fält", () => {
    const csv = toCsv(rows, columns).replace(BOM, "");
    expect(csv).toContain('Lorcana Kap. 7;1234,5;"rad 1\nrad 2"\r\n');
  });

  it("faller tillbaka på sortValue och annars tom cell", () => {
    const cols: CsvColumn<Row>[] = [
      { header: "Namn", sortValue: (r) => r.name },
      { header: "Tom" },
    ];
    expect(lines(toCsv([{ name: "A", amount: 1 }], cols))).toEqual(["Namn;Tom", "A;"]);
  });

  it("ger bara rubrikrad för tom lista", () => {
    expect(lines(toCsv([], columns))).toEqual(["Produkt;Belopp;Notering"]);
  });
});

describe("csvFileName", () => {
  it("ger säkra filnamn utan diakriter", () => {
    expect(csvFileName("Transaktioner Försäljning 2026")).toBe("transaktioner-forsaljning-2026");
    expect(csvFileName("rapport.csv")).toBe("rapport");
    expect(csvFileName("???")).toBe("export");
  });
});
