/**
 * Granskning av importen (red team). Varje test uttrycker KORREKT beteende.
 * Ett test som fallerar är ett hål i importen, inte ett fel i testet; se
 * granskningsrapporten för förslag. Testerna försöker bryta:
 * idempotensen, tidszonerna (DST, Shanghai, månadsgräns), beloppen,
 * samtidigheten, behörigheten och om en ändrad källrad kan skriva över en order.
 */

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { parseAmountOre } from "../../src/import/amount";
import { ImportForbiddenError, ImportValidationError } from "../../src/import/errors";
import { runImport, type RunImportResult } from "../../src/import/run-import";
import { asPostgres, asUser, createUser, db, one, rows } from "./helpers";
import {
  awishCsv,
  countIn,
  mapMachine,
  ordersOf,
  setupImportOrg,
  type ImportFixture,
} from "./import-fixtures";

const TITLE = "Pokémon TCG: Surging Sparks Booster";
const MACHINE = "BL-002 Coop Malmö";

/** Hela orderraden som JSON, för att bevisa att inget fält ändrats. */
async function snapshot(orgId: string): Promise<Record<string, unknown>[]> {
  const r = await rows<{ o: Record<string, unknown> }>(
    db(),
    sql`select to_jsonb(o) as o from public.orders o
        where o.organization_id = ${orgId} order by o.external_id`,
  );
  return r.map((x) => x.o);
}

function statusOf(r: RunImportResult, rowNumber: number): string | undefined {
  return r.rows.find((x) => x.rowNumber === rowNumber)?.status;
}

async function addCsvSource(f: ImportFixture, name: string): Promise<string> {
  const s = await asUser(f.owner, (tx) =>
    one<{ id: string }>(
      tx,
      sql`insert into public.data_sources (organization_id, provider, name, source_timezone)
          values (${f.orgId}, 'awish_csv', ${name}, 'Asia/Shanghai') returning id`,
    ),
  );
  return s.id;
}

describe("red team: en ändrad källrad skriver aldrig över en order", () => {
  it("ändrat belopp, tid, titel, automat och betalmetod blir konflikter; orderraden är identisk", async () => {
    const f = await setupImportOrg();
    await f.run(awishCsv([{ no: "W1", time: "2026-11-02 10:00:00" }]));
    const before = await snapshot(f.orgId);

    const variants = [
      { amount: "Amount: 1.00" },
      { time: "2026-11-02 10:00:01" },
      { name: "Pokémon TCG: Prismatic Evolutions Booster" },
      { machine: "BL-999 Annan" },
      { method: "Card" },
    ];
    for (const v of variants) {
      const r = await f.run(awishCsv([{ no: "W1", time: "2026-11-02 10:00:00", ...v }]));
      expect(r.summary).toMatchObject({ new: 0, conflict: 1 });
    }
    expect(await snapshot(f.orgId)).toEqual(before);
    // Ingen ny titel och ingen ny källautomat skapades av konfliktraderna.
    expect(await countIn("titles", f.orgId)).toBe(1);
    expect(await countIn("source_machines", f.orgId)).toBe(1);
  });

  it("i samma fil: avvikande rad först, oförändrad rad sedan – den oförändrade är en dubblett", async () => {
    const f = await setupImportOrg();
    await f.run(awishCsv([{ no: "W2", time: "2026-11-02 10:00:00" }]));
    const before = await snapshot(f.orgId);
    const r = await f.run(
      awishCsv([
        { no: "W2", time: "2026-11-02 10:00:00", amount: "Amount: 999.00" },
        { no: "W2", time: "2026-11-02 10:00:00" },
      ]),
    );
    expect(await snapshot(f.orgId)).toEqual(before);
    expect(statusOf(r, 2)).toBe("conflict");
    // Raden är identisk med den sparade ordern och ska inte loggas som konflikt.
    expect(statusOf(r, 3)).toBe("duplicate");
  });

  it("en betald order som källan senare visar som obetald loggas som konflikt (inte tyst ej betald)", async () => {
    const f = await setupImportOrg();
    await f.run(awishCsv([{ no: "W3", time: "2026-11-02 10:00:00" }]));
    const before = await snapshot(f.orgId);
    const r = await f.run(awishCsv([{ no: "W3", time: "2026-11-02 10:00:00", paid: "Unpaid" }]));
    expect(await snapshot(f.orgId)).toEqual(before);
    expect(statusOf(r, 2)).toBe("conflict");
  });
});

describe("red team: idempotens mot omformaterade exporter", () => {
  it("samma order med annan formatering (belopp, mellanslag, avgränsare, radslut, BOM) är dubbletter", async () => {
    const f = await setupImportOrg();
    await f.run(
      awishCsv([
        { no: "I1", time: "2026-11-02 10:00:00", amount: "Amount: 170.00" },
        { no: "I2", time: "2026-11-02 11:00:00", amount: "Amount: 1234.50" },
      ]),
    );
    const before = await snapshot(f.orgId);
    const semicolon =
      "﻿Order No.;Name;Order Machine;Payment Method;Order Amount;Is Paid;Payment Time\n" +
      `I1;"  Pokémon   TCG:  Surging Sparks Booster ";"BL-001  ICA Lund";Swish;170,00 kr;Paid Success;2026-11-02 10:00\n` +
      `I2;"${TITLE}";BL-001 ICA Lund;Swish;"1 234,50";paid success;2026-11-02T03:00:00Z\n`;
    const r = await f.run(semicolon);
    expect(r.summary).toMatchObject({ new: 0, duplicate: 2, conflict: 0, error: 0 });
    expect(await snapshot(f.orgId)).toEqual(before);
  });

  it("Unicode NFD (t.ex. sparad på Mac) ger samma order, titel och källautomat som NFC", async () => {
    const f = await setupImportOrg();
    const machineId = await mapMachine(f, MACHINE, "A2");
    await f.run(
      awishCsv([{ no: "U1", time: "2026-11-02 10:00:00", name: TITLE, machine: MACHINE }]),
    );
    const r = await f.run(
      awishCsv([
        {
          no: "U1",
          time: "2026-11-02 10:00:00",
          name: TITLE.normalize("NFD"),
          machine: MACHINE.normalize("NFD"),
        },
        {
          no: "U2",
          time: "2026-11-02 11:00:00",
          name: TITLE.normalize("NFD"),
          machine: MACHINE.normalize("NFD"),
        },
      ]),
    );
    expect.soft(statusOf(r, 2)).toBe("duplicate");
    expect.soft(await countIn("titles", f.orgId)).toBe(1);
    expect.soft(await countIn("source_machines", f.orgId)).toBe(1);
    const u2 = (await ordersOf(f.orgId)).find((o) => o.external_id === "U2");
    expect.soft(u2?.machine_id).toBe(machineId);
  });

  it("en export utan den valfria kolumnen Payment Method gör inte befintliga order till konflikter", async () => {
    const f = await setupImportOrg();
    await f.run(awishCsv([{ no: "M1", time: "2026-11-02 10:00:00", method: "Swish" }]));
    const withoutMethod =
      "Order No.,Name,Order Machine,Order Amount,Is Paid,Payment Time\n" +
      `M1,"${TITLE}",BL-001 ICA Lund,"Amount: 170.00",Paid Success,2026-11-02 10:00:00\n`;
    const r = await f.run(withoutMethod);
    expect(r.summary).toMatchObject({ duplicate: 1, conflict: 0 });
  });

  it("ett ordernummer i exponentform (Excel: 4.27801E+11) är en felrad, inte en order", async () => {
    const f = await setupImportOrg();
    const r = await f.run(
      awishCsv([
        { no: "4.27801E+11", time: "2026-11-02 10:00:00" },
        { no: "4,27801E+11", time: "2026-11-02 10:01:00" },
      ]),
    );
    expect(r.summary.new).toBe(0);
    expect(r.summary.error).toBe(2);
    expect(await countIn("orders", f.orgId)).toBe(0);
  });

  it("en UTF-8-fil med en trasig byte ger inte mojibake-titlar (PokÃ©mon)", async () => {
    const f = await setupImportOrg();
    const enc = new TextEncoder();
    const good = enc.encode(awishCsv([{ no: "E1", time: "2026-11-02 10:00:00" }]));
    const bad = enc.encode(
      `9001,x,"${TITLE}",E2,BL-001 ICA Lund,Swish,"Amount: 170.00",Paid Success,2026-11-02 10:01:00,`,
    );
    const bytes = new Uint8Array([...good, ...bad, 0xff, 0x0d, 0x0a]);
    let rejected = false;
    try {
      await f.run(bytes);
    } catch (error) {
      expect(error).toBeInstanceOf(ImportValidationError);
      rejected = true;
    }
    if (!rejected) {
      const titles = await rows<{ name: string }>(
        db(),
        sql`select name from public.titles where organization_id = ${f.orgId}`,
      );
      expect(titles.map((t) => t.name)).toEqual([TITLE]);
    }
  });
});

describe("red team: tidszoner", () => {
  it("Shanghai över månadsgränsen: 1 nov. 06:59:59 hör till stängd oktober, 07:00:00 till november", async () => {
    const f = await setupImportOrg();
    await asUser(f.owner, (tx) =>
      tx.execute(sql`select public.close_period(${f.orgId}, '2026-10-01')`),
    );
    const r = await f.run(
      awishCsv([
        { no: "T1", time: "2026-11-01 06:59:59" },
        { no: "T2", time: "2026-11-01 07:00:00" },
      ]),
    );
    expect(r.summary).toMatchObject({ new: 2, lateInClosedPeriod: 1 });
    const orders = await ordersOf(f.orgId);
    expect(
      orders.map((o) => [o.external_id, o.ordered_at, o.business_date, o.late_in_closed_period]),
    ).toEqual([
      ["T1", "2026-10-31T22:59:59Z", "2026-10-31", true],
      ["T2", "2026-10-31T23:00:00Z", "2026-11-01", false],
    ]);
  });

  it("samma tidpunkt som lokal Shanghai-tid, med +08:00 och i UTC (Z) är dubbletter", async () => {
    const f = await setupImportOrg();
    await f.run(awishCsv([{ no: "Z1", time: "2026-11-02 00:17:00" }]));
    for (const time of [
      "2026-11-01T16:17:00Z",
      "2026-11-02 00:17:00+08:00",
      "2026-11-02T00:17:00+0800",
    ]) {
      const r = await f.run(awishCsv([{ no: "Z1", time }]));
      expect(r.summary).toMatchObject({ duplicate: 1, conflict: 0, error: 0 });
    }
  });

  it("Stockholm-källa: dubbeltimmen med uttrycklig +01:00 är en annan tidpunkt och blir konflikt, ordern orörd", async () => {
    const f = await setupImportOrg({ sourceTimezone: "Europe/Stockholm" });
    await f.run(awishCsv([{ no: "D1", time: "2026-10-25 02:30:00" }]));
    const before = await snapshot(f.orgId);
    expect((await ordersOf(f.orgId))[0]?.ordered_at).toBe("2026-10-25T00:30:00Z");
    const same = await f.run(awishCsv([{ no: "D1", time: "2026-10-25 02:30:00+02:00" }]));
    expect(same.summary).toMatchObject({ duplicate: 1, conflict: 0 });
    const later = await f.run(awishCsv([{ no: "D1", time: "2026-10-25 02:30:00+01:00" }]));
    expect(later.summary).toMatchObject({ conflict: 1 });
    expect(await snapshot(f.orgId)).toEqual(before);
  });

  it("orimliga tider blir felrader, inte order", async () => {
    const f = await setupImportOrg();
    const r = await f.run(
      awishCsv([
        { no: "X1", time: "2026-02-29 10:00:00" },
        { no: "X2", time: "2026-11-02 24:00:00" },
        { no: "X3", time: "02/11/2026 10:00" },
        { no: "X4", time: "2026-11-02 10:00:00 CST" },
        { no: "X5", time: "45963.42" },
        { no: "X6", time: "2026-11-02T10:00:00+08" },
      ]),
    );
    expect(r.summary).toMatchObject({ new: 0, error: 6 });
  });
});

describe("red team: belopp", () => {
  it("flyttalsfällor och tusentalsavgränsare ger exakta ören", async () => {
    const f = await setupImportOrg();
    const cases: Array<[string, number]> = [
      ["Amount: 0.10", 10],
      ["Amount: 0.20", 20],
      ["Amount: 19.99", 1999],
      ["Amount: 1.15", 115],
      ["Amount: 4.35", 435],
      ["Amount: 1,234.56", 123456],
      ["Amount: 1.234,56", 123456],
      ["Amount: 1 234,56", 123456],
      ["SEK 1 234,56", 123456],
      ["Amount: 9999999.99", 999999999],
    ];
    const r = await f.run(
      awishCsv(cases.map(([amount], i) => ({ no: `F${i}`, time: "2026-11-02 10:00:00", amount }))),
    );
    expect(r.summary).toMatchObject({ new: cases.length, error: 0 });
    const orders = await ordersOf(f.orgId);
    for (const [i, [, ore]] of cases.entries()) {
      expect(orders.find((o) => o.external_id === `F${i}`)?.amount_ore).toBe(String(ore));
    }
    const sum = await one<{ s: string }>(
      db(),
      sql`select sum(amount_ore)::text as s from public.orders where organization_id = ${f.orgId}`,
    );
    expect(sum.s).toBe(String(cases.reduce((a, [, o]) => a + o, 0)));
  });

  it("andra valutor, tvetydiga och negativa belopp blir felrader", async () => {
    const f = await setupImportOrg();
    const bad = [
      "$170",
      "€170",
      "¥170",
      "CNY 170",
      "170 RMB",
      "1,234",
      "1.234",
      "-170",
      "(170)",
      "1.005",
      "1e2",
      "170.00.00",
      "Amount: ",
      "１７０",
    ];
    const r = await f.run(
      awishCsv(bad.map((amount, i) => ({ no: `B${i}`, time: "2026-11-02 10:00:00", amount }))),
    );
    expect(r.summary).toMatchObject({ new: 0, error: bad.length });
  });

  it("en cell med flera märkta belopp ger beloppet märkt exakt Amount:/Order Amount:, inte Discount/Refund/Paid Amount", () => {
    expect(parseAmountOre("Discount Amount: 20.00\nAmount: 170.00")).toEqual({
      ok: true,
      ore: 17000,
    });
    expect(parseAmountOre("Refund Amount: 0.00\nOrder Amount: 170.00")).toEqual({
      ok: true,
      ore: 17000,
    });
    expect(parseAmountOre("Paid Amount: 160.00\nAmount: 170.00")).toEqual({ ok: true, ore: 17000 });
  });

  it("end-to-end: Discount Amount före Amount sparar inte rabatten som orderbelopp", async () => {
    const f = await setupImportOrg();
    await f.run(
      awishCsv([
        { no: "L1", time: "2026-11-02 10:00:00", amount: "Discount Amount: 20.00\nAmount: 170.00" },
        {
          no: "L2",
          time: "2026-11-02 10:01:00",
          amount: "Refund Amount: 0.00\nOrder Amount: 170.00",
        },
      ]),
    );
    const orders = await ordersOf(f.orgId);
    // Antingen rätt belopp eller en felrad – aldrig 20 kr eller 0 kr.
    for (const o of orders) {
      expect(o.amount_ore).toBe("17000");
    }
  });
});

describe("red team: samtidighet", () => {
  it("två datakällor i samma organisation importerar samma nya titel samtidigt: en titel, ett alias", async () => {
    const f = await setupImportOrg();
    const second = await addCsvSource(f, "Awish orderlista 2");
    const file = (prefix: string, name: string): string =>
      awishCsv(
        Array.from({ length: 30 }, (_, i) => ({
          no: `${prefix}${i}`,
          time: "2026-11-02 10:00:00",
          name,
        })),
      );
    const results = await Promise.all([
      f.run(file("A", "Helt Ny Titel 151")),
      runImport(db(), {
        organizationId: f.orgId,
        dataSourceId: second,
        actorUserId: f.admin.id,
        file: { name: "b.csv", content: file("B", "helt  ny titel 151") },
        dryRun: false,
        fileStore: f.fileStore,
      }),
      f.run(file("C", "HELT NY TITEL 151")),
    ]);
    expect(results.reduce((s, r) => s + r.summary.new, 0)).toBe(90);
    expect(await countIn("titles", f.orgId)).toBe(1);
    expect(await countIn("title_aliases", f.orgId)).toBe(1);
    const distinct = await one<{ n: number }>(
      db(),
      sql`select count(distinct title_id)::int as n from public.orders where organization_id = ${f.orgId}`,
    );
    expect(distinct.n).toBe(1);
  });

  it("förhandsvisning samtidigt med import skriver inget och påverkar inte importen", async () => {
    const f = await setupImportOrg();
    const csv = awishCsv(
      Array.from({ length: 25 }, (_, i) => ({ no: `C${i}`, time: "2026-11-02 10:00:00" })),
    );
    const [preview, real] = await Promise.all([f.run(csv, { dryRun: true }), f.run(csv)]);
    expect(preview.importId).toBeNull();
    expect(real.summary.new).toBe(25);
    expect(await countIn("imports", f.orgId)).toBe(1);
    expect(await countIn("orders", f.orgId)).toBe(25);
  });
});

describe("red team: behörighet", () => {
  it("en admin som tagits bort ur organisationen nekas direkt", async () => {
    const f = await setupImportOrg();
    await asPostgres((tx) =>
      tx.execute(
        sql`delete from public.memberships where organization_id = ${f.orgId} and user_id = ${f.admin.id}`,
      ),
    );
    for (const dryRun of [true, false]) {
      await expect(
        f.run(awishCsv([{ no: "R1", time: "2026-11-02 10:00:00" }]), { user: f.admin, dryRun }),
      ).rejects.toBeInstanceOf(ImportForbiddenError);
    }
    expect(await countIn("orders", f.orgId)).toBe(0);
  });

  it("ett okänt användar-id (ingen användare) nekas", async () => {
    const f = await setupImportOrg();
    await expect(
      runImport(db(), {
        organizationId: f.orgId,
        dataSourceId: f.dataSourceId,
        actorUserId: "00000000-0000-4000-8000-000000000000",
        file: { name: "x.csv", content: awishCsv([{ no: "R2", time: "2026-11-02 10:00:00" }]) },
        dryRun: false,
        fileStore: f.fileStore,
      }),
    ).rejects.toBeInstanceOf(ImportForbiddenError);
  });

  it("ägare i en annan organisation kan inte skriva över mappningen på datakällan via import", async () => {
    const f = await setupImportOrg();
    const outsider = await createUser();
    await expect(
      f.run(awishCsv([{ no: "R3", time: "2026-11-02 10:00:00" }]), {
        user: outsider,
        mapping: { columns: { paymentMethod: null } },
      }),
    ).rejects.toBeInstanceOf(ImportForbiddenError);
    const ds = await one<{ config: Record<string, unknown> }>(
      db(),
      sql`select config from public.data_sources where id = ${f.dataSourceId}`,
    );
    expect(ds.config.csvMapping).toBeUndefined();
  });
});
