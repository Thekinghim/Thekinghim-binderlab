/**
 * T5-2, Rapporter utan e-post, mot testdatabasen: "Skickade du den?" sparar en manuell rad
 * i report_deliveries (status delivered, channel manual). Då räknas rapporten som skickad,
 * månadens utskick som gjort och punkten i Att göra försvinner. Bara ägare och admin, bara
 * en godkänd rapport, och raden går inte att ändra efteråt.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  unstable_noStore: vi.fn(),
  unstable_cache: <T>(fn: T) => fn,
}));

import { LocalFileStore } from "@/import/file-store";
import { AuthorizationError, listOrganizationsFor } from "@/server/access";
import { loadTodosFor } from "@/server/data/core/loaders";
import { loadReportsPage } from "@/server/reports/page-data";
import {
  approveReportFor,
  createRecipientFor,
  createReportFor,
  listArchiveFor,
  markReportSharedFor,
  ReportError,
  type Viewer,
} from "@/server/reports/service";
import { runSeed } from "@/seed/run-seed";

import { asUser, attempt, createMember, db, rows, uniqueSuffix, type TestUser } from "./helpers";

const NOW = new Date("2026-11-05T09:00:00Z");
const OCT = "2026-10";

let orgId: string;
let owner: TestUser;
let ownerViewer: Viewer;
let adminViewer: Viewer;
let readerViewer: Viewer;
let refillerViewer: Viewer;
let stores: { id: string; name: string }[];

async function viewerFor(u: TestUser): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

const deliveries = (reportId: string) =>
  rows<{ recipient_id: string | null; email: string | null; status: string; channel: string }>(
    db(),
    sql`select recipient_id, email::text as email, status::text as status, channel
        from public.report_deliveries where report_id = ${reportId}::uuid order by created_at`,
  );

const reportTodos = async () =>
  (await loadTodosFor(ownerViewer, NOW)).filter((t) => t.kind === "report-due");

beforeAll(async () => {
  const suffix = uniqueSuffix();
  const seeded = await runSeed(db(), {
    password: "binderlab-delad",
    manageUsers: true,
    fileStore: new LocalFileStore(mkdtempSync(path.join(tmpdir(), "binderlab-delad-"))),
    organization: { name: `Delad ${suffix}`, slug: `delad-${suffix}` },
    users: {
      owner: { email: `delad-agare-${suffix}@test.binderlab.se`, fullName: "Ägare", role: "owner" },
      partner: {
        email: `delad-delagare-${suffix}@test.binderlab.se`,
        fullName: "Delägare",
        role: "viewer",
      },
    },
  });
  orgId = seeded.organizationId;
  owner = { id: seeded.users.owner!, email: `delad-agare-${suffix}@test.binderlab.se` };
  ownerViewer = await viewerFor(owner);
  adminViewer = await viewerFor(await createMember(orgId, "admin"));
  readerViewer = await viewerFor(await createMember(orgId, "viewer"));
  refillerViewer = await viewerFor(await createMember(orgId, "refiller"));
  // Alla sålda titlar har inköpspris (annars går rapporten inte att skapa).
  await db().execute(sql`
    insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
    select t.organization_id, t.id, 9500, '2026-09-01'
      from public.titles t
     where t.organization_id = ${orgId}::uuid
       and not exists (select 1 from public.purchase_prices p
                       where p.organization_id = t.organization_id and p.title_id = t.id)`);
  stores = await rows(
    db(),
    sql`select s.id, s.name from public.stores s
        where s.organization_id = ${orgId}::uuid
          and exists (select 1 from public.machine_placements p
                      where p.organization_id = s.organization_id and p.store_id = s.id)
        order by s.name`,
  );
  expect(stores.length).toBeGreaterThanOrEqual(2);
}, 240_000);

describe("butik utan mottagare i appen", () => {
  let reportId: string;

  it("ett utkast går inte att markera som skickat", async () => {
    reportId = await createReportFor(
      ownerViewer,
      { type: "butik", month: OCT, storeId: stores[0]!.id },
      NOW,
    );
    await expect(markReportSharedFor(ownerViewer, reportId)).rejects.toBeInstanceOf(ReportError);
    expect(await deliveries(reportId)).toEqual([]);
  });

  it("läsaren och påfyllaren får inte markera", async () => {
    await approveReportFor(ownerViewer, reportId, null, NOW);
    for (const v of [readerViewer, refillerViewer]) {
      await expect(markReportSharedFor(v, reportId)).rejects.toBeInstanceOf(AuthorizationError);
    }
    expect(await deliveries(reportId)).toEqual([]);
  });

  it("Ja, skickad: en manuell rad utan adress, rapporten räknas som skickad", async () => {
    // Två tryck samtidigt (dubbelt tryck, eller ägaren och admin): bara en rad.
    const added = await Promise.all([
      markReportSharedFor(adminViewer, reportId),
      markReportSharedFor(ownerViewer, reportId),
    ]);
    expect(added.sort()).toEqual([0, 1]);
    expect(await deliveries(reportId)).toEqual([
      { recipient_id: null, email: null, status: "delivered", channel: "manual" },
    ]);
    const row = (await listArchiveFor(ownerViewer)).find((r) => r.id === reportId)!;
    expect(row.status).toBe("sent");
    expect(row.deliveries[0]).toMatchObject({ manual: true, email: null, status: "delivered" });
    const page = await loadReportsPage(
      ownerViewer,
      { typ: "butik", manad: OCT, butiken: stores[0]!.id },
      NOW,
    );
    expect(page.current?.status).toBe("sent");
    expect(page.storeHasPortal).toBe(false);
  });

  it("att markera igen lägger inte till något", async () => {
    expect(await markReportSharedFor(ownerViewer, reportId)).toBe(0);
    expect(await deliveries(reportId)).toHaveLength(1);
  });

  it("Värde räknar inte en rapport som ägaren delat för hand som appens arbete", async () => {
    // 20261210000100_varde_bara_mejl.sql: bara utskick från appen (channel 'email') räknas.
    const counted = await asUser(owner, (tx) =>
      rows<{ kind: string; n: number }>(
        tx,
        sql`select kind, n from public.varde_automation_counts(
              ${orgId}::uuid, (date_trunc('month', now()) - interval '1 month')::date,
              (date_trunc('month', now()) + interval '2 months')::date)`,
      ),
    );
    expect(counted.filter((c) => c.kind === "report")).toEqual([]);
  });

  it("raden går inte att ändra eller ta bort, och läsaren kan inte lägga in en egen", async () => {
    const change = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`update public.report_deliveries set status = 'failed'
                       where report_id = ${reportId}::uuid returning id`),
      ),
    );
    expect(change.ok && Array.from(change.value as Iterable<unknown>).length > 0).toBe(false);
    const insert = await asUser(
      { id: readerViewer.user.userId, email: readerViewer.user.email },
      (tx) =>
        attempt(tx, (sp) =>
          sp.execute(sql`insert into public.report_deliveries
                           (organization_id, report_id, status, channel)
                         values (${orgId}::uuid, ${reportId}::uuid, 'delivered', 'manual')`),
        ),
    );
    expect(insert.ok).toBe(false);
    expect(await deliveries(reportId)).toHaveLength(1);
  });

  it("ett utskick med e-post kräver fortfarande en adress", async () => {
    const r = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`insert into public.report_deliveries (organization_id, report_id, status)
                       values (${orgId}::uuid, ${reportId}::uuid, 'sent')`),
      ),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe("23514");
  });
});

describe("butik med mottagare: punkten i Att göra", () => {
  let reportId: string;
  let recipientId: string;

  it("punkten finns tills rapporten markerats som skickad", async () => {
    const store = stores[1]!;
    recipientId = await createRecipientFor(ownerViewer, {
      name: "Butikschefen",
      email: `butik-${uniqueSuffix()}@test.binderlab.se`,
      kind: "store",
      storeId: store.id,
    });
    expect((await reportTodos()).map((t) => t.key)).toEqual([`report-due:${recipientId}:${OCT}`]);
    const before = await loadReportsPage(
      ownerViewer,
      { typ: "butik", manad: OCT, butiken: store.id },
      NOW,
    );
    expect(before.expected.map((e) => e.delivered)).toEqual([false]);

    reportId = await createReportFor(
      ownerViewer,
      { type: "butik", month: OCT, storeId: store.id },
      NOW,
    );
    await approveReportFor(ownerViewer, reportId, null, NOW);
    expect(await reportTodos()).toHaveLength(1);

    expect(await markReportSharedFor(ownerViewer, reportId)).toBe(1);
    const [row] = await deliveries(reportId);
    expect(row).toMatchObject({
      recipient_id: recipientId,
      status: "delivered",
      channel: "manual",
    });
    expect(row!.email).toMatch(/^butik-/);

    expect(await reportTodos()).toEqual([]);
    const after = await loadReportsPage(
      ownerViewer,
      { typ: "butik", manad: OCT, butiken: store.id },
      NOW,
    );
    expect(after.expected.map((e) => e.delivered)).toEqual([true]);
    expect(after.current?.status).toBe("sent");
  });

  it("en annan organisation kan inte markera rapporten", async () => {
    const other = await runSeed(db(), {
      password: "binderlab-delad",
      manageUsers: true,
      fileStore: new LocalFileStore(mkdtempSync(path.join(tmpdir(), "binderlab-delad2-"))),
      organization: { name: `Annan ${uniqueSuffix()}`, slug: `annan-${uniqueSuffix()}` },
      users: {
        owner: {
          email: `annan-agare-${uniqueSuffix()}@test.binderlab.se`,
          fullName: "Annan",
          role: "owner",
        },
        partner: {
          email: `annan-delagare-${uniqueSuffix()}@test.binderlab.se`,
          fullName: "Delägare",
          role: "viewer",
        },
      },
    });
    const [u] = await rows<{ email: string }>(
      db(),
      sql`select email::text as email from auth.users where id = ${other.users.owner!}::uuid`,
    );
    const user = { userId: other.users.owner!, email: u!.email };
    const organization = (await listOrganizationsFor(user)).find(
      (o) => o.id === other.organizationId,
    )!;
    await expect(markReportSharedFor({ user, organization }, reportId)).rejects.toBeInstanceOf(
      ReportError,
    );
    expect(await deliveries(reportId)).toHaveLength(1);
  });
});
