import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { crc32, zipBytes, zipEntry } = await import("./zip");
const { parseExportCsv, unzip } = await import("./testing/unzip");
const { EXPORT_TABLES, README_FILE } = await import("./tables");
const { exportFileName, tableCsv } = await import("./service");

const AT = new Date("2026-11-05T19:30:12Z");

describe("zip", () => {
  it("CRC-32 enligt standarden", () => {
    expect(crc32(new TextEncoder().encode("123456789"))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });

  it("skriver ett arkiv som går att läsa tillbaka (CRC och storlek kontrolleras)", () => {
    const big = "rad;med;åäö\r\n".repeat(5000);
    const zip = zipBytes([zipEntry("a.csv", "x;y\r\n1;2\r\n"), zipEntry("b.csv", big)], AT);
    const files = unzip(zip);
    expect(files.map((f) => f.name)).toEqual(["a.csv", "b.csv"]);
    expect(files[0]!.text).toBe("x;y\r\n1;2\r\n");
    expect(files[1]!.text).toBe(big);
    // Komprimerat: mycket mindre än innehållet.
    expect(zip.length).toBeLessThan(big.length / 10);
  });

  it("samma filer och tid ger samma bytes", () => {
    const a = zipBytes([zipEntry("a.csv", "1")], AT);
    const b = zipBytes([zipEntry("a.csv", "1")], AT);
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(true);
  });

  it("arkivet godkänns av unzip (Info-ZIP)", () => {
    const dir = mkdtempSync(join(tmpdir(), "binderlab-zip-"));
    const path = join(dir, "x.zip");
    writeFileSync(
      path,
      zipBytes([zipEntry("order.csv", "a;b\r\n"), zipEntry("LASMIG.txt", "hej")], AT),
    );
    let out = "";
    try {
      out = execFileSync("unzip", ["-t", path], { encoding: "utf8" });
    } catch (error) {
      // unzip saknas på maskinen: arkivet kontrolleras ändå av unzip() ovan.
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    expect(out).toMatch(/No errors detected/);
  });

  it("nekar filnamn som pekar utanför arkivet", () => {
    expect(() => zipEntry("../x.csv", "")).toThrow(TypeError);
    expect(() => zipEntry("/x.csv", "")).toThrow(TypeError);
    expect(() => zipEntry("a b.csv", "")).toThrow(TypeError);
  });
});

describe("exportens CSV", () => {
  it("rubrikrad, semikolon, BOM, CRLF och citattecken", () => {
    const csv = tableCsv(
      ["id", "name", "amount_ore"],
      [
        { id: "1", name: 'Butik "Centrum"; plan 2', amount_ore: "7900" },
        { id: "2", name: null, amount_ore: "-100" },
      ],
    );
    expect(csv.startsWith("﻿id;name;amount_ore\r\n")).toBe(true);
    expect(parseExportCsv(csv)).toEqual([
      ["id", "name", "amount_ore"],
      ["1", 'Butik "Centrum"; plan 2', "7900"],
      ["2", "", "-100"],
    ]);
  });

  it("text som börjar som en formel blir text i Excel", () => {
    const csv = tableCsv(["note"], [{ note: "=HYPERLINK(1)" }]);
    expect(parseExportCsv(csv)[1]).toEqual(["'=HYPERLINK(1)"]);
  });

  it("filnamnet har organisationen och dagen i organisationens tidszon", () => {
    expect(exportFileName("Binderlab Försäljning AB", AT, "Europe/Stockholm")).toBe(
      "binderlab-export-binderlab-forsaljning-ab-2026-11-05.zip",
    );
    // 23:30 UTC är nästa dag i Stockholm.
    expect(exportFileName("Å", new Date("2026-11-05T23:30:00Z"), "Europe/Stockholm")).toBe(
      "binderlab-export-a-2026-11-06.zip",
    );
    expect(exportFileName("???", AT, "UTC")).toBe("binderlab-export-organisation-2026-11-05.zip");
  });
});

describe("tabellerna i exporten", () => {
  it("tar med det kunden äger: automater, butiker, titlar, priser, order, lager, avräkningar", () => {
    const tables = EXPORT_TABLES.map((t) => t.table);
    for (const t of [
      "machines",
      "stores",
      "titles",
      "purchase_prices",
      "orders",
      "stock_events",
      "store_settlements",
    ]) {
      expect(tables).toContain(t);
    }
  });

  it("unika och giltiga filnamn, och förklaringsfilen krockar inte", () => {
    const files = EXPORT_TABLES.map((t) => t.file);
    expect(new Set(files).size).toBe(files.length);
    expect(files).not.toContain(README_FILE);
    for (const f of files) expect(() => zipEntry(f, "")).not.toThrow();
  });

  it("datakällornas inställningar och hänvisningar till Vault tas inte med", () => {
    const ds = EXPORT_TABLES.find((t) => t.table === "data_sources");
    expect(ds?.omit).toEqual(expect.arrayContaining(["config", "secret_ref", "cursor"]));
  });
});
