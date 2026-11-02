/**
 * Rättelserna efter granskningen av Rapporter (fas 6), mot testdatabasen:
 *
 * - order utan kopplad titel ingår i bokföringen och butiksersättningen och räknas i
 *   avstämningen,
 * - påfyllningar räknas som besök (dagar), inte en rad per titel,
 * - "PDF finns" bygger på att filen sparats (report_files), inte på storage_path,
 * - storage_path kan inte pekas om och utskick kan inte loggas utan godkännande, inte
 *   ens direkt mot databasen,
 * - butiksportalen ser bara den senaste godkända versionen,
 * - SIE-numreringen fortsätter från förra månadens godkända underlag och #GEN är dagen
 *   då underlaget skapades,
 * - mejlets textdel saknar rader utan underlag och har en kort ämnesrad.
 */

import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { renderReportEmail } from "@/emails/report-email";
import { LocalFileStore } from "@/import/file-store";
import { decodeCp437 } from "@/reports";
import { listOrganizationsFor, type SessionUser } from "@/server/access";
import { OutboxMailer } from "@/server/mail/report-mailer";
import { sieOf } from "@/server/reports/files";
import {
  approveReportFor,
  createRecipientFor,
  createReportFor,
  emailPropsFor,
  ensurePdfFor,
  getReportFor,
  listArchiveFor,
  listRecipientsFor,
  previewReportFor,
  sendReportFor,
  type SendDeps,
  type Viewer,
} from "@/server/reports/service";
import { UNLINKED_TITLE_NAME } from "@/server/reports/sources";

import {
  asPostgres,
  asUser,
  attempt,
  createOrg,
  createUser,
  one,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const NOW = new Date("2025-11-05T09:00:00Z");
const DEC = new Date("2025-12-03T22:30:00Z"); // 3 dec 23:30 i Stockholm
const OCT = "2025-10";
const NOV = "2025-11";

let owner: TestUser;
let orgId: string;
let storeId: string;
let ownerViewer: Viewer;
let deps: SendDeps;
let outbox: string;

const fakePdf = async () => new TextEncoder().encode("%PDF-1.4 granskning");

beforeAll(async () => {
  owner = await createUser(`rapport-granskning-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(owner, `Rapporter granskning ${uniqueSuffix()}`);
  await asPostgres(async (tx) => {
    const store = await one<{ id: string }>(
      tx,
      sql`insert into public.stores (organization_id, name) values (${orgId}, 'Nordstan') returning id`,
    );
    storeId = store.id;
    await tx.execute(sql`insert into public.store_agreements
        (organization_id, store_id, valid_from, commission_bp)
        values (${orgId}, ${storeId}, '2025-01-01', 1000)`);
    const machine = await one<{ id: string }>(
      tx,
      sql`insert into public.machines (organization_id, code, name, active_from)
          values (${orgId}, 'BL-001', 'Entré', '2025-01-01') returning id`,
    );
    await tx.execute(sql`insert into public.machine_placements
        (organization_id, machine_id, store_id, valid_from)
        values (${orgId}, ${machine.id}, ${storeId}, '2025-01-01')`);
    const t1 = await one<{ id: string }>(
      tx,
      sql`insert into public.titles (organization_id, name) values (${orgId}, 'Black Bolt') returning id`,
    );
    const t2 = await one<{ id: string }>(
      tx,
      sql`insert into public.titles (organization_id, name) values (${orgId}, 'Surging Sparks') returning id`,
    );
    await tx.execute(sql`insert into public.ledger_accounts (organization_id, key, bas_account, name)
        values (${orgId}, 'settlement', '1580', 'Fordran'), (${orgId}, 'sales', '3004', 'Försäljning')`);
    const source = await one<{ id: string }>(
      tx,
      sql`insert into public.data_sources (organization_id, provider, name)
          values (${orgId}, 'awish_csv', 'Awish') returning id`,
    );
    const order = (ext: string, at: string, titleId: string | null, amount: number) =>
      tx.execute(sql`insert into public.orders
          (organization_id, data_source_id, external_id, raw_title, title_id, ordered_at,
           amount_ore, machine_id, source_hash)
          values (${orgId}, ${source.id}, ${ext}, 'x', ${titleId}, ${at}::timestamptz,
                  ${amount}, ${machine.id}, ${`h${ext}`})`);
    await order("3001", "2025-10-03T10:00:00Z", t1.id, 4900);
    await order("3002", "2025-10-04T10:00:00Z", null, 5900);
    await order("3003", "2025-10-05T10:00:00Z", t1.id, 4900);
    await order("3004", "2025-11-06T10:00:00Z", t1.id, 4900);
    await order("3005", "2025-11-07T10:00:00Z", t1.id, 4900);

    const loc = await one<{ id: string }>(
      tx,
      sql`select id from public.stock_locations
          where organization_id = ${orgId} and machine_id = ${machine.id}`,
    ).catch(() =>
      one<{ id: string }>(
        tx,
        sql`insert into public.stock_locations (organization_id, kind, machine_id, name)
            values (${orgId}, 'machine', ${machine.id}, 'Entré') returning id`,
      ),
    );
    for (const [title, at] of [
      [t1.id, "2025-10-10T08:00:00Z"],
      [t2.id, "2025-10-10T08:05:00Z"],
      [t1.id, "2025-10-20T08:00:00Z"],
      [t2.id, "2025-10-20T08:02:00Z"],
    ] as const) {
      await tx.execute(sql`insert into public.stock_events
          (organization_id, location_id, title_id, kind, quantity, occurred_at, business_date)
          values (${orgId}, ${loc.id}, ${title}, 'refill', 5, ${at}::timestamptz,
                  (${at}::timestamptz at time zone 'Europe/Stockholm')::date)`);
    }
  });

  const user: SessionUser = { userId: owner.id, email: owner.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId)!;
  ownerViewer = { user, organization };

  outbox = await mkdtemp(path.join(tmpdir(), "bl-outbox-granskning-"));
  deps = {
    mailer: new OutboxMailer(outbox),
    store: new LocalFileStore(await mkdtemp(path.join(tmpdir(), "bl-reports-granskning-"))),
    render: fakePdf,
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
    sender: { name: "Binderlab", address: "–", email: "rapporter@binderlab.test" },
  };
});

describe("underlaget", () => {
  it("order utan kopplad titel bokförs, ger ersättning och syns i avstämningen", async () => {
    const acc = await previewReportFor(ownerViewer, { type: "bokforing", month: OCT }, NOW);
    if (acc.type !== "bokforing") throw new Error("fel typ");
    expect(acc.report.totals.orders).toBe(3);
    expect(acc.report.totals.grossOre).toBe(4900 + 5900 + 4900);
    expect(acc.ordersWithoutTitle).toBe(1);
    expect(acc.report.unpricedTitles.map((u) => u.name)).toContain(UNLINKED_TITLE_NAME);

    const store = await previewReportFor(ownerViewer, { type: "butik", month: OCT, storeId }, NOW);
    if (store.type !== "butik") throw new Error("fel typ");
    expect(store.report.compensation.commissionOre).toBe(490 + 590 + 490);
    expect(store.service.refills).toEqual({ count: 2, last: "2025-10-20" });
  });
});

describe("PDF och skydd i databasen", () => {
  let reportId: string;

  beforeAll(async () => {
    reportId = await createReportFor(ownerViewer, { type: "butik", month: OCT, storeId }, NOW);
  });

  it("PDF finns först när filen sparats", async () => {
    const before = await listArchiveFor(ownerViewer);
    expect(before.find((r) => r.id === reportId)?.hasPdf).toBe(false);
    await ensurePdfFor(ownerViewer, reportId, { store: deps.store, render: fakePdf });
    const after = await listArchiveFor(ownerViewer);
    expect(after.find((r) => r.id === reportId)?.hasPdf).toBe(true);
    // Idempotent: en andra hämtning skriver ingen ny rad.
    await ensurePdfFor(ownerViewer, reportId, { store: deps.store, render: fakePdf });
    const files = await asPostgres((tx) =>
      one<{ n: number }>(
        tx,
        sql`select count(*)::int as n from public.report_files where report_id = ${reportId}`,
      ),
    );
    expect(files.n).toBe(1);
  });

  it("ägaren kan inte peka om storage_path till en annan rapports fil", async () => {
    const other = await createReportFor(ownerViewer, { type: "delagare", month: OCT }, NOW);
    await asUser(owner, async (tx) => {
      const r = await attempt(tx, (sp) =>
        sp.execute(sql`update public.reports
            set storage_path = (select storage_path from public.reports where id = ${reportId})
            where id = ${other}`),
      );
      expect(r.ok).toBe(false);
      const same = await attempt(tx, (sp) =>
        sp.execute(sql`update public.reports set storage_path = storage_path where id = ${other}`),
      );
      expect(same.ok).toBe(true);
    });
  });

  it("utskick kan inte loggas för en rapport som inte är godkänd", async () => {
    await asUser(owner, async (tx) => {
      const r = await attempt(tx, (sp) =>
        sp.execute(sql`insert into public.report_deliveries
            (organization_id, report_id, email, status, sent_at)
            values (${orgId}, ${reportId}, 'x@example.se', 'sent', now())`),
      );
      expect(r.ok).toBe(false);
    });
  });

  it("portalen ser bara den senaste godkända versionen", async () => {
    await approveReportFor(ownerViewer, reportId);
    const v2 = await createReportFor(
      ownerViewer,
      { type: "butik", month: OCT, storeId, greeting: "Tack!" },
      new Date(NOW.getTime() + 1000),
    );
    const approved = (id: string) =>
      asPostgres((tx) =>
        one<{ ok: boolean }>(
          tx,
          sql`select private.portal_report_approved(${orgId}::uuid, ${id}::uuid) as ok`,
        ),
      ).then((r) => r.ok);
    expect(await approved(reportId)).toBe(true);
    expect(await approved(v2)).toBe(false);
    await approveReportFor(ownerViewer, v2);
    expect(await approved(reportId)).toBe(false);
    expect(await approved(v2)).toBe(true);
  });
});

describe("SIE och mejl", () => {
  it("numreringen fortsätter från förra månadens godkända underlag", async () => {
    const octId = await createReportFor(ownerViewer, { type: "bokforing", month: OCT }, NOW);
    const oct = await getReportFor(ownerViewer, octId);
    if (oct.snapshot.type !== "bokforing") throw new Error("fel typ");
    expect(oct.snapshot.sie.firstVerificationNumber).toBe(1);
    // Tre försäljningsdagar = tre verifikationer.
    expect(oct.snapshot.sieLastNumber).toBe(3);

    // Utan godkänt oktoberunderlag börjar november också på 1.
    const draft = await previewReportFor(ownerViewer, { type: "bokforing", month: NOV }, DEC);
    if (draft.type !== "bokforing") throw new Error("fel typ");
    expect(draft.sie.firstVerificationNumber).toBe(1);

    await approveReportFor(ownerViewer, octId);
    const nov = await previewReportFor(ownerViewer, { type: "bokforing", month: NOV }, DEC);
    if (nov.type !== "bokforing") throw new Error("fel typ");
    expect(nov.sie.firstVerificationNumber).toBe(4);
    const sie = decodeCp437(sieOf(nov));
    expect(sie).toContain('#VER "A" "4"');
    // #GEN = dagen då underlaget skapades, i organisationens tidszon.
    expect(sie).toMatch(/#GEN 20251203\b/);
  });

  it("butiksmejlet har kort ämne och inga rader utan underlag", async () => {
    const id = await createReportFor(
      ownerViewer,
      { type: "butik", month: OCT, storeId },
      new Date(NOW.getTime() + 5000),
    );
    await ensurePdfFor(ownerViewer, id, { store: deps.store, render: fakePdf });
    await approveReportFor(ownerViewer, id);
    const recipientId = await createRecipientFor(ownerViewer, {
      name: "Maria Lind",
      email: "maria@nordstan.example",
      kind: "store",
      storeId,
    });
    const result = await sendReportFor(
      ownerViewer,
      { reportId: id, recipientIds: [recipientId] },
      deps,
    );
    expect(result.sent).toBe(1);
    const [folder] = await readdir(outbox);
    const text = await readFile(path.join(outbox, folder!, "message.txt"), "utf8");
    expect(text).toContain("Påfyllningar: 2");
    for (const word of ["I drift", "Avbrott", "Nästa besök", "Kontakt:"]) {
      expect(text, word).not.toContain(word);
    }
    expect(text).toContain("Binderlab · rapporter@binderlab.test");
    expect(text).toMatch(/Avregistrera: mailto:rapporter@binderlab\.test/);
    const meta = JSON.parse(await readFile(path.join(outbox, folder!, "meta.json"), "utf8")) as {
      subject: string;
    };
    expect(meta.subject).toBe("Butiksrapport oktober 2025 · Nordstan");
  });
});
