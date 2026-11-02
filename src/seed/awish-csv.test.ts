/**
 * Seedens Awish-CSV: läses av importens egen tolk (parseAwishCsv) utan fel,
 * med rätt belopp och tider, och är byte för byte lika med fixturen
 * test/fixtures/seed/ (determinism över tidszoner och körningar).
 *
 * Fixturen skrivs om med: npm run db:seed -- --write-csv test/fixtures/seed/<fil>
 */

import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { parseAwishCsv } from "@/import/adapters/awish-csv";
import { sha256Hex } from "@/import/hash";

import { AWISH_HEADER, formatAwishAmount, SEED_CSV_FILE_NAME, toAwishCsv, toAwishCsvBytes } from "./awish-csv";
import { EXPECTED_TOTAL_ORE, SEED_MACHINES, SOURCE_TIMEZONE } from "./catalog";
import { generateSeedOrders } from "./orders";

const orders = generateSeedOrders();
const FIXTURE = path.join(process.cwd(), "test", "fixtures", "seed", SEED_CSV_FILE_NAME);

const context = {
  organizationId: "00000000-0000-4000-8000-000000000001",
  dataSourceId: "00000000-0000-4000-8000-000000000002",
  sourceTimezone: SOURCE_TIMEZONE,
  config: {},
  secretRef: null,
};

describe("formatAwishAmount", () => {
  it("öre → kronor med två decimaler utan flyttal", () => {
    expect(formatAwishAmount(17_000)).toBe("170.00");
    expect(formatAwishAmount(17_005)).toBe("170.05");
    expect(formatAwishAmount(0)).toBe("0.00");
    expect(() => formatAwishAmount(-1)).toThrow();
    expect(() => formatAwishAmount(1.5)).toThrow();
  });
});

describe("toAwishCsv", () => {
  const text = toAwishCsv(orders);

  it("Awish-format: BOM, rubrikrad, CRLF, nyaste först", () => {
    expect(text.startsWith("﻿")).toBe(true);
    const lines = text.slice(1).split("\r\n");
    expect(lines[0]).toBe(AWISH_HEADER.join(","));
    expect(lines.at(-1)).toBe("");
    expect(lines).toHaveLength(462);
    expect(lines[1]).toContain(',42780,"BL-001 Centrum"');
    expect(lines[1]).toContain('"Amount: 170.00",Paid Success,2026-11-02 00:17:00,Details');
    expect(lines[460]).toContain(",42321,");
  });

  it("importens tolk läser alla 460 som betalda, utan fel, med rätt summa", () => {
    const result = parseAwishCsv({
      context,
      file: { name: SEED_CSV_FILE_NAME, content: toAwishCsvBytes(orders) },
    });
    expect(result.errors).toEqual([]);
    expect(result.rows).toHaveLength(460);
    expect(result.rows.every((r) => r.isPaid)).toBe(true);
    expect(result.rows.reduce((n, r) => n + r.amountOre, 0)).toBe(EXPECTED_TOTAL_ORE);
    const byId = new Map(orders.map((o) => [o.externalId, o]));
    for (const r of result.rows) {
      const o = byId.get(r.externalId);
      expect(o, r.externalId).toBeDefined();
      expect(r.paidAtUtc.getTime()).toBe(o?.paidAtMs);
      expect(r.amountOre).toBe(o?.amountOre);
      expect(r.rawTitle).toBe(o?.title);
      expect(r.sourceMachineName).toBe(o?.awishMachine);
      expect(r.paymentMethod).toBe(o?.paymentMethod);
    }
    expect(new Set(result.machines.map((m) => m.externalName ?? m.externalId))).toEqual(
      new Set(SEED_MACHINES.map((m) => m.awishName)),
    );
  });

  it("är byte för byte lika med fixturen", () => {
    const fixture = new Uint8Array(readFileSync(FIXTURE));
    expect(sha256Hex(toAwishCsvBytes(orders))).toBe(sha256Hex(fixture));
  });
});
