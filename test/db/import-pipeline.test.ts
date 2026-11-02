/**
 * Importen av Awish-CSV mot databasen, som ägaren med RLS: förhandsvisning,
 * import, dubbletter, överlapp, konflikter, ej betalda, felrader, titlar via
 * alias, automater via source_machines och importloggen.
 */

import { existsSync } from "node:fs";
import path from "node:path";

import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { notPaidOf } from "../../src/import/run-import";
import { asUser, db, one, rows } from "./helpers";
import {
  awishCsv,
  countIn,
  fixture,
  mapMachine,
  ordersOf,
  setupImportOrg,
} from "./import-fixtures";

interface ImportRowLog extends Record<string, unknown> {
  row_number: number;
  status: string;
  message: string | null;
  order_id: string | null;
  raw: Record<string, string>;
}

function importRowsOf(importId: string): Promise<ImportRowLog[]> {
  return rows<ImportRowLog>(
    db(),
    sql`select row_number, status::text as status, message, order_id, raw
        from public.import_rows where import_id = ${importId} order by row_number`,
  );
}

describe("förhandsvisning (dryRun)", () => {
  it("visar klassning, svensk tid, okända titlar och automater utan att skriva något", async () => {
    const f = await setupImportOrg();
    const r = await f.run(fixture("orderlista-2026-11-02.csv"), { dryRun: true });

    expect(r.dryRun).toBe(true);
    expect(r.importId).toBeNull();
    expect(r.summary).toEqual({
      total: 6,
      new: 3,
      duplicate: 0,
      conflict: 0,
      error: 2,
      notPaid: 1,
      lateInClosedPeriod: 0,
    });
    expect(r.rows.map((x) => [x.rowNumber, x.status])).toEqual([
      [2, "new"],
      [3, "new"],
      [4, "not_paid"],
      [6, "new"],
      [7, "error"],
      [8, "error"],
    ]);
    expect(r.rows[0]).toMatchObject({
      externalId: "42780",
      orderedAt: "2026-11-01T16:17:00.000Z",
      orderedAtLocal: "2026-11-01 17:17:00",
      businessDate: "2026-11-01",
      titleKnown: false,
      machineMapped: false,
    });
    expect(r.firstRow).toEqual({
      rowNumber: 2,
      externalId: "42780",
      sourceTimezone: "Asia/Shanghai",
      sourceLocal: "2026-11-02 00:17:00",
      utc: "2026-11-01T16:17:00.000Z",
      organizationTimezone: "Europe/Stockholm",
      organizationLocal: "2026-11-01 17:17:00",
      businessDate: "2026-11-01",
    });
    // "Surging Sparks" med extra mellanslag är samma titel (normaliserat namn).
    expect(r.newTitles.map((t) => [t.name, t.rows])).toEqual([
      ["Pokémon TCG: Surging Sparks Booster", 2],
      ["Pokémon TCG: Prismatic Evolutions Booster", 1],
    ]);
    expect(r.unknownMachines.map((m) => [m.externalId, m.rows, m.queued])).toEqual([
      ["BL-001 ICA Lund", 2, false],
      ["BL-002 Coop Malmö", 1, false],
    ]);
    expect(r.warnings.map((w) => w.code)).toEqual(["errors", "new_titles", "unknown_machines"]);

    for (const table of [
      "orders",
      "imports",
      "import_rows",
      "titles",
      "title_aliases",
      "source_machines",
    ]) {
      expect(await countIn(table, f.orgId)).toBe(0);
    }
  });
});

describe("import", () => {
  it("sparar betalda order, skapar titel + alias och lägger okända automater i kön", async () => {
    const f = await setupImportOrg();
    const r = await f.run(fixture("orderlista-2026-11-02.csv"), { name: "Orderlista nov.csv" });

    expect(r.importId).toEqual(expect.any(String));
    expect(r.summary).toMatchObject({
      total: 6,
      new: 3,
      duplicate: 0,
      conflict: 0,
      error: 2,
      notPaid: 1,
    });

    const orders = await ordersOf(f.orgId);
    expect(orders.map((o) => [o.external_id, o.amount_ore, o.ordered_at, o.business_date])).toEqual(
      [
        ["42780", "17000", "2026-11-01T16:17:00Z", "2026-11-01"],
        ["42781", "18900", "2026-11-01T17:05:30Z", "2026-11-01"],
        ["42783", "17000", "2026-11-01T19:10:20Z", "2026-11-01"],
      ],
    );
    // Ej betald (42782) och felrader (42784, 42785) sparas inte som order.
    expect(orders.every((o) => o.import_id === r.importId)).toBe(true);
    expect(orders.every((o) => o.machine_id === null && o.source_machine_id !== null)).toBe(true);
    // raw_title ändras aldrig, inte ens dubbla mellanslag.
    expect(orders.find((o) => o.external_id === "42783")?.raw_title).toBe(
      "Pokémon TCG:  Surging   Sparks Booster",
    );

    // Titlar och alias: två nya titlar, båda Surging Sparks-orderna på samma.
    const titles = await rows<{ id: string; name: string; alias: string }>(
      db(),
      sql`select t.id, t.name, a.alias from public.titles t
          join public.title_aliases a on a.title_id = t.id
          where t.organization_id = ${f.orgId} order by t.name`,
    );
    expect(titles.map((t) => [t.name, t.alias])).toEqual([
      ["Pokémon TCG: Prismatic Evolutions Booster", "Pokémon TCG: Prismatic Evolutions Booster"],
      ["Pokémon TCG: Surging Sparks Booster", "Pokémon TCG: Surging Sparks Booster"],
    ]);
    const surging = titles.find((t) => t.name.includes("Surging"))!.id;
    expect(orders.filter((o) => o.title_id === surging).map((o) => o.external_id)).toEqual([
      "42780",
      "42783",
    ]);
    expect(r.newTitles.every((t) => t.createdTitle === true && t.titleId)).toBe(true);

    // Okända automater: rader i source_machines utan automat (kön).
    const queue = await rows<{ external_id: string; machine_id: string | null }>(
      db(),
      sql`select external_id, machine_id from public.source_machines
          where organization_id = ${f.orgId} order by external_id`,
    );
    expect(queue).toEqual([
      { external_id: "BL-001 ICA Lund", machine_id: null },
      { external_id: "BL-002 Coop Malmö", machine_id: null },
    ]);

    // Importen: sammanfattning, mappning, parserversion, fil.
    const imp = await one<{
      file_name: string;
      file_sha256: string;
      storage_path: string;
      parser_version: string;
      mapping: { columns: Record<string, string | null>; delimiter: string };
      rows_total: number;
      rows_new: number;
      rows_duplicate: number;
      rows_conflict: number;
      rows_error: number;
      status: string;
      started_at: string;
      finished_at: string;
      trigger: string;
      created_by: string;
    }>(db(), sql`select * from public.imports where id = ${r.importId}`);
    expect(imp).toMatchObject({
      file_name: "Orderlista nov.csv",
      file_sha256: r.file.sha256,
      storage_path: `${f.orgId}/${f.dataSourceId}/${r.file.sha256}.csv`,
      parser_version: "awish_csv/1+pipeline/1",
      rows_total: 6,
      rows_new: 3,
      rows_duplicate: 0,
      rows_conflict: 0,
      rows_error: 2,
      status: "succeeded",
      trigger: "upload",
      created_by: f.owner.id,
    });
    expect(imp.mapping.columns).toMatchObject({ externalId: "Order No.", amount: "Order Amount" });
    expect(imp.mapping.delimiter).toBe(",");
    expect(new Date(imp.finished_at).getTime()).toBeGreaterThanOrEqual(
      new Date(imp.started_at).getTime(),
    );
    expect(
      notPaidOf({
        rowsTotal: imp.rows_total,
        rowsNew: imp.rows_new,
        rowsDuplicate: imp.rows_duplicate,
        rowsConflict: imp.rows_conflict,
        rowsError: imp.rows_error,
      }),
    ).toBe(1);
    expect(existsSync(path.join(f.fileStore.root, ...imp.storage_path.split("/")))).toBe(true);

    // Importloggen: bara new och error (ej betalda och dubbletter loggas inte rad för rad).
    const log = await importRowsOf(r.importId!);
    expect(log.map((l) => [l.row_number, l.status])).toEqual([
      [2, "new"],
      [3, "new"],
      [6, "new"],
      [7, "error"],
      [8, "error"],
    ]);
    expect(log[0]?.order_id).toBe(orders[0]?.id);
    expect(log[0]?.raw["Order No."]).toBe("42780");
    expect(log[3]?.message).toContain('"Amount: abc"');
    expect(log[4]?.message).toContain("2026-13-02");
    expect(log[3]?.order_id).toBeNull();
  });

  it("samma fil två gånger ger 0 nya, en varning och inga nya loggrader för dubbletter", async () => {
    const f = await setupImportOrg();
    const first = await f.run(fixture("orderlista-2026-11-02.csv"));
    const preview = await f.run(fixture("orderlista-2026-11-02.csv"), { dryRun: true });
    expect(preview.warnings[0]?.code).toBe("duplicate_file");
    expect(preview.previousImports.map((p) => p.id)).toEqual([first.importId]);

    const second = await f.run(fixture("orderlista-2026-11-02.csv"));
    expect(second.summary).toMatchObject({
      total: 6,
      new: 0,
      duplicate: 3,
      conflict: 0,
      error: 2,
      notPaid: 1,
    });
    expect(second.warnings.map((w) => w.code)).toContain("duplicate_file");
    expect(second.newTitles).toEqual([]);
    expect(second.unknownMachines.map((m) => m.queued)).toEqual([]);
    expect(await countIn("orders", f.orgId)).toBe(3);
    expect(await countIn("titles", f.orgId)).toBe(2);
    expect((await importRowsOf(second.importId!)).map((l) => l.status)).toEqual(["error", "error"]);
    // Dubbletterna pekar på de befintliga orderna i resultatet.
    const orders = await ordersOf(f.orgId);
    expect(second.rows.filter((x) => x.status === "duplicate").map((x) => x.orderId)).toEqual(
      orders.map((o) => o.id),
    );
  });

  it("överlappande filer: bara det som är nytt sparas", async () => {
    const f = await setupImportOrg();
    await f.run(fixture("orderlista-2026-11-02.csv"));
    const r = await f.run(fixture("orderlista-overlapp.csv"));
    expect(r.summary).toMatchObject({
      total: 3,
      new: 2,
      duplicate: 1,
      conflict: 0,
      error: 0,
      notPaid: 0,
    });
    expect(r.rows.map((x) => [x.externalId, x.status])).toEqual([
      ["42781", "duplicate"],
      ["42786", "new"],
      ["42787", "new"],
    ]);
    expect(r.newTitles.map((t) => t.name)).toEqual(["Pokémon TCG: Stellar Crown; Booster"]);
    expect(r.unknownMachines.map((m) => m.externalId)).toEqual([
      "BL-001 ICA Lund",
      "BL-003 Hemköp Ystad",
    ]);
    expect(r.unknownMachines[0]?.queued).toBe(true);
    expect((await ordersOf(f.orgId)).map((o) => o.external_id)).toEqual([
      "42780",
      "42781",
      "42783",
      "42786",
      "42787",
    ]);
    expect(await countIn("titles", f.orgId)).toBe(3);
  });

  it("avvikande belopp på befintligt ordernummer blir konflikt och ordern ändras inte", async () => {
    const f = await setupImportOrg();
    await f.run(fixture("orderlista-2026-11-02.csv"));
    const before = (await ordersOf(f.orgId)).find((o) => o.external_id === "42780")!;

    const r = await f.run(fixture("orderlista-avvikande-belopp.csv"));
    expect(r.summary).toMatchObject({ total: 1, new: 0, duplicate: 0, conflict: 1 });
    expect(r.warnings.map((w) => w.code)).toContain("conflicts");

    const after = (await ordersOf(f.orgId)).find((o) => o.external_id === "42780")!;
    expect(after).toEqual(before);
    expect(after.amount_ore).toBe("17000");

    const log = await importRowsOf(r.importId!);
    expect(log).toHaveLength(1);
    expect(log[0]).toMatchObject({ row_number: 2, status: "conflict", order_id: before.id });
    expect(log[0]?.message).toContain("belopp 170,00 kr → 180,00 kr");
    expect(log[0]?.raw["Order Amount"]).toBe("Amount: 180.00");
  });

  it("samma ordernummer två gånger i samma fil: dubblett eller konflikt mot den första raden", async () => {
    const f = await setupImportOrg();
    const r = await f.run(
      awishCsv([
        { no: "1", time: "2026-11-02 10:00:00" },
        { no: "1", time: "2026-11-02 10:00:00", amount: "170,00" },
        { no: "1", time: "2026-11-02 10:00:00", amount: "Amount: 99.00" },
      ]),
    );
    expect(r.rows.map((x) => x.status)).toEqual(["new", "duplicate", "conflict"]);
    expect(r.rows[2]?.message).toContain("rad 2 i samma fil");
    const orders = await ordersOf(f.orgId);
    expect(orders).toHaveLength(1);
    expect(r.rows.map((x) => x.orderId)).toEqual([orders[0]!.id, orders[0]!.id, orders[0]!.id]);
    expect(
      (await importRowsOf(r.importId!)).map((l) => [l.row_number, l.status, l.order_id]),
    ).toEqual([
      [2, "new", orders[0]!.id],
      [4, "conflict", orders[0]!.id],
    ]);
  });

  it("känd titel hittas via normaliserat alias, även efter sammanslagning", async () => {
    const f = await setupImportOrg();
    const { canonical } = await asUser(f.owner, async (tx) => {
      const canonical = await one<{ id: string }>(
        tx,
        sql`insert into public.titles (organization_id, name) values (${f.orgId}, 'Surging Sparks') returning id`,
      );
      const old = await one<{ id: string }>(
        tx,
        sql`insert into public.titles (organization_id, name) values (${f.orgId}, 'Prismatic (gammal)') returning id`,
      );
      await tx.execute(
        sql`insert into public.title_aliases (organization_id, title_id, alias) values
              (${f.orgId}, ${canonical.id}, 'POKÉMON TCG: SURGING SPARKS BOOSTER'),
              (${f.orgId}, ${old.id}, 'Pokémon TCG: Prismatic Evolutions Booster')`,
      );
      await tx.execute(sql`select public.merge_titles(${f.orgId}, ${old.id}, ${canonical.id})`);
      return { canonical: canonical.id };
    });

    const r = await f.run(fixture("orderlista-2026-11-02.csv"));
    expect(r.newTitles).toEqual([]);
    expect(r.rows.filter((x) => x.status === "new").every((x) => x.titleKnown)).toBe(true);
    const orders = await ordersOf(f.orgId);
    expect(orders.every((o) => o.title_id === canonical)).toBe(true);
    expect(await countIn("titles", f.orgId)).toBe(2);
  });

  it("en aktiv titel med samma namn men utan alias får aliaset i stället för en dubblett", async () => {
    const f = await setupImportOrg();
    const existing = await asUser(f.owner, (tx) =>
      one<{ id: string }>(
        tx,
        sql`insert into public.titles (organization_id, name)
            values (${f.orgId}, 'pokémon tcg: surging sparks booster') returning id`,
      ),
    );
    const r = await f.run(awishCsv([{ no: "1", time: "2026-11-02 10:00:00" }]));
    expect(r.newTitles).toMatchObject([{ createdTitle: false, titleId: existing.id }]);
    expect((await ordersOf(f.orgId))[0]?.title_id).toBe(existing.id);
    expect(await countIn("titles", f.orgId)).toBe(1);
    expect(await countIn("title_aliases", f.orgId)).toBe(1);
  });

  it("kopplad automat: ordern får automaten och försäljningen blir en lagerhändelse", async () => {
    const f = await setupImportOrg();
    const machineId = await mapMachine(f, "BL-001 ICA Lund", "BL-001");
    const r = await f.run(fixture("orderlista-2026-11-02.csv"));
    expect(r.unknownMachines.map((m) => m.externalId)).toEqual(["BL-002 Coop Malmö"]);
    expect(r.rows.find((x) => x.externalId === "42780")?.machineMapped).toBe(true);

    const orders = await ordersOf(f.orgId);
    expect(orders.map((o) => [o.external_id, o.machine_id])).toEqual([
      ["42780", machineId],
      ["42781", machineId],
      ["42783", null],
    ]);
    const sales = await rows<{ order_id: string; quantity: number }>(
      db(),
      sql`select order_id, quantity from public.stock_events
          where organization_id = ${f.orgId} and kind = 'sale' order by order_id`,
    );
    expect(sales.map((s) => s.order_id).sort()).toEqual([orders[0]!.id, orders[1]!.id].sort());
    expect(sales.every((s) => s.quantity === -1)).toBe(true);

    // När den okända automaten kopplas får dess order automaten (och lagerhändelsen).
    const second = await mapMachine(f, "BL-002 Coop Malmö", "BL-002");
    expect((await ordersOf(f.orgId)).find((o) => o.external_id === "42783")?.machine_id).toBe(
      second,
    );
  });

  it("överstyrd mappning sparas i imports.mapping och på datakällan för nästa fil", async () => {
    const f = await setupImportOrg();
    const text =
      "Kvitto;Produkt;Automat;Belopp;Betald;Tidpunkt\n" +
      "A1;Surging Sparks;BL-001;170,00;Ja;2026-11-02 10:00\n" +
      "A2;Surging Sparks;BL-001;170,00;Nej;2026-11-02 10:05\n";
    const r = await f.run(text, {
      mapping: { columns: { externalId: "Kvitto", paidAt: "Tidpunkt" } },
    });
    expect(r.summary).toMatchObject({ new: 1, notPaid: 1 });
    const imp = await one<{
      mapping: { columns: Record<string, string>; source: Record<string, string> };
    }>(db(), sql`select mapping from public.imports where id = ${r.importId}`);
    expect(imp.mapping.columns).toMatchObject({
      externalId: "Kvitto",
      paidAt: "Tidpunkt",
      amount: "Belopp",
    });
    expect(imp.mapping.source).toMatchObject({ externalId: "override", amount: "auto" });

    const next = await f.run(text.replace("A1", "A3"), { dryRun: true });
    expect((next.mapping as { source: Record<string, string> }).source.externalId).toBe("saved");
    expect(next.summary).toMatchObject({ new: 1, notPaid: 1 });
  });

  it("order i en stängd månad sparas men flaggas", async () => {
    const f = await setupImportOrg();
    await asUser(f.owner, (tx) =>
      tx.execute(sql`select public.close_period(${f.orgId}, '2026-09-01')`),
    );
    const r = await f.run(
      awishCsv([
        { no: "S1", time: "2026-09-15 12:00:00" },
        { no: "S2", time: "2026-10-15 12:00:00" },
      ]),
    );
    expect(r.summary).toMatchObject({ new: 2, lateInClosedPeriod: 1 });
    expect(r.warnings.map((w) => w.code)).toContain("late_in_closed_period");
    const orders = await ordersOf(f.orgId);
    expect(orders.map((o) => [o.external_id, o.late_in_closed_period])).toEqual([
      ["S1", true],
      ["S2", false],
    ]);
  });

  it("filen sparas en gång per innehåll (samma sökväg vid ny uppladdning)", async () => {
    const f = await setupImportOrg();
    const a = await f.run(fixture("orderlista-overlapp.csv"));
    const b = await f.run(fixture("orderlista-overlapp.csv"));
    expect(a.file.storagePath).toBe(b.file.storagePath);
    const stored = await f.fileStore.get(a.file.storagePath!);
    expect(Buffer.from(stored).equals(Buffer.from(fixture("orderlista-overlapp.csv")))).toBe(true);
  });
});
