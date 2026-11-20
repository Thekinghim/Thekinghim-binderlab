/**
 * Ekonomi (fas 9) mot testdatabasen: import av utbetalningar, avstämning med avsiktliga
 * avvikelser från början till slut, utredning (logg), fasta kostnader, bokföring och SIE,
 * kassaflöde och avtal med fil. Behörighet: ägare/admin skriver, läsaren läser, påfyllaren
 * får ingenting (varken via tjänsterna eller via RLS).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as s from "@/db/schema";
import { LocalFileStore } from "@/import/file-store";
import { AuthorizationError, listOrganizationsFor, type SessionUser } from "@/server/access";
import {
  archiveContractFor,
  archiveFixedCostFor,
  archivePayoutFor,
  attachContractFileFor,
  deliverVouchersFor,
  importPayoutFileFor,
  loadBookkeepingFor,
  loadCashflowFor,
  loadContractsFor,
  loadFixedCostsFor,
  loadReconciliationFor,
  readContractFileFor,
  reviewDeviationFor,
  saveContractFor,
  saveFixedCostFor,
  sieFileFor,
} from "@/server/accounting/service";
import type { Viewer } from "@/server/data/core/loaders";

import {
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  rows,
  settle,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const APRIL = { start: "2025-04-01", end: "2025-04-30" };

function sessionUser(u: TestUser): SessionUser {
  return { userId: u.id, email: u.email };
}

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = sessionUser(u);
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

const csv = (lines: string[]) => new TextEncoder().encode(lines.join("\r\n") + "\r\n");

/** Det testerna behöver: en organisation med butik, automat, titel, pris, källa och import. */
interface Fixture {
  orgId: string;
  owner: TestUser;
  storeId: string;
  agreementId: string;
  machineId: string;
  titleId: string;
  dataSourceId: string;
  sourceMachineId: string;
  importId: string;
}

/**
 * Egen fixtur (oberoende av seedTenantFixture): butik med provision 10 %, automat placerad
 * där, en titel med inköpspris, en Awish-källa (Asia/Shanghai), en import, och december 2024
 * stängd.
 */
async function seedEconomyFixture(): Promise<Fixture> {
  const owner = await createUser(`agare-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(owner, `Ekonomi ${uniqueSuffix()}`);
  return asUser(owner, async (tx) => {
    const org = { organizationId: orgId };
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: "Testbutik" })
      .returning();
    const [agreement] = await tx
      .insert(s.storeAgreements)
      .values({ ...org, storeId: store!.id, validFrom: "2025-01-01", commissionBp: 1000 })
      .returning();
    const [machine] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-001", name: "Automat 1", activeFrom: "2025-01-01" })
      .returning();
    await tx
      .insert(s.machinePlacements)
      .values({ ...org, machineId: machine!.id, storeId: store!.id, validFrom: "2025-01-01" });
    const [title] = await tx
      .insert(s.titles)
      .values({ ...org, name: "Pokémon 151" })
      .returning();
    await tx
      .insert(s.purchasePrices)
      .values({ ...org, titleId: title!.id, unitCostOre: 2000, validFrom: "2025-01-01" });
    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish CSV" })
      .returning();
    const [sourceMachine] = await tx
      .insert(s.sourceMachines)
      .values({
        ...org,
        dataSourceId: source!.id,
        externalId: "AW-1",
        externalName: "Order Machine 1",
        machineId: machine!.id,
      })
      .returning();
    const [imp] = await tx
      .insert(s.imports)
      .values({
        ...org,
        dataSourceId: source!.id,
        trigger: "upload",
        fileName: "orders.csv",
        fileSha256: "a".repeat(64),
        storagePath: `${orgId}/imports/orders.csv`,
        parserVersion: "awish-csv@1",
        status: "succeeded",
      })
      .returning();
    await tx.execute(sql`select public.close_period(${orgId}, '2024-12-01'::date)`);
    return {
      orgId,
      owner,
      storeId: store!.id,
      agreementId: agreement!.id,
      machineId: machine!.id,
      titleId: title!.id,
      dataSourceId: source!.id,
      sourceMachineId: sourceMachine!.id,
      importId: imp!.id,
    };
  });
}

function order(fx: Fixture, externalId: string, orderedAt: string, amountOre = 4900) {
  return {
    organizationId: fx.orgId,
    dataSourceId: fx.dataSourceId,
    externalId,
    rawTitle: "Pokemon 151",
    titleId: fx.titleId,
    orderedAt: new Date(orderedAt),
    amountOre,
    sourceMachineId: fx.sourceMachineId,
    machineId: fx.machineId,
    importId: fx.importId,
    sourceHash: `h-${externalId}`,
  };
}

let fx: Fixture;
let owner: Viewer;
let viewer: Viewer;
let refiller: Viewer;
let storeDir: string | undefined;
let files: LocalFileStore;

beforeAll(async () => {
  fx = await seedEconomyFixture();
  owner = await viewerFor(fx.owner, fx.orgId);
  viewer = await viewerFor(await createMember(fx.orgId, "viewer"), fx.orgId);
  refiller = await viewerFor(await createMember(fx.orgId, "refiller"), fx.orgId);
  storeDir = await mkdtemp(path.join(tmpdir(), "binderlab-ekonomi-"));
  files = new LocalFileStore(storeDir);

  // Tio order à 49,00 kr 1–10 april (en per dag, mitt på dagen svensk tid), och kontoplanen.
  await asUser(fx.owner, async (tx) => {
    await tx
      .insert(s.orders)
      .values(
        Array.from({ length: 10 }, (_, i) =>
          order(fx, String(50001 + i), `2025-04-${String(i + 1).padStart(2, "0")}T10:00:00Z`),
        ),
      );
    await tx.insert(s.ledgerAccounts).values(
      [
        ["sales", "3004", "Försäljning"],
        ["settlement", "1580", "Fordran på kortinlösen"],
        ["store_commission", "6050", "Provision"],
        ["rent", "5010", "Lokalhyra"],
        ["store_payable", "2440", "Leverantörsskulder"],
        ["cogs", "4010", "Inköp"],
        ["inventory", "1460", "Lager"],
        // Inget bankkonto: utbetalningarna bokförs då på BAS 1930 (och det flaggas).
        ["card_fees", "6040", "Kontokortsavgifter"],
      ].map(([key, basAccount, name]) => ({
        organizationId: fx.orgId,
        key: key!,
        basAccount: basAccount!,
        name: name!,
      })),
    );
  });
});

afterAll(async () => {
  if (storeDir) await rm(storeDir, { recursive: true, force: true });
});

describe("avstämning med avsiktliga avvikelser (från fil till utredd)", () => {
  // Försäljning 49 000. Leverantören drog 5,00 kr i avgift och betalade inte för 2 order:
  // 8 × 4 900 − 500 = 38 700.
  const payoutFile = csv([
    "Referens;Period från;Period till;Utbetald;Belopp;Avgifter",
    "U-APR-1;2025-04-01;2025-04-10;2025-04-15;387,00;5,00",
  ]);

  it("importerar utbetalningen och räknar dubbletter och konflikter", async () => {
    const first = await importPayoutFileFor(
      owner,
      { name: "apr.csv", bytes: payoutFile },
      { fileStore: files },
    );
    expect(first).toMatchObject({
      format: "payouts",
      rowsNew: 1,
      rowsDuplicate: 0,
      rowsConflict: 0,
    });
    expect(first.period).toEqual({ start: "2025-04-01", end: "2025-04-10" });

    const again = await importPayoutFileFor(
      owner,
      { name: "apr.csv", bytes: payoutFile },
      { fileStore: files },
    );
    expect(again).toMatchObject({ rowsNew: 0, rowsDuplicate: 1, rowsConflict: 0 });

    const changed = await importPayoutFileFor(
      owner,
      {
        name: "apr-ändrad.csv",
        bytes: csv([
          "Referens;Period från;Period till;Utbetald;Belopp;Avgifter",
          "U-APR-1;2025-04-01;2025-04-10;2025-04-15;390,00;5,00",
          "U-TRASIG;2025-04-11;2025-04-01;2025-04-15;1,00;0",
        ]),
      },
      { fileStore: files },
    );
    expect(changed).toMatchObject({ rowsNew: 0, rowsConflict: 1, rowsError: 1 });
    expect(changed.messages.join(" ")).toMatch(/U-APR-1 finns redan/);
  });

  it("utan specifikation: avgiften och två saknade order härleds ur beloppen", async () => {
    const view = await loadReconciliationFor(owner, APRIL);
    const r = view.result!;
    expect(r.payouts).toHaveLength(1);
    const p = r.payouts[0]!;
    expect(p.expected).toMatchObject({
      orders: 10,
      salesOre: 49_000,
      feesOre: 0,
      payoutOre: 49_000,
    });
    expect(p.actual.payoutOre).toBe(38_700);
    expect(p.differenceOre).toBe(-10_300);
    expect(p.status).toBe("deviation");
    const byKind = new Map(p.deviations.map((d) => [d.kind, d]));
    expect(byKind.get("fee")?.impactOre).toBe(-500);
    const missing = byKind.get("missing-in-payout")!;
    expect(missing.impactOre).toBe(-9_800);
    expect(missing.confidence).toBe("inferred");
    expect(missing.orderCount).toBe(2);
    // Avvikelserna summerar till skillnaden (plus avrundning inom toleransen).
    expect(p.deviations.reduce((sum, d) => sum + d.impactOre, 0) + p.roundingOre).toBe(
      p.differenceOre,
    );
    expect(r.totals.openDeviations).toBe(2);
  });

  it("med specifikation per order: de två saknade orderna pekas ut", async () => {
    const lines = csv([
      "Referens;Ordernummer;Belopp",
      ...[50001, 50002, 50004, 50005, 50006, 50008, 50009, 50010].map((n) => `U-APR-1;${n};49,00`),
      "U-FINNS-INTE;50003;49,00",
    ]);
    const res = await importPayoutFileFor(
      owner,
      { name: "spec.csv", bytes: lines },
      { fileStore: files },
    );
    expect(res).toMatchObject({ format: "lines", rowsNew: 8, rowsError: 1 });

    const view = await loadReconciliationFor(owner, APRIL);
    const p = view.result!.payouts[0]!;
    const missing = p.deviations.find((d) => d.kind === "missing-in-payout")!;
    expect(missing.confidence).toBe("confirmed");
    expect(missing.orderCount).toBe(2);
    expect(missing.evidence.orderIds).toHaveLength(2);
    expect(view.payouts[0]!.lineCount).toBe(8);
  });

  it("utredd avvikelse loggas, och payouts status följer", async () => {
    const before = await loadReconciliationFor(owner, APRIL);
    const fee = before.result!.payouts[0]!.deviations.find((d) => d.kind === "fee")!;
    const missing = before.result!.payouts[0]!.deviations.find(
      (d) => d.kind === "missing-in-payout",
    )!;

    // Läsaren och påfyllaren får inte utreda.
    await expect(
      reviewDeviationFor(viewer, {
        period: APRIL,
        key: fee.key,
        action: "investigated",
        note: "x",
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    // En nyckel som inte finns nekas.
    await expect(
      reviewDeviationFor(owner, {
        period: APRIL,
        key: "U-APR-1:påhittad",
        action: "investigated",
        note: "x",
      }),
    ).rejects.toThrow(/finns inte längre/);

    await reviewDeviationFor(owner, {
      period: APRIL,
      key: fee.key,
      action: "investigated",
      note: "Awish tar 5 kr per utbetalning. Kortavgiften i inställningarna ska ändras.",
    });
    await reviewDeviationFor(owner, {
      period: APRIL,
      key: missing.key,
      action: "investigated",
      note: "Order 50003 och 50007 betalas ut i maj enligt Awish.",
    });
    const after = await loadReconciliationFor(owner, APRIL);
    const p = after.result!.payouts[0]!;
    expect(p.status).toBe("investigated");
    expect(after.result!.totals.openDeviations).toBe(0);
    expect(p.deviations.every((d) => d.resolution?.resolvedBy !== undefined)).toBe(true);
    expect(after.reviews.slice(0, 2).map((r) => r.action)).toEqual([
      "investigated",
      "investigated",
    ]);

    // Öppna igen: senaste raden gäller, historiken finns kvar.
    await reviewDeviationFor(owner, {
      period: APRIL,
      key: fee.key,
      action: "reopened",
      note: null,
    });
    const reopened = await loadReconciliationFor(owner, APRIL);
    expect(reopened.result!.totals.openDeviations).toBe(1);
    expect(reopened.reviews.filter((r) => r.deviationKey === fee.key)).toHaveLength(2);

    // Loggen är append-only och utredningen finns i audit_log.
    const audit = await rows<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.audit_log
          where organization_id = ${fx.orgId} and table_name = 'deviation_reviews'`,
    );
    expect(audit[0]!.n).toBeGreaterThanOrEqual(3);
    const outcome = await asUser(fx.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.deviation_reviews set note = 'ändrad' where organization_id = ${fx.orgId}`,
        ),
      ),
    );
    expect(outcome.ok).toBe(false);
  });

  it("en ny order i perioden gör att utredningen inte längre gäller", async () => {
    await asUser(fx.owner, (tx) =>
      tx.insert(s.orders).values(order(fx, "50011", "2025-04-09T12:00:00Z")),
    );
    const view = await loadReconciliationFor(owner, APRIL);
    const missing = view.result!.payouts[0]!.deviations.find(
      (d) => d.kind === "missing-in-payout",
    )!;
    expect(missing.orderCount).toBe(3);
    expect(missing.status).toBe("open");
    expect(view.result!.staleResolutions.length).toBeGreaterThan(0);
  });
});

describe("utbetalningar i databasen", () => {
  it("en utbetalning ändras aldrig men kan arkiveras, och raderas aldrig", async () => {
    await importPayoutFileFor(
      owner,
      {
        name: "maj.csv",
        bytes: csv(["Referens;Period;Utbetald;Belopp;Avgifter", "U-TOM;2025-05;2025-06-05;0,00;0"]),
      },
      { fileStore: files },
    );
    const changeAmount = await asUser(fx.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.payouts set amount_ore = 1 where organization_id = ${fx.orgId}`,
        ),
      ),
    );
    expect(changeAmount.ok).toBe(false);
    const archive = await asUser(fx.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.payouts set archived_at = now() where organization_id = ${fx.orgId} and reference = 'U-TOM'`,
        ),
      ),
    );
    expect(archive.ok).toBe(true);
    const archived = await rows<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.payouts where organization_id = ${fx.orgId} and archived_at is not null`,
    );
    expect(archived[0]!.n).toBe(1);
    const del = await asUser(fx.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`delete from public.payouts where organization_id = ${fx.orgId}`),
      ),
    );
    expect(del.ok).toBe(false);
  });

  it("läsaren ser utbetalningarna men kan inte importera; påfyllaren ser ingenting", async () => {
    const view = await loadReconciliationFor(viewer, APRIL);
    expect(view.payouts.length).toBeGreaterThan(0);
    await expect(
      importPayoutFileFor(viewer, {
        name: "x.csv",
        bytes: csv(["Referens;Period;Belopp", "X;2025-04;1"]),
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(loadReconciliationFor(refiller, APRIL)).rejects.toBeInstanceOf(AuthorizationError);
    const seen = await asUser(
      { id: refiller.user.userId, email: refiller.user.email },
      async (tx) => {
        const counts = await Promise.all(
          [
            "payouts",
            "payout_lines",
            "payout_imports",
            "deviation_reviews",
            "fixed_costs",
            "contracts",
          ].map(
            async (t) =>
              (
                await rows<{ n: number }>(
                  tx,
                  sql`select count(*)::int as n from ${sql.identifier("public")}.${sql.identifier(t)}`,
                )
              )[0]!.n,
          ),
        );
        return counts;
      },
    );
    expect(seen).toEqual([0, 0, 0, 0, 0, 0]);
  });
});

describe("fasta kostnader", () => {
  it("skapas, räknas in i lönsamheten och arkiveras; en stängd månad skyddas", async () => {
    const { id } = await saveFixedCostFor(owner, {
      name: "Programvara",
      category: "software",
      amountOre: 30_000,
      interval: "month",
      startsOn: "2025-04-01",
      endsOn: null,
      machineId: null,
      note: null,
    });
    const view = await loadFixedCostsFor(owner, APRIL, "2025-05-01");
    const accrued = view.allocation!.accrual.byCost.find((c) => c.costId === id)!;
    expect(accrued.accruedOre).toBe(30_000);
    expect(view.allocation!.totals.profitAfterFixedOre).toBe(
      view.allocation!.totals.profitOre - view.allocation!.totals.fixedCostOre,
    );

    // December 2024 är stängd i fixturen.
    const closed = await settle(
      saveFixedCostFor(owner, {
        name: "Bakåt",
        category: "other",
        amountOre: 100,
        interval: "month",
        startsOn: "2024-12-01",
        endsOn: "2024-12-31",
        machineId: null,
        note: null,
      }),
    );
    expect(closed.code).toBe("BL004");
    expect(closed.message).toMatch(/stängd månad/);

    await expect(
      saveFixedCostFor(viewer, {
        name: "Nej",
        category: "other",
        amountOre: 1,
        interval: "month",
        startsOn: "2025-04-01",
        endsOn: null,
        machineId: null,
        note: null,
      }),
    ).rejects.toBeInstanceOf(AuthorizationError);

    await archiveFixedCostFor(owner, { id, archived: true });
    const after = await loadFixedCostsFor(owner, APRIL, "2025-05-01");
    expect(after.costs.find((c) => c.id === id)?.archived).toBe(true);
    expect(after.allocation!.accrual.byCost.some((c) => c.costId === id)).toBe(false);
  });
});

describe("bokföring och SIE", () => {
  it("ger balanserade verifikationer och en SIE 4-fil för månaden", async () => {
    const books = await loadBookkeepingFor(owner, "2025-04", "2025-05-02");
    expect(books.error).toBeNull();
    expect(books.verifications.length).toBeGreaterThan(0);
    for (const v of books.verifications) {
      expect(v.transactions.reduce((sum, t) => sum + t.amountOre, 0)).toBe(0);
    }
    const debit = books.accountTotals.reduce((sum, a) => sum + a.debitOre, 0);
    const credit = books.accountTotals.reduce((sum, a) => sum + a.creditOre, 0);
    expect(debit).toBe(credit);
    const file = await sieFileFor(viewer, "2025-04", "2025-05-02");
    const text = Buffer.from(file.bytes).toString("latin1");
    expect(text.startsWith("#FLAGGA 0")).toBe(true);
    expect(text).toContain("#SIETYP 4");
    await expect(sieFileFor(refiller, "2025-04", "2025-05-02")).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("utbetalningen bokförs: bank och faktiska avgifter mot fordran; kvar står de saknade orderna", async () => {
    const books = await loadBookkeepingFor(owner, "2025-04", "2025-05-02");
    const payout = books.verifications.find((v) => v.text.startsWith("Utbetalning U-APR-1"))!;
    expect(payout.date).toBe("2025-04-15");
    expect(payout.transactions).toEqual([
      { account: "1930", amountOre: 38_700 },
      { account: "6040", amountOre: 500 },
      { account: "1580", amountOre: -39_200 },
    ]);
    expect(books.bankFallback).toBe(true);
    expect(books.payoutsBooked).toBe(1);
    // Fordran på kortinlösen efter utbetalningen = order som leverantören inte betalat ut.
    const settlement = books.verifications
      .flatMap((v) => v.transactions)
      .filter((t) => t.account === "1580")
      .reduce((sum, t) => sum + t.amountOre, 0);
    const rec = await loadReconciliationFor(owner, APRIL);
    const missing = rec.result!.payouts[0]!.deviations.find((d) => d.kind === "missing-in-payout")!;
    expect(settlement).toBe(-missing.impactOre);
  });

  it("pågående och framtida månader: ingen SIE-fil, ingen leverans; #GEN är dagens datum", async () => {
    await expect(loadBookkeepingFor(owner, "2025-06", "2025-05-02")).rejects.toThrow(
      /har inte börjat/,
    );
    const open = await loadBookkeepingFor(owner, "2025-05", "2025-05-02");
    expect(open.state).toBe("open");
    await expect(sieFileFor(owner, "2025-05", "2025-05-02")).rejects.toThrow(/pågår/);
    await expect(deliverVouchersFor(owner, "2025-05", "2025-05-02")).rejects.toThrow(/pågår/);
    const file = await sieFileFor(owner, "2025-04", "2025-05-02");
    expect(Buffer.from(file.bytes).toString("latin1")).toContain("#GEN 20250502");
  });

  it("numren löper över räkenskapsåret, en månad skickas en gång och i ordning", async () => {
    const outbox = await mkdtemp(path.join(tmpdir(), "binderlab-bokforing-"));
    const before = {
      provider: process.env.ACCOUNTING_PROVIDER,
      dir: process.env.ACCOUNTING_OUTBOX_DIR,
    };
    process.env.ACCOUNTING_PROVIDER = "local";
    process.env.ACCOUNTING_OUTBOX_DIR = outbox;
    try {
      await asUser(fx.owner, (tx) =>
        tx.insert(s.orders).values(order(fx, "50100", "2025-05-06T10:00:00Z")),
      );
      const april = await loadBookkeepingFor(owner, "2025-04", "2025-06-02");
      const may = await loadBookkeepingFor(owner, "2025-05", "2025-06-02");
      const aprilLast = april.verifications.at(-1)!.number;
      expect(april.verifications[0]!.number).toBe(1);
      expect(may.verifications[0]!.number).toBe(aprilLast + 1);

      // Maj kan inte skickas före april? Jo, men då kan april inte skickas efteråt.
      await expect(deliverVouchersFor(viewer, "2025-04", "2025-06-02")).rejects.toBeInstanceOf(
        AuthorizationError,
      );
      const sent = await deliverVouchersFor(owner, "2025-04", "2025-06-02");
      expect(sent).toMatchObject({
        count: april.verifications.length,
        firstNumber: 1,
        lastNumber: aprilLast,
      });
      await expect(deliverVouchersFor(owner, "2025-04", "2025-06-02")).rejects.toThrow(
        /redan skickad/,
      );
      const logged = await rows<{ n: number }>(
        db(),
        sql`select count(*)::int as n from public.voucher_deliveries
            where organization_id = ${fx.orgId} and month = '2025-04-01'`,
      );
      expect(logged[0]!.n).toBe(1);
      const audit = await rows<{ n: number }>(
        db(),
        sql`select count(*)::int as n from public.audit_log
            where organization_id = ${fx.orgId} and table_name = 'voucher_deliveries'`,
      );
      expect(audit[0]!.n).toBe(1);
      const mutate = await asUser(fx.owner, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`update public.voucher_deliveries set last_number = 1 where organization_id = ${fx.orgId}`,
          ),
        ),
      );
      expect(mutate.ok).toBe(false);

      // En sen order i april: aprils nummer ligger fast, ändringen syns, maj fortsätter efter.
      await asUser(fx.owner, (tx) =>
        tx.insert(s.orders).values(order(fx, "50101", "2025-04-29T10:00:00Z")),
      );
      const aprilAgain = await loadBookkeepingFor(owner, "2025-04", "2025-06-02");
      expect(aprilAgain.delivery?.lastNumber).toBe(aprilLast);
      expect(aprilAgain.changedSinceDelivery).toBe(true);
      const mayAgain = await loadBookkeepingFor(owner, "2025-05", "2025-06-02");
      expect(mayAgain.verifications[0]!.number).toBe(aprilLast + 1);
      await deliverVouchersFor(owner, "2025-05", "2025-06-02");
      const marchView = await loadBookkeepingFor(owner, "2025-03", "2025-06-02");
      expect(marchView.laterDelivery?.month).toBe("2025-04");
    } finally {
      process.env.ACCOUNTING_PROVIDER = before.provider;
      process.env.ACCOUNTING_OUTBOX_DIR = before.dir;
      if (before.provider === undefined) delete process.env.ACCOUNTING_PROVIDER;
      if (before.dir === undefined) delete process.env.ACCOUNTING_OUTBOX_DIR;
      await rm(outbox, { recursive: true, force: true });
    }
  });
});

describe("rättning av en felaktig utbetalning", () => {
  it("arkiveras med anteckning och importeras igen med samma referens", async () => {
    const wrong = csv([
      "Referens;Period från;Period till;Utbetald;Belopp;Avgifter",
      "U-JUL-1;2025-07-01;2025-07-31;2025-08-05;100,00;0",
    ]);
    await importPayoutFileFor(owner, { name: "jul.csv", bytes: wrong }, { fileStore: files });
    const id = (
      await rows<{ id: string }>(
        db(),
        sql`select id from public.payouts where organization_id = ${fx.orgId} and reference = 'U-JUL-1'`,
      )
    )[0]!.id;
    await expect(archivePayoutFor(viewer, { id, note: "Fel belopp" })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(archivePayoutFor(owner, { id, note: " " })).rejects.toThrow(/varför/);
    expect(await archivePayoutFor(owner, { id, note: "Fel belopp i Awish-exporten" })).toEqual({
      reference: "U-JUL-1",
    });
    await expect(archivePayoutFor(owner, { id, note: "Igen" })).rejects.toThrow(/redan arkiverad/);
    const fixed = await importPayoutFileFor(
      owner,
      {
        name: "jul-rattad.csv",
        bytes: csv([
          "Referens;Period från;Period till;Utbetald;Belopp;Avgifter",
          "U-JUL-1;2025-07-01;2025-07-31;2025-08-05;120,00;0",
        ]),
      },
      { fileStore: files },
    );
    expect(fixed).toMatchObject({ rowsNew: 1, rowsConflict: 0 });
    const both = await rows<{ archived: boolean; amount: number }>(
      db(),
      sql`select archived_at is not null as archived, amount_ore::int as amount from public.payouts
          where organization_id = ${fx.orgId} and reference = 'U-JUL-1' order by created_at`,
    );
    expect(both).toEqual([
      { archived: true, amount: 10_000 },
      { archived: false, amount: 12_000 },
    ]);
    const audit = await rows<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.audit_log
          where organization_id = ${fx.orgId} and table_name = 'payouts' and row_id = ${id}`,
    );
    expect(audit[0]!.n).toBeGreaterThanOrEqual(1);
  });
});

describe("kassaflöde", () => {
  it("räknas per månad med utbetalningar in och kostnader ut", async () => {
    const cash = await loadCashflowFor(owner, "2025-04-20");
    expect(cash.error).toBeNull();
    expect(cash.result!.buckets.map((b) => b.key)).toContain("2025-04");
    // Två utbetalningar (april och juli): rytmen läses ur den senaste.
    expect(cash.payouts).toBe(2);
    expect(cash.payoutCycleNote).toMatch(/följer den senaste/);
    // En enda utbetalning i intervallet: ingen rytm läses ut ur den, en i månaden antas.
    const early = await loadCashflowFor(owner, "2025-02-10");
    expect(early.payouts).toBe(1);
    expect(early.payoutCycleNote).toMatch(/en utbetalning i månaden antas/);
    expect(early.result!.basis.payoutCycle).toBe("month");
    // Inköp framåt: lagret fylls på i försäljningstakt (inköpsvärdet 20 kr per sålt pack).
    const rep = cash.replenishment!;
    expect(rep.windowCostOre).toBeGreaterThan(0);
    const may = rep.months.find((m) => m.month === "2025-05")!;
    expect(may.days).toBe(31);
    expect(may.addedOre).toBe(Math.round((rep.windowCostOre * 31) / rep.windowDays));
    const mayBucket = cash.result!.buckets.find((b) => b.key === "2025-05")!;
    expect(mayBucket.forecast.purchasesOre).toBe(may.addedOre);
    await expect(loadCashflowFor(refiller, "2025-04-20")).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});

describe("avtal", () => {
  it("skapas med villkor, påminns 90 dagar före sista uppsägningsdag och får en fil", async () => {
    const otherStore = await asUser(fx.owner, async (tx) => {
      const [st] = await tx
        .insert(s.stores)
        .values({ organizationId: fx.orgId, name: "Ny butik" })
        .returning({ id: s.stores.id });
      return st!.id;
    });
    const { id } = await saveContractFor(owner, {
      storeId: otherStore,
      title: "Placeringsavtal",
      validFrom: "2025-05-01",
      validTo: "2025-12-31",
      noticePeriodMonths: 3,
      noticePeriodDays: null,
      renewalMonths: 12,
      terminatedOn: null,
      terms: "Provision 10 % på försäljning exkl. moms.",
      note: null,
      newTerms: { commissionBp: 1000, monthlyRentOre: null },
    });
    const view = await loadContractsFor(owner, "2025-07-15");
    const reminder = view.reminders.reminders.find((r) => r.contractId === id)!;
    expect(reminder.term.noticeDeadline).toBe("2025-09-30");
    expect(reminder.term.reminderDate).toBe("2025-07-02");
    expect(reminder.status).toBe("due");
    const terms = view.agreements.filter((a) => a.contractId === id);
    expect(terms).toEqual([expect.objectContaining({ commissionBp: 1000, storeId: otherStore })]);

    // Villkor för en annan butik kan inte kopplas till avtalet (BL041).
    const mismatch = await asUser(fx.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.store_agreements set contract_id = ${id} where id = ${fx.agreementId}`,
        ),
      ),
    );
    expect(mismatch.code).toBe("BL041");

    const pdf = new TextEncoder().encode("%PDF-1.4\n% test\n");
    const { storagePath } = await attachContractFileFor(
      owner,
      { contractId: id, fileName: "avtal.pdf", bytes: pdf },
      { fileStore: files },
    );
    expect(storagePath.startsWith(`${fx.orgId}/${id}/`)).toBe(true);
    const read = await readContractFileFor(viewer, id, { fileStore: files });
    expect(read).toMatchObject({ fileName: "avtal.pdf", contentType: "application/pdf" });
    await expect(readContractFileFor(refiller, id, { fileStore: files })).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(
      attachContractFileFor(
        owner,
        { contractId: id, fileName: "virus.exe", bytes: new TextEncoder().encode("MZ...") },
        { fileStore: files },
      ),
    ).rejects.toThrow(/PDF, PNG, JPEG eller Word/);
    await expect(loadContractsFor(refiller, "2025-07-15")).rejects.toBeInstanceOf(
      AuthorizationError,
    );

    // Ändringen loggas.
    const audit = await rows<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.audit_log where table_name = 'contracts' and row_id = ${id}`,
    );
    expect(audit[0]!.n).toBeGreaterThanOrEqual(2);

    // Filkolumnerna kan inte skrivas direkt av en användare, bara via servern.
    const direct = await asUser(fx.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`update public.contracts set file_name = 'annan.pdf' where id = ${id}`),
      ),
    );
    expect(direct.code).toBe("42501");
    // Stämmer den sparade typen inte med innehållet skickas filen inte (även en tillåten typ).
    await db().execute(
      sql`update public.contracts set file_content_type = 'image/png' where id = ${id}`,
    );
    await expect(readContractFileFor(owner, id, { fileStore: files })).rejects.toThrow(
      /stämmer inte med filtypen/,
    );
    await db().execute(
      sql`update public.contracts set file_content_type = 'application/pdf' where id = ${id}`,
    );

    // Arkiverat avtal ger ingen påminnelse; det kan återställas.
    await archiveContractFor(owner, { id, archived: true });
    const archived = await loadContractsFor(owner, "2025-07-15");
    expect(archived.reminders.reminders.some((r) => r.contractId === id)).toBe(false);
    await archiveContractFor(owner, { id, archived: false });
    const restored = await loadContractsFor(owner, "2025-07-15");
    expect(restored.reminders.reminders.some((r) => r.contractId === id)).toBe(true);
  });

  it("storage_path: annan organisation ger fortfarande 23514 (check före filspärren), '..' nekas", async () => {
    const other = await createOrg(await createUser(), `Annan ${uniqueSuffix()}`);
    const [c] = await rows<{ id: string }>(
      db(),
      sql`select id from public.contracts where organization_id = ${fx.orgId} limit 1`,
    );
    const set = (p: string) =>
      asUser(fx.owner, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(sql`update public.contracts set storage_path = ${p} where id = ${c!.id}`),
        ),
      );
    expect((await set(`${other}/reports/2025-03.pdf`)).code).toBe("23514");
    expect((await set(`${fx.orgId}/../${other}/x.pdf`)).ok).toBe(false);
    expect((await set(`${fx.orgId}/${c!.id}/${"f".repeat(64)}.pdf`)).code).toBe("42501");
  });

  it("storage: bucket contracts följer samma policy som imports och reports", async () => {
    const path = `${fx.orgId}/${crypto.randomUUID()}/fil.pdf`;
    const upload = (u: Viewer) =>
      asUser({ id: u.user.userId, email: u.user.email }, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`insert into storage.objects (bucket_id, name, owner) values ('contracts', ${path}, ${u.user.userId})`,
          ),
        ),
      );
    expect((await upload(viewer)).code).toBe("42501");
    expect((await upload(refiller)).code).toBe("42501");
    expect((await upload(owner)).ok).toBe(true);
    const visible = (u: Viewer) =>
      asUser(
        { id: u.user.userId, email: u.user.email },
        async (tx) =>
          (
            await rows<{ n: number }>(
              tx,
              sql`select count(*)::int as n from storage.objects where bucket_id = 'contracts' and name = ${path}`,
            )
          )[0]!.n,
      );
    expect(await visible(viewer)).toBe(1);
    expect(await visible(refiller)).toBe(0);
  });
});

describe("återbetalningar", () => {
  it("kända återbetalningar (kundärenden) räknas i avstämningen och bokförs vid utbetalningen", async () => {
    await asUser(fx.owner, (tx) =>
      tx.insert(s.incidents).values({
        organizationId: fx.orgId,
        machineId: fx.machineId,
        kind: "no_output",
        startedAt: new Date("2025-04-05T09:00:00Z"),
        refundedOre: 4900,
        refundedOn: "2025-04-05",
      }),
    );
    const view = await loadReconciliationFor(owner, APRIL);
    expect(view.refunds.map((r) => r.amountOre)).toEqual([4900]);
    const p = view.result!.payouts[0]!;
    expect(p.expected.refundsOre).toBe(4900);
    expect(p.expected.payoutOre).toBe(p.expected.salesOre - p.expected.feesOre - 4900);
  });
});
