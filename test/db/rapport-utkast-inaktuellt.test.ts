/**
 * Utvärderingen 4 nov: det sparade utkastet till butiken sa 10 779,50 kr medan
 * förhandsvisningen och bokföringen sa 8 193,11 kr, och "Godkänn för utskick" godkände det
 * gamla utkastet. Nu jämförs ett utkast med samma rapport räknad nu: ett inaktuellt utkast
 * syns på Rapporter och kan inte godkännas förrän en ny version skapats.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { setTestPurchaseFor } from "@/app/(app)/order/_lib/service";
import { listOrganizationsFor, type SessionUser } from "@/server/access";
import type { Viewer } from "@/server/data/core/loaders";
import { loadReportsPage } from "@/server/reports/page-data";
import {
  approveReportFor,
  createReportFor,
  getReportFor,
  ReportError,
  staleDraftFor,
} from "@/server/reports/service";

import { asPostgres, rows, type TestUser } from "./helpers";
import { seedPortalTenant, type PortalTenant } from "./portal-fixture";

// Fixturen har en rapportrad för mars skapad nu: utkasten skapas med dagens tid (inget
// fast datum), så att de är senaste versionen.

async function viewerFor(u: TestUser, org: string): Promise<Viewer> {
  const user: SessionUser = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === org);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let t: PortalTenant;
let owner: Viewer;
let draft: string;

beforeAll(async () => {
  t = await seedPortalTenant("Sega gubben Rapport");
  owner = await viewerFor(t.owner, t.orgId);
  draft = await createReportFor(owner, { type: "butik", month: "2025-03", storeId: t.storeId });
});

describe("utkast till butiken", () => {
  it("ett nytt utkast är aktuellt", async () => {
    expect(await staleDraftFor(owner, draft)).toBeNull();
  });

  it("efter ett testköp är utkastet inaktuellt och kan inte godkännas", async () => {
    const [order] = await asPostgres((tx) =>
      rows<{ id: string }>(
        tx,
        sql`select id from public.orders where organization_id = ${t.orgId} and external_id = '42002'`,
      ),
    );
    await setTestPurchaseFor(owner, order!.id, true);
    const stale = await staleDraftFor(owner, draft);
    expect(stale).not.toBeNull();
    expect(stale!.nowOre!).toBeLessThan(stale!.draftOre!);

    const page = await loadReportsPage(owner, {
      typ: "butik",
      manad: "2025-03",
      butiken: t.storeId,
    });
    expect(page.current?.id).toBe(draft);
    expect(page.currentStale).toEqual(stale);
    // Förhandsvisningen är det nya beloppet.
    expect(page.preview?.type === "butik" && page.preview.report.compensation.totalOre).toBe(
      stale!.nowOre,
    );

    const err = await approveReportFor(owner, draft, null).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ReportError);
    expect((await getReportFor(owner, draft)).approvedAt).toBeNull();
  });

  it("en ny version är aktuell och kan godkännas", async () => {
    const next = await createReportFor(owner, {
      type: "butik",
      month: "2025-03",
      storeId: t.storeId,
    });
    expect(await staleDraftFor(owner, next)).toBeNull();
    await approveReportFor(owner, next, null);
    expect((await getReportFor(owner, next)).approvedAt).not.toBeNull();
    const page = await loadReportsPage(owner, {
      typ: "butik",
      manad: "2025-03",
      butiken: t.storeId,
    });
    expect(page.currentStale).toBeNull();
  });
});
