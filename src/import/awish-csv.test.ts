import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import type { AdapterContext } from "./adapter";
import { awishGrpcAdapter, AWISH_GRPC_MISSING } from "./adapters/awish-grpc";
import { parseAwishCsv, type AwishCsvInput } from "./adapters/awish-csv";
import { parseCsvTable } from "./csv-table";
import { ImportValidationError, MappingError, NotConfiguredError } from "./errors";
import { sourceHash } from "./hash";

const ORG = "11111111-1111-4111-8111-111111111111";
const context: AdapterContext = {
  organizationId: ORG,
  dataSourceId: "22222222-2222-4222-8222-222222222222",
  sourceTimezone: "Asia/Shanghai",
  config: {},
  secretRef: null,
};

const FIXTURES = path.join(__dirname, "..", "..", "test", "fixtures", "awish");
const fixture = (name: string): Uint8Array =>
  new Uint8Array(readFileSync(path.join(FIXTURES, name)));

function parse(content: string | Uint8Array, extra: Partial<AwishCsvInput> = {}) {
  return parseAwishCsv({ context, file: { name: "x.csv", content }, ...extra });
}

const HEADER =
  "ID,Date,Name,Order No.,Order Machine,Payment Method,Order Amount,Is Paid,Payment Time,Actions";

describe("parseCsvTable", () => {
  it("hanterar BOM, CRLF, citat med radbrytning och tomma rader, med filens radnummer", () => {
    const BOM = String.fromCharCode(0xfeff);
    const t = parseCsvTable(`${BOM}a,b\r\n1,"x\r\ny"\r\n\r\n   \r\n2,"say ""hi"""\n3,z\n`);
    expect(t.delimiter).toBe(",");
    expect(t.records.map((r) => [r.lineNumber, r.cells])).toEqual([
      [1, ["a", "b"]],
      [2, ["1", "x\ny"]],
      [6, ["2", 'say "hi"']],
      [7, ["3", "z"]],
    ]);
  });

  it.each([
    [";", "a;b;c\n1,5;2;3\n"],
    ["\t", "a\tb\tc\n1,5\t2\t3\n"],
    [",", 'a,b,c\n"1,5",2,3\n'],
  ])("gissar avgränsaren %j", (delimiter, text) => {
    const t = parseCsvTable(text);
    expect(t.delimiter).toBe(delimiter);
    expect(t.records[1]?.cells).toEqual(["1,5", "2", "3"]);
  });

  it("avkodar Windows-1252 när filen inte är giltig UTF-8", () => {
    const bytes = new Uint8Array([
      0x4e, 0x61, 0x6d, 0x65, 0x0a, 0x50, 0x6f, 0x6b, 0xe9, 0x6d, 0x6f, 0x6e, 0x0a,
    ]);
    const t = parseCsvTable(bytes);
    expect(t.encoding).toBe("windows-1252");
    expect(t.records[1]?.cells).toEqual(["Pokémon"]);
  });

  it("rapporterar citattecken som inte stängs", () => {
    const t = parseCsvTable('a,b\n1,"oj\n');
    expect(t.records[1]?.error).toContain("Citattecken");
  });
});

describe("parseAwishCsv", () => {
  it("tolkar Awish orderlista (fixtur med BOM och CRLF)", () => {
    const r = parse(fixture("orderlista-2026-11-02.csv"));
    expect(r.parserVersion).toBe("awish_csv/1");
    expect(r.mapping.delimiter).toBe(",");
    expect(r.rows.map((o) => [o.sourceRowNumber, o.externalId, o.isPaid])).toEqual([
      [2, "42780", true],
      [3, "42781", true],
      [6, "42783", true],
    ]);
    const first = r.rows[0]!;
    expect(first).toMatchObject({
      rawTitle: "Pokémon TCG: Surging Sparks Booster",
      sourceMachineName: "BL-001 ICA Lund",
      paymentMethod: "WeChat Pay",
      amountOre: 17000,
    });
    expect(first.paidAtUtc.toISOString()).toBe("2026-11-01T16:17:00.000Z");
    expect(first.raw["Order No."]).toBe("42780");
    expect(first.raw.Actions).toBe("Details");

    // Rad 4 är inte betald och saknar tid: räknas som ej betald, inte som fel.
    expect(r.errors.map((e) => [e.sourceRowNumber, e.externalId, e.isPaid])).toEqual([
      [4, "42782", false],
      [7, "42784", true],
      [8, "42785", true],
    ]);
    expect(r.errors[1]?.message).toContain("abc");
    expect(r.errors[2]?.message).toContain("Ogiltigt datum");
    expect(r.machines.map((m) => m.externalId).sort()).toEqual([
      "BL-001 ICA Lund",
      "BL-002 Coop Malmö",
    ]);
  });

  it("semikolon, svenska decimaler och citerad avgränsare i namnet", () => {
    const r = parse(fixture("orderlista-overlapp.csv"));
    expect(r.mapping.delimiter).toBe(";");
    expect(r.rows.map((o) => [o.externalId, o.amountOre, o.rawTitle])).toEqual([
      ["42781", 18900, "Pokémon TCG: Prismatic Evolutions Booster"],
      ["42786", 18900, "Pokémon TCG: Prismatic Evolutions Booster"],
      ["42787", 15900, "Pokémon TCG: Stellar Crown; Booster"],
    ]);
  });

  it("samma order i olika format ger samma källhash", () => {
    const a = parse(fixture("orderlista-2026-11-02.csv")).rows.find(
      (o) => o.externalId === "42781",
    )!;
    const b = parse(fixture("orderlista-overlapp.csv")).rows.find((o) => o.externalId === "42781")!;
    expect(sourceHash(a)).toBe(sourceHash(b));
    const c = parse(fixture("orderlista-avvikande-belopp.csv")).rows[0]!;
    const orig = parse(fixture("orderlista-2026-11-02.csv")).rows[0]!;
    expect(sourceHash(c)).not.toBe(sourceHash(orig));
  });

  it("ej betald rad med trasiga fält räknas som ej betald, inte som fel", () => {
    const r = parse(`${HEADER}\n1,,Kort,500,M1,Card,Amount: ?,Unpaid,,x\n`);
    expect(r.rows).toEqual([]);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]?.isPaid).toBe(false);
  });

  it("hittar rubrikraden under en titelrad", () => {
    const r = parse(
      `Orderlista export 2026-11-02\n\n${HEADER}\n1,,Kort,500,M1,Card,Amount: 10,Paid Success,2026-11-02 10:00:00,x\n`,
    );
    expect(r.mapping.headerRowNumber).toBe(3);
    expect(r.rows[0]?.sourceRowNumber).toBe(4);
  });

  it("svenska rubriker och överstyrd mappning", () => {
    const text =
      "Kvitto;Produkt;Automat;Belopp;Betald;Tidpunkt\nA1;Kort;M1;10,00;Ja;2026-11-02 10:00\n";
    expect(() => parse(text)).toThrow(MappingError);
    const r = parse(text, { mapping: { columns: { externalId: "Kvitto", paidAt: "Tidpunkt" } } });
    expect(r.rows[0]).toMatchObject({ externalId: "A1", amountOre: 1000, isPaid: true });
    expect(r.mapping.source.externalId).toBe("override");
  });

  it("sparad mappning från datakällan används", () => {
    const text =
      "Kvitto;Produkt;Automat;Belopp;Betald;Tidpunkt\nA1;Kort;M1;10,00;Ja;2026-11-02 10:00\n";
    const r = parseAwishCsv({
      context: {
        ...context,
        config: { csvMapping: { columns: { externalId: "Kvitto", paidAt: "Tidpunkt" } } },
      },
      file: { name: "x.csv", content: text },
    });
    expect(r.mapping.source.paidAt).toBe("saved");
    expect(r.rows).toHaveLength(1);
  });

  it("felaktiga rader får radnummer och svenska meddelanden", () => {
    const r = parse(
      `${HEADER}\n` +
        `1,,Kort,,M1,Card,Amount: 10,Paid Success,2026-11-02 10:00:00,x\n` +
        `2,,,501,M1,Card,Amount: -10,Paid Success,2026-11-02 10:00:00,x\n` +
        `3,,Kort,502,,Card,Amount: 10,Paid Success,igår,x\n` +
        `4,,Kort,503,M1,Card,Amount: 10,Paid Success,2026-11-02 10:00:00,x,extra\n`,
    );
    expect(r.rows).toEqual([]);
    expect(r.errors.map((e) => e.sourceRowNumber)).toEqual([2, 3, 4, 5]);
    expect(r.errors[0]?.message).toContain("Ordernummer saknas");
    expect(r.errors[1]?.message).toMatch(/Produktnamn.*Negativa/);
    expect(r.errors[2]?.message).toMatch(/Automat saknas.*igår/);
    expect(r.errors[3]?.message).toContain("fler kolumner");
  });

  it("källans tidszon styr tolkningen, inte processens", () => {
    const text = `${HEADER}\n1,,Kort,500,M1,Card,Amount: 10,Paid Success,2026-10-25 02:30:00,x\n`;
    const sh = parse(text).rows[0]!;
    expect(sh.paidAtUtc.toISOString()).toBe("2026-10-24T18:30:00.000Z");
    expect(sh.notes).toBeUndefined();
    const sto = parseAwishCsv({
      context: { ...context, sourceTimezone: "Europe/Stockholm" },
      file: { name: "x.csv", content: text },
    }).rows[0]!;
    expect(sto.paidAtUtc.toISOString()).toBe("2026-10-25T00:30:00.000Z");
    expect(sto.notes?.[0]).toContain("två gånger");
  });

  it("tom fil och fil utan data", () => {
    expect(() => parse("")).toThrow(ImportValidationError);
    expect(() => parse("\n\n")).toThrow(ImportValidationError);
    expect(parse(`${HEADER}\n`).rows).toEqual([]);
  });
});

describe("awish_grpc", () => {
  it("kastar NotConfiguredError med listan över vad som saknas", async () => {
    await expect(awishGrpcAdapter.fetch({ context })).rejects.toBeInstanceOf(NotConfiguredError);
    await expect(awishGrpcAdapter.fetch({ context })).rejects.toMatchObject({
      missing: AWISH_GRPC_MISSING,
    });
    expect(AWISH_GRPC_MISSING.join(" ")).toMatch(
      /proto.*token.*TLS.*metadata.*Webhook.*Exempelpayload/is,
    );
  });

  it("nekar en hemlighet utanför organisationens namnrymd innan något annat", async () => {
    await expect(
      awishGrpcAdapter.fetch({ context: { ...context, secretRef: "annan-org/awish" } }),
    ).rejects.toBeInstanceOf(ImportValidationError);
    await expect(
      awishGrpcAdapter.fetch({ context: { ...context, secretRef: `${ORG}/awish-token` } }),
    ).rejects.toBeInstanceOf(NotConfiguredError);
  });
});
