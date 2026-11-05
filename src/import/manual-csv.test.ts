import { describe, expect, it } from "vitest";

import { MANUAL_CSV_TEMPLATE as CLIENT_TEMPLATE } from "@/app/(app)/datakallor/_lib/constants";

import type { AdapterContext } from "./adapter";
import {
  isoDateText,
  manualCsvAdapter,
  MANUAL_CSV_PARSER_VERSION,
  MANUAL_CSV_TEMPLATE,
  parseManualCsv,
} from "./adapters/manual-csv";
import { ImportValidationError } from "./errors";

const context: AdapterContext = {
  organizationId: "11111111-1111-4111-8111-111111111111",
  dataSourceId: "22222222-2222-4222-8222-222222222222",
  sourceTimezone: "Europe/Stockholm",
  config: {},
  secretRef: null,
};

function parse(content: string | Uint8Array, zone = "Europe/Stockholm") {
  return parseManualCsv({
    context: { ...context, sourceTimezone: zone },
    file: { name: "f.csv", content },
  });
}

describe("Annan automat (CSV)", () => {
  it("mallen tolkas: Antal 2 blir två order med halva beloppet, tider i svensk tid", () => {
    const r = parse(MANUAL_CSV_TEMPLATE);
    expect(r.errors).toEqual([]);
    expect(r.parserVersion).toBe(MANUAL_CSV_PARSER_VERSION);
    expect(r.rows).toHaveLength(3);
    expect(r.rows.map((o) => o.amountOre)).toEqual([7900, 8900, 8900]);
    expect(r.rows[0]!.paidAtUtc.toISOString()).toBe("2026-11-03T13:05:00.000Z");
    expect(r.rows[0]!.rawTitle).toBe("Pokémon Scarlet & Violet Booster");
    expect(r.rows[0]!.sourceMachineName).toBe("Butik Centrum");
    expect(r.rows.every((o) => o.isPaid && o.paymentMethod === null)).toBe(true);
    expect(new Set(r.rows.map((o) => o.externalId)).size).toBe(3);
    expect(r.machines).toEqual([{ externalId: "Butik Centrum", externalName: "Butik Centrum" }]);
    expect(r.absentFields).toEqual(["paymentMethod"]);
  });

  it("mallen i webbläsaren är samma som adapterns", () => {
    expect(CLIENT_TEMPLATE).toBe(MANUAL_CSV_TEMPLATE);
  });

  it("samma fil ger samma ordernummer (dubbletter vid ny uppladdning)", () => {
    const a = parse(MANUAL_CSV_TEMPLATE).rows.map((o) => o.externalId);
    const b = parse(MANUAL_CSV_TEMPLATE).rows.map((o) => o.externalId);
    expect(a).toEqual(b);
    expect(a[0]).toMatch(/^m[0-9a-f]{24}-1$/);
  });

  it("två likadana försäljningar i samma minut blir två order", () => {
    const r = parse(
      "Datum;Automat;Produkt;Belopp\n2026-11-03 10:00;A1;X;79\n2026-11-03 10:00;A1;X;79\n",
    );
    expect(r.rows.map((o) => o.externalId.slice(-2))).toEqual(["-1", "-2"]);
  });

  it("engelska rubriker, komma, europeiskt datum och separat tid", () => {
    const r = parse(
      'Date,Time,Machine,Product,Amount,Qty,Order No\n05.11.2026,9.15,BL-7,Booster,"89,00",1,X-1\n',
    );
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({
      externalId: "X-1",
      amountOre: 8900,
      sourceMachineName: "BL-7",
    });
    expect(r.rows[0]!.paidAtUtc.toISOString()).toBe("2026-11-05T08:15:00.000Z");
  });

  it("danska och norska rubriker (Dato, Beløb, Ordrenummer) hittas", () => {
    const r = parse(
      "Dato;Automat;Produkt;Beløb;Ordrenummer\n2026-11-05 10:00;DK-1;Booster;45;D-9\n",
    );
    expect(r.errors).toEqual([]);
    expect(r.rows[0]).toMatchObject({
      externalId: "D-9",
      amountOre: 4500,
      sourceMachineName: "DK-1",
    });
    expect(r.rows[0]!.paidAtUtc.toISOString()).toBe("2026-11-05T09:00:00.000Z");
  });

  it("bara datum: kl. 12.00 i källans tidszon, rätt affärsdag", () => {
    const r = parse("Datum;Automat;Produkt;Belopp\n2026-11-05;A;X;10\n");
    expect(r.rows[0]!.paidAtUtc.toISOString()).toBe("2026-11-05T11:00:00.000Z");
    expect((r.mapping as { defaultTime: string | null }).defaultTime).toBe("12:00");
  });

  it("ordernummer från filen med Antal 3 blir tre unika id", () => {
    const r = parse(
      "Datum;Automat;Produkt;Belopp;Antal;Ordernummer\n2026-11-05 10:00;A;X;30;3;77\n",
    );
    expect(r.rows.map((o) => o.externalId)).toEqual(["77#1", "77#2", "77#3"]);
    expect(r.rows.map((o) => o.amountOre)).toEqual([1000, 1000, 1000]);
    // Ett radnummer per order (importloggen): pack 2 och 3 efter filens sista rad.
    expect(r.rows.map((o) => o.sourceRowNumber)).toEqual([2, 3, 4]);
    expect(r.rows[1]!.notes).toEqual(["Pack 2 av 3 på rad 2 i filen."]);
  });

  it("felrader: belopp, antal, datum och tomma fält ger svenska meddelanden", () => {
    const r = parse(
      [
        "Datum;Automat;Produkt;Belopp;Antal",
        "2026-11-05;A;X;tio;1",
        "2026-11-05;A;X;10;0",
        "2026-13-05;A;X;10;1",
        ";A;X;10;1",
        "2026-11-05;;X;10;1",
        "2026-11-05;A;;10;1",
        "2026-11-05;A;X;10;3",
        "2026-11-05;A;X;10;1",
        "",
      ].join("\n"),
    );
    expect(r.rows).toHaveLength(1);
    const messages = r.errors.map((e) => e.message);
    expect(messages[0]).toMatch(/beloppet/i);
    expect(messages[1]).toMatch(/mellan 1 och 1000/);
    expect(messages[2]).toMatch(/Ogiltigt datum/);
    expect(messages[3]).toMatch(/Datum saknas/);
    expect(messages[4]).toMatch(/Automat saknas/);
    expect(messages[5]).toMatch(/Produkt saknas/);
    expect(messages[6]).toMatch(/dela lika på 3/);
    expect(r.errors.map((e) => e.sourceRowNumber)).toEqual([2, 3, 4, 5, 6, 7, 8]);
  });

  it("betalstatus respekteras när kolumnen finns", () => {
    const r = parse(
      "Datum;Automat;Produkt;Belopp;Betald\n2026-11-05;A;X;10;Nej\n2026-11-05;A;X;10;Ja\n",
    );
    expect(r.rows.map((o) => o.isPaid)).toEqual([false, true]);
    // Automaten räknas bara från betalda rader.
    expect(r.machines).toHaveLength(1);
  });

  it("saknade kolumner: ett tydligt fel som nämner mallen", () => {
    expect(() => parse("Datum;Produkt\n2026-11-05;X\n")).toThrow(ImportValidationError);
    expect(() => parse("Datum;Produkt\n2026-11-05;X\n")).toThrow(/Automat, Belopp.*mallen/);
    expect(() => parse("")).toThrow(ImportValidationError);
  });

  it("rubrikraden kan stå efter några rader text", () => {
    const r = parse(
      "Försäljning november\n\nDatum;Automat;Produkt;Belopp\n2026-11-05 10:00;A;X;10\n",
    );
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]!.sourceRowNumber).toBe(4);
  });

  it("isoDateText: dag först blir ISO, annat lämnas", () => {
    expect(isoDateText("5.11.2026")).toBe("2026-11-05");
    expect(isoDateText("05/11/2026 14:05")).toBe("2026-11-05 14:05");
    expect(isoDateText("2026-11-05")).toBe("2026-11-05");
  });

  it("adaptern har providern manual_csv", async () => {
    expect(manualCsvAdapter.provider).toBe("manual_csv");
    const r = await manualCsvAdapter.fetch({
      context,
      file: { name: "m.csv", content: MANUAL_CSV_TEMPLATE },
    });
    expect(r.rows).toHaveLength(3);
  });

  it("Windows-1252 (Excel på Windows) avkodas", () => {
    const text = "Datum;Automat;Produkt;Belopp\r\n2026-11-05 10:00;Kiosk Åre;Pokémon;10\r\n";
    const bytes = new Uint8Array([...text].map((c) => c.charCodeAt(0)));
    const r = parse(bytes);
    expect(r.rows[0]!.sourceMachineName).toBe("Kiosk Åre");
    expect(r.rows[0]!.rawTitle).toBe("Pokémon");
  });
});
