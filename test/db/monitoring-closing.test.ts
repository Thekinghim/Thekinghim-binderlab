/**
 * Felövervakningen stänger och aviserar larmen som den ska (komplement till
 * monitoring.test.ts):
 *
 * - Rapportlarmet för en version stängs när en nyare version av samma rapport (typ, månad,
 *   butik) skickas.
 * - Larmet för månadsutkasten stängs när de saknade utkasten skapas för hand, först när
 *   inget saknas.
 * - Månadsjobbet: ett fel i en organisation (även tidigt, i placeringarna) ger larm för just
 *   den och stoppar inte de andra.
 * - Ett nytt systemlarm aviseras till prenumererande ägare (alert_deliveries), inte till
 *   påfyllaren, och samma öppna larm aviseras inte igen.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { Db } from "@/db/client";
import * as s from "@/db/schema";
import { LocalFileStore } from "@/import/file-store";
import { listOrganizationsFor, type SessionUser } from "@/server/access";
import type { Mailer } from "@/server/mail/report-mailer";
import { recordDraftsOutcome, recordJobOutcome, type FailureCapture } from "@/server/monitoring";
import { createMonthlyDrafts, draftsForOrganization } from "@/server/reports/drafts";
import {
  approveReportFor,
  createRecipientFor,
  createReportFor,
  sendReportFor,
  type SendDeps,
} from "@/server/reports/service";

import type { Viewer } from "../../src/app/(app)/datakallor/_lib/service";

import {
  asPostgres,
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
const quiet: FailureCapture = async () => null;

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user: SessionUser = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

async function statuses(orgId: string, key: string): Promise<string[]> {
  return (
    await rows<{ status: string }>(
      db(),
      sql`select status from public.alerts
          where organization_id = ${orgId}::uuid and incident_key = ${key}
          order by triggered_at`,
    )
  ).map((r) => r.status);
}

/** Organisation med en butik och en automat sedan 2025-01-01. */
async function orgWithStore(label: string) {
  const owner = await createUser(`overvakning-${label}-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(owner, `Övervakning ${label} ${uniqueSuffix()}`);
  const storeId = await asUser(owner, async (tx) => {
    const org = { organizationId: orgId };
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: "Nordstan" })
      .returning();
    await tx.insert(s.storeAgreements).values({
      ...org,
      storeId: store!.id,
      validFrom: "2025-01-01",
      commissionBp: 1000,
    });
    const [machine] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-901", name: "Entré", activeFrom: "2025-01-01" })
      .returning();
    await tx.insert(s.machinePlacements).values({
      ...org,
      machineId: machine!.id,
      storeId: store!.id,
      validFrom: "2025-01-01",
    });
    return store!.id;
  });
  return { owner, orgId, storeId, viewer: await viewerFor(owner, orgId) };
}

describe("rapportlarm och nya versioner", () => {
  it("ett lyckat utskick av en ny version stänger den gamla versionens larm", async () => {
    const { orgId, storeId, viewer } = await orgWithStore("version");
    let failing = true;
    const mailer = {
      kind: "outbox",
      send: async () => {
        if (failing) throw new Error("Leverantören svarar inte (test)");
        return { providerMessageId: "test:1" };
      },
    } as unknown as Mailer;
    const deps: SendDeps = {
      mailer,
      store: new LocalFileStore(await mkdtemp(path.join(tmpdir(), "bl-reports-"))),
      render: async () => new TextEncoder().encode("%PDF-1.4 test"),
      renderEmails: async (_id, ids) =>
        Object.fromEntries(ids.map((id) => [id, { html: "<p>Rapport</p>" }])),
      reportUrl: (id) => `https://app.test/rapport/${id}`,
      monitor: { capture: quiet },
    };
    const recipient = await createRecipientFor(viewer, {
      name: "Maria Lind",
      email: "maria@nordstan.example",
      kind: "store",
      storeId,
    });
    const v1 = await createReportFor(viewer, { type: "butik", month: "2025-10", storeId }, NOW);
    await approveReportFor(viewer, v1);
    await sendReportFor(viewer, { reportId: v1, recipientIds: [recipient] }, deps);
    expect(await statuses(orgId, `report:${v1}`)).toEqual(["open"]);

    failing = false;
    const v2 = await createReportFor(viewer, { type: "butik", month: "2025-10", storeId }, NOW);
    await approveReportFor(viewer, v2);
    const ok = await sendReportFor(viewer, { reportId: v2, recipientIds: [recipient] }, deps);
    expect(ok.sent).toBe(1);
    expect(await statuses(orgId, `report:${v1}`)).toEqual(["closed"]);
  });
});

describe("månadsutkastens larm", () => {
  it("stängs när de saknade utkasten skapas för hand, först när inget saknas", async () => {
    const { orgId, storeId, viewer } = await orgWithStore("utkast");
    const key = "report_drafts:2025-10";
    await recordDraftsOutcome(
      { capture: quiet },
      { organizationId: orgId, month: "2025-10", created: 0, errors: ["butik: test", "x: test"] },
    );
    expect(await statuses(orgId, key)).toEqual(["open"]);

    await createReportFor(viewer, { type: "butik", month: "2025-10", storeId }, NOW);
    await createReportFor(viewer, { type: "bokforing", month: "2025-10" }, NOW);
    // Delägarrapporten saknas fortfarande.
    expect(await statuses(orgId, key)).toEqual(["open"]);
    // Ett utkast för en annan månad rör inte larmet.
    await createReportFor(viewer, { type: "delagare", month: "2025-09" }, NOW);
    expect(await statuses(orgId, key)).toEqual(["open"]);

    await createReportFor(viewer, { type: "delagare", month: "2025-10" }, NOW);
    expect(await statuses(orgId, key)).toEqual(["closed"]);
  });
});

describe("månadsjobbet per organisation", () => {
  it("ett fel i en organisation ger larm för den och stoppar inte de andra", async () => {
    const a = await orgWithStore("jobb-a");
    const b = await orgWithStore("jobb-b");
    const results = await createMonthlyDrafts(db(), NOW, {
      organizationIds: [a.orgId, b.orgId],
      draftsFor: async (database, orgId, timeZone, now) => {
        if (orgId === a.orgId) throw new Error("Oväntat fel (test)");
        return draftsForOrganization(database, orgId, timeZone, now);
      },
    });
    const byOrg = new Map(results.map((r) => [r.organizationId, r]));
    expect(byOrg.get(a.orgId)?.errors).toEqual(["jobbet: Oväntat fel (test)"]);
    expect(byOrg.get(b.orgId)?.errors).toEqual([]);
    expect(
      byOrg
        .get(b.orgId)
        ?.created.map((c) => c.type)
        .sort(),
    ).toEqual(["bokforing", "butik", "delagare"]);
    expect(await statuses(a.orgId, "job:rapporter")).toEqual(["open"]);
    expect(await statuses(b.orgId, "job:rapporter")).toEqual([]);

    // Nästa lyckade körning stänger larmet.
    await createMonthlyDrafts(db(), NOW, { organizationIds: [a.orgId] });
    expect(await statuses(a.orgId, "job:rapporter")).toEqual(["closed"]);
  });

  it("ett fel redan i placeringarna ger larm för månaden", async () => {
    const { orgId } = await orgWithStore("placering");
    const real = db();
    let first = true;
    // Databasen fallerar vid första transaktionen (placeringarna), sedan fungerar den.
    const flaky = new Proxy(real, {
      get(target, prop, receiver) {
        if (prop === "transaction" && first) {
          first = false;
          return async () => {
            throw new Error("Anslutningen bröts (test)");
          };
        }
        const value = Reflect.get(target, prop, receiver);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) as Db;
    const result = await draftsForOrganization(flaky, orgId, "Europe/Stockholm", NOW);
    expect(result.errors).toEqual(["placeringar: Anslutningen bröts (test)"]);
    expect(result.created).toEqual([]);
    expect(await statuses(orgId, "report_drafts:2025-10")).toEqual(["open"]);
  });
});

describe("aviseringar för systemlarm", () => {
  let owner: TestUser;
  let refiller: TestUser;
  let orgId: string;

  beforeAll(async () => {
    owner = await createUser(`overvakning-avisering-${uniqueSuffix()}@test.binderlab.se`);
    orgId = await createOrg(owner, `Avisering ${uniqueSuffix()}`);
    refiller = await createMember(orgId, "refiller");
    await asUser(owner, (tx) =>
      tx
        .insert(s.alertSubscriptions)
        .values({ organizationId: orgId, userId: owner.id, channels: ["email"] }),
    );
    // Påfyllaren "prenumererar på allt" (skrivet förbi RLS, som annars bara tillåter
    // automat- och lagerlarm): systemlarmen ska ändå inte nå henne.
    await asPostgres((tx) =>
      tx
        .insert(s.alertSubscriptions)
        .values({ organizationId: orgId, userId: refiller.id, channels: ["push"] }),
    );
  });

  async function deliveries() {
    return rows<{ user_id: string; subject: string; alert_ids: string[] }>(
      db(),
      sql`select user_id, subject, alert_ids from public.alert_deliveries
          where organization_id = ${orgId}::uuid order by created_at`,
    );
  }

  it("ett misslyckat jobb aviseras till ägaren men inte till påfyllaren, och bara en gång", async () => {
    const failed = await recordJobOutcome(
      { capture: quiet },
      { organizationId: orgId, job: "larm", error: new Error("Databasen svarar inte (test)") },
    );
    const queued = await deliveries();
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({
      user_id: owner.id,
      subject: "Larmjobbet misslyckades",
      alert_ids: [failed.alertId],
    });
    const [alert] = await rows<{ notify_count: number; notified_severity: string }>(
      db(),
      sql`select notify_count, notified_severity from public.alerts where id = ${failed.alertId}::uuid`,
    );
    expect(alert).toEqual({ notify_count: 1, notified_severity: "critical" });

    // Samma öppna larm igen: räknas upp men aviseras inte en gång till.
    await recordJobOutcome(
      { capture: quiet },
      { organizationId: orgId, job: "larm", error: new Error("Databasen svarar inte (test)") },
    );
    expect(await deliveries()).toHaveLength(1);
  });
});
