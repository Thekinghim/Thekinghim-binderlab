/**
 * Rapporter end-to-end mot testdatabasen: från order, avtal, priser och ägarandelar i
 * databasen till rapportobjekt (butiksersättning, moms, vinstfördelning), sparat utkast,
 * godkännande, PDF i lagringen och utskick till lokal utkorg med logg i report_deliveries
 * och ändringsloggen. Plus behörighet: läsaren får läsa men inte skapa, påfyllaren
 * ingenting.
 */

import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import * as s from "@/db/schema";
import { renderReportEmail } from "@/emails/report-email";
import { LocalFileStore } from "@/import/file-store";
import { decodeCp437 } from "@/reports";
import { AuthorizationError, listOrganizationsFor, type SessionUser } from "@/server/access";
import { OutboxMailer } from "@/server/mail/report-mailer";
import { draftsForOrganization } from "@/server/reports/drafts";
import { excelOf, reportFileName, sieOf } from "@/server/reports/files";
import {
  approveReportFor,
  createRecipientFor,
  createReportFor,
  emailPropsFor,
  getReportFor,
  listArchiveFor,
  listRecipientsFor,
  previewReportFor,
  ReportError,
  sendReportFor,
  type SendDeps,
  type Viewer,
} from "@/server/reports/service";
import type { ReportSnapshot } from "@/server/reports/snapshot";

import {
  asUser,
  createMember,
  createOrg,
  createUser,
  db,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const NOW = new Date("2025-11-05T09:00:00Z");
const OCT = "2025-10";

let owner: TestUser;
let orgId: string;
let ownerViewer: Viewer;
let viewerViewer: Viewer;
let refillerViewer: Viewer;
let storeA: string;
let storeB: string;

async function viewerFor(u: TestUser): Promise<Viewer> {
  const user: SessionUser = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

beforeAll(async () => {
  owner = await createUser(`rapport-agare-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(owner, `Rapporter ${uniqueSuffix()}`);
  await asUser(owner, async (tx) => {
    const org = { organizationId: orgId };
    const [a, b] = await tx
      .insert(s.stores)
      .values([
        { ...org, name: "Nordstan" },
        { ...org, name: "Mobilia" },
      ])
      .returning();
    storeA = a!.id;
    storeB = b!.id;
    await tx.insert(s.storeAgreements).values([
      {
        ...org,
        storeId: storeA,
        validFrom: "2025-01-01",
        commissionBp: 1000,
        monthlyRentOre: 6200,
      },
      { ...org, storeId: storeB, validFrom: "2025-01-01", monthlyRentOre: 3000 },
    ]);
    const [m1, m2] = await tx
      .insert(s.machines)
      .values([
        { ...org, code: "BL-001", name: "Entré", activeFrom: "2025-01-01" },
        { ...org, code: "BL-002", name: "Plan 2", activeFrom: "2025-01-01" },
      ])
      .returning();
    await tx.insert(s.machinePlacements).values([
      { ...org, machineId: m1!.id, storeId: storeA, validFrom: "2025-01-01" },
      { ...org, machineId: m2!.id, storeId: storeB, validFrom: "2025-01-01" },
    ]);
    const [t1, t2] = await tx
      .insert(s.titles)
      .values([
        { ...org, name: "Black Bolt" },
        { ...org, name: "Prismatic Evolutions" },
      ])
      .returning();
    await tx
      .insert(s.purchasePrices)
      .values({ ...org, titleId: t1!.id, unitCostOre: 2000, validFrom: "2025-09-01" });
    await tx.insert(s.ownerShares).values([
      { ...org, holderName: "Ägaren", shareBp: 6000, validFrom: "2025-01-01" },
      { ...org, holderName: "Delägaren", shareBp: 4000, validFrom: "2025-01-01" },
    ]);
    await tx.insert(s.ledgerAccounts).values([
      { ...org, key: "settlement", basAccount: "1580", name: "Fordran på kortinlösen" },
      { ...org, key: "sales", basAccount: "3004", name: "Försäljning, momsfri" },
      { ...org, key: "store_commission", basAccount: "6050", name: "Provisioner" },
      { ...org, key: "rent", basAccount: "5010", name: "Lokalhyra" },
      { ...org, key: "store_payable", basAccount: "2440", name: "Leverantörsskulder" },
    ]);
    const [source] = await tx
      .insert(s.dataSources)
      .values({ ...org, provider: "awish_csv", name: "Awish" })
      .returning();
    const order = (
      ext: string,
      at: string,
      machineId: string,
      titleId: string,
      amountOre: number,
    ) => ({
      ...org,
      dataSourceId: source!.id,
      externalId: ext,
      rawTitle: "x",
      titleId,
      orderedAt: new Date(at),
      amountOre,
      machineId,
      sourceHash: `h${ext}`,
    });
    await tx
      .insert(s.orders)
      .values([
        order("990", "2025-09-20T10:00:00Z", m1!.id, t1!.id, 4900),
        order("1001", "2025-10-03T10:00:00Z", m1!.id, t1!.id, 4900),
        order("1002", "2025-10-04T10:00:00Z", m1!.id, t1!.id, 4900),
        order("1003", "2025-10-11T12:00:00Z", m1!.id, t1!.id, 4900),
        order("1004", "2025-10-18T12:00:00Z", m1!.id, t2!.id, 5900),
        order("1005", "2025-10-19T12:00:00Z", m2!.id, t1!.id, 4900),
        order("1007", "2025-10-25T12:00:00Z", m2!.id, t1!.id, 4900),
      ]);
  });
  ownerViewer = await viewerFor(owner);
  viewerViewer = await viewerFor(await createMember(orgId, "viewer"));
  refillerViewer = await viewerFor(await createMember(orgId, "refiller"));
});

describe("rapportobjekt från databasen", () => {
  it("butiksrapporten räknar ersättningen steg för steg och visar inga andra butiker", async () => {
    const snap = await previewReportFor(
      ownerViewer,
      { type: "butik", month: OCT, storeId: storeA },
      NOW,
    );
    if (snap.type !== "butik") throw new Error("fel typ");
    const r = snap.report;
    expect(r.sales.revenueOre).toBe(3 * 4900 + 5900);
    expect(r.sales.orders).toBe(4);
    // Provision 10 % per order på belopp exkl. moms (moms 0) + hela månadshyran.
    expect(r.compensation.commissionOre).toBe(3 * 490 + 590);
    expect(r.compensation.rentOre).toBe(6200);
    expect(r.compensation.totalOre).toBe(2060 + 6200);
    expect(r.comparison.revenueOre).toBe(4900);
    const json = JSON.stringify(snap);
    expect(json).not.toContain("Mobilia");
    expect(json).not.toContain(storeB);
    expect(json).not.toMatch(/unitCost|costOre|profit|margin|inköp|vinst|marginal/i);
  });

  it("bokföringsunderlaget har moms 0, totalsummor och luckan i nummerserien", async () => {
    const snap = await previewReportFor(ownerViewer, { type: "bokforing", month: OCT }, NOW);
    if (snap.type !== "bokforing") throw new Error("fel typ");
    const t = snap.report.totals;
    expect(snap.report.vatRateBp).toBe(0);
    expect(t.grossOre).toBe(30_400);
    expect(t.vatOre).toBe(0);
    expect(t.netOre).toBe(30_400);
    expect(t.compensationOre).toBe(2060 + 6200 + 3000);
    expect(snap.report.reconciliation.numbers?.gaps).toEqual([{ from: 1006, to: 1006, count: 1 }]);
    expect(snap.missingAccounts).toEqual([]);
    const sie = decodeCp437(sieOf(snap));
    expect(sie).toContain("#SIETYP 4");
    expect(sie).toContain("#TRANS 3004 {} -49.00");
    const xlsx = await excelOf(snap);
    expect(Buffer.from(xlsx).subarray(0, 2).toString()).toBe("PK");
  });

  it("delägarrapporten fördelar vinsten exakt enligt ägarandelarna", async () => {
    const snap = await previewReportFor(viewerViewer, { type: "delagare", month: OCT }, NOW);
    if (snap.type !== "delagare") throw new Error("fel typ");
    const r = snap.report.result;
    // Prissatta order: 5 × 49 kr; inköp 5 × 20 kr; provision 3 × 4,90 (bara prissatta i
    // Nordstan); hyran dras helt (62 + 30 kr).
    expect(r.totalRevenueOre).toBe(30_400);
    expect(r.revenueOre).toBe(24_500);
    expect(r.costOre).toBe(10_000);
    expect(r.profitOre).toBe(24_500 - 10_000 - 1470 - 9200);
    const split = snap.report.profitSplit!;
    expect(Object.fromEntries(split.owners.map((o) => [o.name, o.amountOre]))).toEqual({
      Ägaren: 2298,
      Delägaren: 1532,
    });
    expect(split.owners.reduce((a, o) => a + o.amountOre, 0)).toBe(r.profitOre);
    expect(snap.report.previousMonth?.totalRevenueOre).toBe(4900);
  });
});

describe("flödet: utkast, godkännande, utskick", () => {
  let reportId: string;
  let outbox: string;
  let deps: SendDeps;

  beforeAll(async () => {
    outbox = await mkdtemp(path.join(tmpdir(), "bl-outbox-"));
    const store = new LocalFileStore(await mkdtemp(path.join(tmpdir(), "bl-reports-")));
    deps = {
      mailer: new OutboxMailer(outbox),
      store,
      render: async () => new TextEncoder().encode("%PDF-1.4 testrapport"),
      // I appen renderas mallen i headless Chromium; i testet direkt.
      renderEmails: async (id, recipientIds, followText) => {
        const report = await getReportFor(ownerViewer, id);
        const recipients = (await listRecipientsFor(ownerViewer)).filter((r) =>
          recipientIds.includes(r.id),
        );
        return Object.fromEntries(
          recipients.map((r) => [
            r.id,
            {
              html: renderReportEmail(
                emailPropsFor(report, r, {
                  followText,
                  reportUrl: `https://app.test/rapport/${id}`,
                  attachments: [],
                }),
              ).html,
            },
          ]),
        );
      },
      reportUrl: (id) => `https://app.test/rapport/${id}`,
    };
  });

  it("läsaren och påfyllaren kan inte skapa rapporter", async () => {
    await expect(
      createReportFor(viewerViewer, { type: "bokforing", month: OCT }, NOW),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(
      previewReportFor(refillerViewer, { type: "bokforing", month: OCT }, NOW),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(listArchiveFor(refillerViewer)).rejects.toBeInstanceOf(AuthorizationError);
  });

  it("innevarande månad kan inte rapporteras", async () => {
    await expect(
      createReportFor(ownerViewer, { type: "bokforing", month: "2025-11" }, NOW),
    ).rejects.toBeInstanceOf(ReportError);
  });

  it("skapar utkast med ögonblicksbild och beräkningsversion", async () => {
    reportId = await createReportFor(
      ownerViewer,
      { type: "butik", month: OCT, storeId: storeA, greeting: "Tack för oktober!" },
      NOW,
    );
    const r = await getReportFor(viewerViewer, reportId);
    expect(r.status).toBe("draft");
    expect(r.calcVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect((r.snapshot as ReportSnapshot & { type: "butik" }).report.greeting).toBe(
      "Tack för oktober!",
    );
    expect(r.storagePath).toBe(`${orgId}/${OCT}/${reportId}.pdf`);
  });

  it("inget skickas utan godkännande", async () => {
    const recipientId = await createRecipientFor(ownerViewer, {
      name: "Maria Lind",
      email: "maria@nordstan.example",
      kind: "store",
      storeId: storeA,
    });
    await createRecipientFor(ownerViewer, {
      name: "Per Ek",
      email: "per@mobilia.example",
      kind: "store",
      storeId: storeB,
    });
    await expect(
      sendReportFor(ownerViewer, { reportId, recipientIds: [recipientId] }, deps),
    ).rejects.toThrow(/godkännas/);
    await expect(approveReportFor(viewerViewer, reportId)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });

  it("godkänd rapport skickas bara till butikens egna mottagare och loggas", async () => {
    await approveReportFor(ownerViewer, reportId);
    const recipients = await listRecipientsFor(ownerViewer);
    const maria = recipients.find((r) => r.email === "maria@nordstan.example")!;
    const per = recipients.find((r) => r.email === "per@mobilia.example")!;
    await expect(
      sendReportFor(ownerViewer, { reportId, recipientIds: [per.id] }, deps),
    ).rejects.toThrow(/kan inte få/);

    const result = await sendReportFor(
      ownerViewer,
      { reportId, recipientIds: [maria.id], followText: "Rapporten är bifogad." },
      deps,
    );
    expect(result).toEqual({ sent: 1, failed: [], skipped: 0 });

    const after = await getReportFor(ownerViewer, reportId);
    expect(after.status).toBe("sent");
    expect(after.deliveries.map((d) => [d.email, d.status])).toEqual([
      ["maria@nordstan.example", "sent"],
    ]);

    const [folder] = await readdir(outbox);
    const text = await readFile(path.join(outbox, folder!, "message.txt"), "utf8");
    const html = await readFile(path.join(outbox, folder!, "message.html"), "utf8");
    expect(text).toContain("Hej Maria,");
    expect(text).toContain("Rapporten är bifogad.");
    expect(html).toContain("Nordstan");
    for (const body of [text, html]) {
      expect(body).not.toMatch(/inköp|marginal|vinst|Mobilia/i);
    }
    const files = await readdir(path.join(outbox, folder!));
    expect(files).toContain("binderlab-butik-nordstan-2025-10.pdf");

    // Ändringsloggen har både godkännandet och utskicket.
    const audit = await rows<{ table_name: string }>(
      db(),
      sql`select table_name from public.audit_log
          where organization_id = ${orgId}::uuid
            and table_name in ('report_approvals', 'report_deliveries')`,
    );
    expect(audit.map((a) => a.table_name).sort()).toEqual([
      "report_approvals",
      "report_deliveries",
    ]);

    // Redan skickad: hoppas över om man inte uttryckligen skickar igen.
    const again = await sendReportFor(ownerViewer, { reportId, recipientIds: [maria.id] }, deps);
    expect(again).toEqual({ sent: 0, failed: [], skipped: 1 });
  });

  it("en ny version ersätter ett ogodkänt utkast", async () => {
    const first = await createReportFor(ownerViewer, { type: "delagare", month: OCT }, NOW);
    const second = await createReportFor(
      ownerViewer,
      { type: "delagare", month: OCT, comment: "Bra månad." },
      new Date(NOW.getTime() + 1000),
    );
    const archive = await listArchiveFor(viewerViewer);
    expect(archive.find((r) => r.id === first)?.status).toBe("superseded");
    expect(archive.find((r) => r.id === second)?.status).toBe("draft");
    await expect(approveReportFor(ownerViewer, first)).rejects.toThrow(/nyare version/);
  });
});

describe("schemalagda utkast", () => {
  it("skapar förra månadens saknade utkast och kan köras om utan dubbletter", async () => {
    const first = await draftsForOrganization(db(), orgId, "Europe/Stockholm", NOW);
    expect(first.month).toBe(OCT);
    expect(first.errors).toEqual([]);
    // Butiksrapporten för Nordstan och delägarrapporten finns redan från testerna ovan.
    expect(first.created.map((c) => `${c.type}:${c.storeId ?? ""}`).sort()).toEqual(
      [`bokforing:`, `butik:${storeB}`].sort(),
    );
    expect(first.skipped).toBe(2);
    const drafts = await listArchiveFor(ownerViewer);
    const cron = drafts.filter((r) => first.created.some((c) => c.reportId === r.id));
    expect(cron.every((r) => r.status === "draft" && r.generatedBy === null)).toBe(true);

    const second = await draftsForOrganization(db(), orgId, "Europe/Stockholm", NOW);
    expect(second.created).toEqual([]);
    expect(second.skipped).toBe(4);
  });
});

describe("eget datum", () => {
  const RANGE = { start: "2025-10-11", end: "2025-10-31" };

  it("butiksrapport 11–31 okt.: siffrorna, hyran per dag och arkivraden följer intervallet", async () => {
    const id = await createReportFor(
      ownerViewer,
      { type: "butik", month: OCT, period: RANGE, storeId: storeA },
      NOW,
    );
    const report = await getReportFor(ownerViewer, id);
    expect(report.custom).toBe(true);
    expect(report.period).toEqual(RANGE);
    const snap = report.snapshot;
    if (snap.type !== "butik") throw new Error("fel typ");
    expect(snap.period).toEqual(RANGE);
    // Order 1003 (11 okt.) och 1004 (18 okt.) i Nordstan.
    expect(snap.report.sales.orders).toBe(2);
    expect(snap.report.compensation.commissionOre).toBe(490 + 590);
    // 62 kr × 21 / 31 dagar = 42 kr.
    expect(snap.report.compensation.rentOre).toBe(4200);
    // Månadsrapporten för samma butik ersätts inte av intervallet (olika perioder).
    const archive = await listArchiveFor(ownerViewer);
    const row = archive.find((r) => r.id === id)!;
    expect(row.status).toBe("draft");
    expect(row.month).toBe(OCT);
  });

  it("stoppar fel datum och framtida datum", async () => {
    await expect(
      previewReportFor(
        ownerViewer,
        {
          type: "butik",
          month: OCT,
          period: { start: "2025-10-20", end: "2025-10-10" },
          storeId: storeA,
        },
        NOW,
      ),
    ).rejects.toThrow(ReportError);
    await expect(
      previewReportFor(
        ownerViewer,
        {
          type: "butik",
          month: "2025-11",
          period: { start: "2025-11-01", end: "2025-11-06" },
          storeId: storeA,
        },
        NOW,
      ),
    ).rejects.toThrow(/efter i dag/);
  });

  it("innevarande månad fram till i dag går med eget datum", async () => {
    const snap = await previewReportFor(
      ownerViewer,
      { type: "bokforing", month: "2025-11", period: { start: "2025-11-01", end: "2025-11-05" } },
      NOW,
    );
    expect(snap.period).toEqual({ start: "2025-11-01", end: "2025-11-05" });
  });
});

describe("delägarrapport med eget datum", () => {
  const RANGE = { start: "2025-10-11", end: "2025-10-31" };

  /** Order som räknas, summerade direkt i databasen för dagarna i perioden. */
  async function ordersIn(period: { start: string; end: string }) {
    const [row] = await rows<{ n: number; sum: number }>(
      db(),
      sql`
        select count(*)::int as n, coalesce(sum(amount_ore), 0)::int as sum
        from public.orders
        where organization_id = ${orgId}::uuid
          and test_purchase_at is null
          and business_date between ${period.start}::date and ${period.end}::date`,
    );
    return row!;
  }

  it("utkast 11–31 okt.: perioden sparas, arkivraden och filnamnet följer intervallet", async () => {
    const id = await createReportFor(
      ownerViewer,
      { type: "delagare", month: OCT, period: RANGE, comment: "Halva månaden." },
      NOW,
    );
    const report = await getReportFor(ownerViewer, id);
    expect(report.type).toBe("delagare");
    expect(report.custom).toBe(true);
    expect(report.period).toEqual(RANGE);
    expect(report.month).toBe(OCT);
    expect(report.status).toBe("draft");
    const snap = report.snapshot;
    if (snap.type !== "delagare") throw new Error("fel typ");
    expect(snap.period).toEqual(RANGE);
    expect(snap.report.period).toEqual(RANGE);
    expect(snap.comment).toBe("Halva månaden.");
    const [dbRow] = await rows<{ period_start: string; period_end: string; kind: string }>(
      db(),
      sql`
        select period_start::text, period_end::text, kind::text from public.reports
        where id = ${id}::uuid`,
    );
    expect(dbRow).toEqual({
      period_start: RANGE.start,
      period_end: RANGE.end,
      kind: "owner_statement",
    });
    const archive = await listArchiveFor(ownerViewer);
    expect(archive.find((r) => r.id === id)).toMatchObject({ custom: true, period: RANGE });
    expect(reportFileName(snap, "pdf")).toBe("binderlab-delagare-2025-10-11--2025-10-31.pdf");
    expect(
      emailPropsFor(
        report,
        { name: "Delägaren" },
        {
          followText: null,
          reportUrl: "https://app.test",
          attachments: [],
        },
      ).subject,
    ).toMatch(/^Delägarrapport 11–31 okt\. 2025 · /);
  });

  it("siffrorna är summan av dagarna i intervallet och vinsten fördelas exakt", async () => {
    const snap = await previewReportFor(
      ownerViewer,
      { type: "delagare", month: OCT, period: RANGE },
      NOW,
    );
    if (snap.type !== "delagare") throw new Error("fel typ");
    const r = snap.report.result;

    // Mot databasen: order 1003, 1004, 1005 och 1007.
    const fromDb = await ordersIn(RANGE);
    expect(r.orders).toBe(fromDb.n);
    expect(r.orders).toBe(4);
    expect(r.totalRevenueOre).toBe(fromDb.sum);
    expect(r.totalRevenueOre).toBe(3 * 4900 + 5900);

    // Summan av varje dag för sig (samma uträkning per dag).
    const days: (typeof r)[] = [];
    for (let d = 11; d <= 31; d++) {
      const day = `2025-10-${String(d).padStart(2, "0")}`;
      const s = await previewReportFor(
        ownerViewer,
        { type: "delagare", month: OCT, period: { start: day, end: day } },
        NOW,
      );
      if (s.type !== "delagare") throw new Error("fel typ");
      days.push(s.report.result);
    }
    const sum = (pick: (x: typeof r) => number) => days.reduce((n, x) => n + pick(x), 0);
    expect(r.orders).toBe(sum((x) => x.orders));
    expect(r.totalRevenueOre).toBe(sum((x) => x.totalRevenueOre));
    expect(r.revenueOre).toBe(sum((x) => x.revenueOre));
    expect(r.costOre).toBe(sum((x) => x.costOre));
    expect(r.feesOre).toBe(sum((x) => x.feesOre));
    expect(r.commissionOre).toBe(sum((x) => x.commissionOre));
    // Hyran per dag: 62 kr × 21/31 = 42 kr och 30 kr × 21/31 = 20,32 kr.
    expect(r.rentOre).toBe(4200 + 2032);
    // Prissatta order: 1003, 1005, 1007 (Black Bolt, 20 kr); provision bara 1003 i Nordstan.
    expect(r.revenueOre).toBe(3 * 4900);
    expect(r.costOre).toBe(3 * 2000);
    expect(r.profitOre).toBe(3 * 4900 - 3 * 2000 - 490 - (4200 + 2032));

    const split = snap.report.profitSplit!;
    expect(split.profitOre).toBe(r.profitOre);
    expect(split.owners.reduce((a, o) => a + o.amountOre, 0)).toBe(r.profitOre);
    expect(Object.fromEntries(split.owners.map((o) => [o.name, o.shareBp]))).toEqual({
      Ägaren: 6000,
      Delägaren: 4000,
    });

    // Jämförelsen: lika många dagar före (20 sep.–10 okt.: order 990, 1001, 1002).
    expect(snap.report.previousMonth).toMatchObject({
      period: { start: "2025-09-20", end: "2025-10-10" },
      orders: (await ordersIn({ start: "2025-09-20", end: "2025-10-10" })).n,
    });
    expect(snap.report.previousMonth!.orders).toBe(3);
  });

  it("månadsrapporten är oförändrad", async () => {
    const month = await previewReportFor(ownerViewer, { type: "delagare", month: OCT }, NOW);
    const whole = await previewReportFor(
      ownerViewer,
      { type: "delagare", month: OCT, period: { start: "2025-10-01", end: "2025-10-31" } },
      NOW,
    );
    if (month.type !== "delagare" || whole.type !== "delagare") throw new Error("fel typ");
    expect(whole.report).toEqual(month.report);
    expect(month.period).toEqual({ start: "2025-10-01", end: "2025-10-31" });
    const r = month.report.result;
    expect(r.totalRevenueOre).toBe(30_400);
    expect(r.profitOre).toBe(24_500 - 10_000 - 1470 - 9200);
    expect(month.report.previousMonth).toMatchObject({ month: "2025-09", totalRevenueOre: 4900 });
    expect(month.report.previousMonth?.period).toBeUndefined();
    expect(month.report.trend.lastMonthThrough).toBeUndefined();
    expect(
      Object.fromEntries(month.report.profitSplit!.owners.map((o) => [o.name, o.amountOre])),
    ).toEqual({
      Ägaren: 2298,
      Delägaren: 1532,
    });
  });

  it("godkänns som vanligt och en ny version ersätter den gamla för samma datum", async () => {
    const first = await createReportFor(
      ownerViewer,
      { type: "delagare", month: OCT, period: RANGE },
      NOW,
    );
    const later = new Date(NOW.getTime() + 60_000);
    const second = await createReportFor(
      ownerViewer,
      { type: "delagare", month: OCT, period: RANGE },
      later,
    );
    expect((await getReportFor(ownerViewer, first)).status).toBe("superseded");
    await approveReportFor(ownerViewer, second, null, later);
    expect((await getReportFor(ownerViewer, second)).status).toBe("approved");
  });

  it("stoppar till > från, framtida datum och mer än ett år", async () => {
    const preview = (start: string, end: string) =>
      previewReportFor(
        ownerViewer,
        { type: "delagare", month: start.slice(0, 7) as typeof OCT, period: { start, end } },
        NOW,
      );
    await expect(preview("2025-10-20", "2025-10-10")).rejects.toThrow(/före till-datumet/);
    await expect(preview("2025-11-01", "2025-11-06")).rejects.toThrow(/efter i dag/);
    await expect(preview("2024-10-01", "2025-10-31")).rejects.toThrow(/högst ett år/);
    // Innevarande månad fram till i dag (affärsdagen i Europe/Stockholm) går.
    const today = await preview("2025-11-01", "2025-11-05");
    expect(today.period).toEqual({ start: "2025-11-01", end: "2025-11-05" });
  });
});
