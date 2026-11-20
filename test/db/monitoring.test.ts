/**
 * Felövervakning (src/server/monitoring) mot testdatabasen:
 *
 * - Misslyckad import (uppladdning): rad i imports med status failed, larm import_failed
 *   (av larmjobbet) som ägaren ser, och en Sentry-händelse. Påfyllaren ser inte larmet.
 * - Misslyckat rapportutskick: systemlarm report:<id> och Sentry-händelse; ett lyckat
 *   utskick stänger larmet.
 * - Månadsutkasten (schemalagt): larm per månad, stängs när jobbet lyckas.
 * - Larmjobbet: misslyckad körning ger job:larm, lyckad stänger det.
 * - Systemlarmen är en incident per nyckel (räknas upp), och larmjobbet stänger dem aldrig.
 */

import { mkdtemp } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import * as s from "@/db/schema";
import { LocalFileStore, type FileStore } from "@/import/file-store";
import { listOrganizationsFor, type SessionUser } from "@/server/access";
import { evaluateOrganization, loadIncidents } from "@/server/alerts/evaluate";
import { alertColumns } from "@/server/alerts/inputs";
import { rowToIncident, type AlertRow } from "@/server/alerts/store";
import type { Mailer } from "@/server/mail/report-mailer";
import {
  raiseSystemAlert,
  recordDraftsOutcome,
  recordJobOutcome,
  resolveSystemAlert,
  type FailureCapture,
  type FailureEvent,
} from "@/server/monitoring";
import {
  approveReportFor,
  createRecipientFor,
  createReportFor,
  sendReportFor,
  type SendDeps,
} from "@/server/reports/service";

import {
  appendChunkFor,
  createDataSourceFor,
  runUploadFor,
  startUploadFor,
  type UploadDeps,
  type Viewer,
} from "../../src/app/(app)/datakallor/_lib/service";
import { UploadStaging } from "../../src/app/(app)/datakallor/_lib/staging";

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

const SEED = readFileSync(
  path.join(__dirname, "..", "fixtures", "seed", "awish-orderlista-2026-10-13--2026-11-01.csv"),
);

/** Samlar Sentry-händelser i stället för att skicka. */
function fakeSentry(): { events: FailureEvent[]; capture: FailureCapture } {
  const events: FailureEvent[] = [];
  return {
    events,
    capture: async (event) => {
      events.push(event);
      return `evt-${events.length}`;
    },
  };
}

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user: SessionUser = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

/** Larmen som användaren ser (RLS), som Drift läser dem. */
async function alertsSeenBy(u: TestUser, orgId: string) {
  return asUser(u, async (tx) => {
    const found = (await tx
      .select(alertColumns)
      .from(s.alerts)
      .where(sql`${s.alerts.organizationId} = ${orgId}::uuid`)) as AlertRow[];
    return found.map(rowToIncident).filter((i) => i !== null);
  });
}

async function alertRows(orgId: string, key: string) {
  return rows<{
    id: string;
    status: string;
    kind: string;
    alert_group: string;
    occurrences: number;
  }>(
    db(),
    sql`select id, status, kind, alert_group, occurrences from public.alerts
        where organization_id = ${orgId}::uuid and incident_key = ${key}
        order by triggered_at`,
  );
}

let owner: TestUser;
let refiller: TestUser;
let viewerUser: TestUser;
let orgId: string;
let ownerViewer: Viewer;

beforeAll(async () => {
  owner = await createUser(`overvakning-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(owner, `Övervakning ${uniqueSuffix()}`);
  refiller = await createMember(orgId, "refiller");
  viewerUser = await createMember(orgId, "viewer");
  ownerViewer = await viewerFor(owner, orgId);
});

describe("misslyckad import", () => {
  it("ger importrad med status failed, larm på Drift och Sentry-händelse", async () => {
    const sourceId = await createDataSourceFor(ownerViewer, {
      name: "Awish orderlista",
      sourceTimezone: "Asia/Shanghai",
    });
    const sentry = fakeSentry();
    const brokenStore: FileStore = {
      put: async () => {
        throw new Error("Lagringen svarar inte (test)");
      },
      get: async () => {
        throw new Error("inte använd");
      },
    } as unknown as FileStore;
    const deps: UploadDeps = {
      staging: new UploadStaging(),
      fileStore: brokenStore,
      monitor: { capture: sentry.capture },
    };
    const { uploadId } = await startUploadFor(ownerViewer, deps, {
      fileName: "orderlista.csv",
      size: SEED.byteLength,
    });
    await appendChunkFor(ownerViewer, deps, { uploadId, index: 0, bytes: new Uint8Array(SEED) });

    await expect(
      runUploadFor(ownerViewer, deps, { uploadId, dataSourceId: sourceId, dryRun: false }),
    ).rejects.toThrow(/Lagringen svarar inte/);

    // Inga order sparades (importens transaktion rullades tillbaka) …
    const [orders] = await rows<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.orders where organization_id = ${orgId}::uuid`,
    );
    expect(orders!.n).toBe(0);
    // … men felet finns i importloggen.
    const imports = await rows<{ status: string; file_name: string; created_by: string }>(
      db(),
      sql`select status::text as status, file_name, created_by from public.imports
          where organization_id = ${orgId}::uuid and data_source_id = ${sourceId}::uuid`,
    );
    expect(imports).toEqual([
      { status: "failed", file_name: "orderlista.csv", created_by: owner.id },
    ]);

    // Larmet (regeln import_failed i larmjobbet), synligt för ägaren och läsaren.
    const seen = await alertsSeenBy(owner, orgId);
    const alert = seen.find((a) => a.key === `import:${sourceId}`);
    expect(alert).toMatchObject({
      kind: "import_failed",
      group: "import",
      status: "open",
      severity: "critical",
      title: "Import från Awish orderlista misslyckades",
    });
    expect((await alertsSeenBy(viewerUser, orgId)).some((a) => a.key === alert!.key)).toBe(true);
    // Påfyllaren ser bara larm om automater och lager.
    expect((await alertsSeenBy(refiller, orgId)).some((a) => a.key === alert!.key)).toBe(false);

    // Sentry: en händelse med felet, utan personuppgifter i taggarna.
    expect(sentry.events).toHaveLength(1);
    const event = sentry.events[0]!;
    expect(event.error).toBeInstanceOf(Error);
    expect(event.tags).toMatchObject({
      area: "import",
      kind: "import_failed",
      organization_id: orgId,
      data_source_id: sourceId,
    });
    expect(JSON.stringify(event)).not.toContain(owner.email);

    // En lyckad import efteråt stänger larmet när larmjobbet körs (efter 30 min).
    const okDeps: UploadDeps = {
      staging: deps.staging,
      fileStore: new LocalFileStore(await mkdtemp(path.join(tmpdir(), "bl-import-"))),
      monitor: { capture: sentry.capture },
    };
    const again = await startUploadFor(ownerViewer, okDeps, {
      fileName: "orderlista.csv",
      size: SEED.byteLength,
    });
    await appendChunkFor(ownerViewer, okDeps, {
      uploadId: again.uploadId,
      index: 0,
      bytes: new Uint8Array(SEED),
    });
    const ok = await runUploadFor(ownerViewer, okDeps, {
      uploadId: again.uploadId,
      dataSourceId: sourceId,
      dryRun: false,
    });
    expect(ok.summary.new).toBe(460);
    await evaluateOrganization(db(), orgId, new Date(Date.now() + 31 * 60_000));
    expect((await alertRows(orgId, `import:${sourceId}`)).map((r) => r.status)).toEqual(["closed"]);
    expect(sentry.events).toHaveLength(1);
  });

  it("fel i indata (tom fil, behörighet) räknas inte som misslyckad import", async () => {
    const sourceId = await createDataSourceFor(ownerViewer, {
      name: "Andra källan",
      sourceTimezone: "Europe/Stockholm",
    });
    const sentry = fakeSentry();
    const deps: UploadDeps = {
      staging: new UploadStaging(),
      fileStore: new LocalFileStore(await mkdtemp(path.join(tmpdir(), "bl-import-"))),
      monitor: { capture: sentry.capture },
    };
    const bytes = new TextEncoder().encode("inte,en,orderlista\n1,2,3\n");
    const { uploadId } = await startUploadFor(ownerViewer, deps, {
      fileName: "fel.csv",
      size: bytes.byteLength,
    });
    await appendChunkFor(ownerViewer, deps, { uploadId, index: 0, bytes });
    await expect(
      runUploadFor(ownerViewer, deps, { uploadId, dataSourceId: sourceId, dryRun: false }),
    ).rejects.toThrow();
    expect(sentry.events).toHaveLength(0);
    expect(await alertRows(orgId, `import:${sourceId}`)).toEqual([]);
  });
});

describe("rapportutskick", () => {
  let reportId: string;
  let recipientId: string;
  let deps: SendDeps;
  let sentry: ReturnType<typeof fakeSentry>;
  let failing = true;

  beforeAll(async () => {
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
    reportId = await createReportFor(
      ownerViewer,
      { type: "butik", month: "2025-10", storeId },
      new Date("2025-11-05T09:00:00Z"),
    );
    await approveReportFor(ownerViewer, reportId);
    recipientId = await createRecipientFor(ownerViewer, {
      name: "Maria Lind",
      email: "maria@nordstan.example",
      kind: "store",
      storeId,
    });
    sentry = fakeSentry();
    const mailer: Mailer = {
      kind: "outbox",
      send: async () => {
        if (failing) throw new Error("Leverantören svarar inte (test)");
        return { providerMessageId: "test:1" };
      },
    } as unknown as Mailer;
    deps = {
      mailer,
      store: new LocalFileStore(await mkdtemp(path.join(tmpdir(), "bl-reports-"))),
      render: async () => new TextEncoder().encode("%PDF-1.4 test"),
      renderEmails: async (_id, ids) =>
        Object.fromEntries(ids.map((id) => [id, { html: "<p>Rapport</p>" }])),
      reportUrl: (id) => `https://app.test/rapport/${id}`,
      monitor: { capture: sentry.capture },
    };
  });

  it("en mottagare som inte får rapporten ger larm och Sentry-händelse", async () => {
    const result = await sendReportFor(
      ownerViewer,
      { reportId, recipientIds: [recipientId] },
      deps,
    );
    expect(result.sent).toBe(0);
    expect(result.failed).toHaveLength(1);

    const [row] = await alertRows(orgId, `report:${reportId}`);
    expect(row).toMatchObject({ status: "open", kind: "report_failed", alert_group: "system" });
    const seen = (await alertsSeenBy(owner, orgId)).find((a) => a.key === `report:${reportId}`);
    expect(seen?.title).toBe("Utskicket av butiksrapport oktober 2025 · Nordstan misslyckades");
    expect(seen?.detail).toContain("Leverantören svarar inte");
    expect(seen?.link).toBe("/rapporter?manad=2025-10");
    // Mottagarens adress hamnar varken i larmet eller i Sentry.
    expect(JSON.stringify(seen)).not.toContain("maria@nordstan.example");
    expect(sentry.events).toHaveLength(1);
    expect(sentry.events[0]!.tags).toMatchObject({ area: "report", report_id: reportId });
    expect(JSON.stringify(sentry.events)).not.toContain("maria@nordstan.example");
    expect((await alertsSeenBy(refiller, orgId)).some((a) => a.group === "system")).toBe(false);
  });

  it("nytt fel räknar upp samma larm; lyckat utskick stänger det", async () => {
    await sendReportFor(ownerViewer, { reportId, recipientIds: [recipientId] }, deps);
    expect(await alertRows(orgId, `report:${reportId}`)).toMatchObject([
      { status: "open", occurrences: 2 },
    ]);
    failing = false;
    const ok = await sendReportFor(ownerViewer, { reportId, recipientIds: [recipientId] }, deps);
    expect(ok.sent).toBe(1);
    expect(await alertRows(orgId, `report:${reportId}`)).toMatchObject([{ status: "closed" }]);
  });

  it("ett utskick som avbryts (PDF går inte att skapa) ger larm", async () => {
    const other = await createReportFor(
      ownerViewer,
      { type: "bokforing", month: "2025-09" },
      new Date("2025-11-05T09:00:00Z"),
    );
    await approveReportFor(ownerViewer, other);
    const accountant = await createRecipientFor(ownerViewer, {
      name: "Bokhållaren",
      email: "bokforing@byra.example",
      kind: "accountant",
    });
    await expect(
      sendReportFor(
        ownerViewer,
        { reportId: other, recipientIds: [accountant] },
        {
          ...deps,
          render: async () => {
            throw new Error("Chromium saknas (test)");
          },
        },
      ),
    ).rejects.toThrow(/Chromium saknas/);
    const [row] = await alertRows(orgId, `report:${other}`);
    expect(row).toMatchObject({ status: "open", kind: "report_failed" });
    expect(sentry.events.at(-1)!.error).toBeInstanceOf(Error);
  });
});

describe("schemalagda jobb", () => {
  it("månadsutkasten: larm per månad, stängs när jobbet lyckas", async () => {
    const sentry = fakeSentry();
    const failed = await recordDraftsOutcome(
      { capture: sentry.capture },
      { organizationId: orgId, month: "2026-10", created: 1, errors: ["butik x: fel i test"] },
    );
    expect(failed.alertId).not.toBeNull();
    expect(failed.sentryId).toBe("evt-1");
    const seen = (await alertsSeenBy(owner, orgId)).find((a) => a.key === "report_drafts:2026-10");
    expect(seen).toMatchObject({
      kind: "report_failed",
      group: "system",
      severity: "warning",
      title: "Utkasten för oktober 2026 kunde inte skapas",
    });
    const ok = await recordDraftsOutcome(
      { capture: sentry.capture },
      { organizationId: orgId, month: "2026-10", created: 3, errors: [] },
    );
    expect(ok.resolved).toBe(1);
    expect(sentry.events).toHaveLength(1);
  });

  it("larmjobbet: misslyckad körning ger job:larm, lyckad körning stänger det", async () => {
    const owner2 = await createUser(`overvakning-jobb-${uniqueSuffix()}@test.binderlab.se`);
    const org2 = await createOrg(owner2, `Jobb ${uniqueSuffix()}`);
    const sentry = fakeSentry();
    await recordJobOutcome(
      { capture: sentry.capture },
      { organizationId: org2, job: "larm", error: new Error("Databasen svarar inte (test)") },
    );
    const [row] = await alertRows(org2, "job:larm");
    expect(row).toMatchObject({ status: "open", kind: "job_failed", alert_group: "system" });
    expect(sentry.events[0]!.tags).toMatchObject({ area: "job", job: "larm" });

    // Larmjobbet läser systemlarmet men stänger det inte för att ingen regel ser det …
    const later = new Date(Date.now() + 2 * 3_600_000);
    const incidents = await asPostgres((tx) => loadIncidents(tx, org2, later));
    expect(incidents.some((i) => i.key === "job:larm")).toBe(true);
    // … utan för att jobbet självt lyckades.
    const summary = await evaluateOrganization(db(), org2, later);
    expect(summary.status).toBe("ok");
    expect((await alertRows(org2, "job:larm")).map((r) => r.status)).toEqual(["closed"]);
  });

  it("systemlarm som inte gäller larmjobbet lämnas öppna av det", async () => {
    const owner3 = await createUser(`overvakning-sys-${uniqueSuffix()}@test.binderlab.se`);
    const org3 = await createOrg(owner3, `System ${uniqueSuffix()}`);
    const first = await raiseSystemAlert(db(), {
      organizationId: org3,
      kind: "report_failed",
      key: "report_drafts:2026-09",
      severity: "warning",
      title: "Utkasten kunde inte skapas",
      detail: "Test",
      rule: "Test",
      link: "/rapporter",
    });
    expect(first.created).toBe(true);
    const second = await raiseSystemAlert(db(), {
      organizationId: org3,
      kind: "report_failed",
      key: "report_drafts:2026-09",
      severity: "warning",
      title: "Utkasten kunde inte skapas",
      detail: "Test igen",
      rule: "Test",
      link: "https://elak.example/",
    });
    expect(second).toEqual({ id: first.id, created: false });
    await evaluateOrganization(db(), org3, new Date(Date.now() + 5 * 3_600_000));
    const [row] = await rows<{ status: string; occurrences: number; link: string }>(
      db(),
      sql`select status, occurrences, link from public.alerts where id = ${first.id}::uuid`,
    );
    // Externa länkar skrivs om till /drift.
    expect(row).toEqual({ status: "open", occurrences: 2, link: "/drift" });
    expect(await resolveSystemAlert(db(), org3, "report_drafts:2026-09")).toBe(1);
    expect(await resolveSystemAlert(db(), org3, "report_drafts:2026-09")).toBe(0);
  });

  it("databasen godtar familjen system men inga andra nya familjer", async () => {
    await expect(
      asPostgres((tx) =>
        tx.execute(sql`insert into public.alerts (organization_id, kind, severity, alert_group)
                       values (${orgId}::uuid, 'job_failed', 'critical', 'okand')`),
      ),
    ).rejects.toThrow();
  });
});
