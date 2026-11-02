/**
 * Datakällor (src/app/(app)/datakallor/_lib/service.ts) mot testdatabasen:
 * uppladdning i bitar, förhandsvisning, import, samma fil två gånger, mappning när
 * kolumner saknas, kön för okända automater, tidszon, radlogg och behörighet.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { LocalFileStore } from "../../src/import/file-store";
import { AuthorizationError, listOrganizationsFor } from "../../src/server/access";
import {
  appendChunkFor,
  createDataSourceFor,
  loadDatakallorFor,
  loadImportDetailFor,
  mapSourceMachineFor,
  previewUploadFor,
  runUploadFor,
  startUploadFor,
  updateDataSourceFor,
  type UploadDeps,
  type Viewer,
} from "../../src/app/(app)/datakallor/_lib/service";
import { UploadStaging } from "../../src/app/(app)/datakallor/_lib/staging";

import {
  asUser,
  createMember,
  createOrg,
  createUser,
  one,
  rows,
  uniqueSuffix,
  db,
  type TestUser,
} from "./helpers";
import { awishCsv, fixture } from "./import-fixtures";

const SEED = readFileSync(
  path.join(__dirname, "..", "fixtures", "seed", "awish-orderlista-2026-10-13--2026-11-01.csv"),
);

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

function newDeps(): UploadDeps {
  return {
    staging: new UploadStaging(),
    fileStore: new LocalFileStore(mkdtempSync(path.join(tmpdir(), "binderlab-import-"))),
  };
}

/** Laddar upp innehållet i bitar om `chunk` byte och returnerar uppladdningens id. */
async function upload(
  viewer: Viewer,
  deps: UploadDeps,
  content: Uint8Array | string,
  name = "orderlista.csv",
  chunk = 16 * 1024,
): Promise<string> {
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  const { uploadId } = await startUploadFor(viewer, deps, {
    fileName: name,
    size: bytes.byteLength,
  });
  for (let i = 0, off = 0; off < bytes.byteLength; i += 1, off += chunk) {
    await appendChunkFor(viewer, deps, {
      uploadId,
      index: i,
      bytes: bytes.slice(off, off + chunk),
    });
  }
  return uploadId;
}

interface Org {
  orgId: string;
  owner: TestUser;
  viewer: Viewer;
  sourceId: string;
}

async function newOrg(): Promise<Org> {
  const owner = await createUser(`dk-owner-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(owner, `Datakällor ${uniqueSuffix()}`);
  const viewer = await viewerFor(owner, orgId);
  const sourceId = await createDataSourceFor(viewer, {
    name: "Awish orderlista",
    sourceTimezone: "Asia/Shanghai",
  });
  return { orgId, owner, viewer, sourceId };
}

describe("uppladdning, förhandsvisning och import", () => {
  let org: Org;
  let deps: UploadDeps;

  beforeAll(async () => {
    org = await newOrg();
    deps = newDeps();
  });

  it("seed-filen i bitar: förhandsvisningen skriver inget, importen ger 460 nya", async () => {
    const id = await upload(org.viewer, deps, SEED, "seed.csv");
    const preview = await previewUploadFor(org.viewer, deps, {
      uploadId: id,
      dataSourceId: org.sourceId,
    });
    expect(preview.kind).toBe("preview");
    if (preview.kind !== "preview") return;
    expect(preview.result.summary.new).toBe(460);
    expect(preview.result.importId).toBeNull();
    expect(preview.result.rows.length).toBeLessThanOrEqual(100);
    expect(preview.result.rowsHidden).toBe(460 - preview.result.rows.length);
    // Tidszonskontrollen: order 42780, 2 nov. 00:17 i Shanghai = 1 nov. 17:17 svensk tid.
    expect(preview.result.firstRow).toMatchObject({
      externalId: "42780",
      sourceLocal: "2026-11-02 00:17:00",
      utc: "2026-11-01T16:17:00.000Z",
      businessDate: "2026-11-01",
    });
    const before = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.orders where organization_id = ${org.orgId}`,
    );
    expect(before.n).toBe(0);

    const done = await runUploadFor(org.viewer, deps, {
      uploadId: id,
      dataSourceId: org.sourceId,
      dryRun: false,
      expectedSha256: preview.result.file.sha256,
    });
    expect(done.importId).not.toBeNull();
    expect(done.summary.new).toBe(460);
    // Uppladdningen tas bort efter importen.
    await expect(
      runUploadFor(org.viewer, deps, { uploadId: id, dataSourceId: org.sourceId, dryRun: true }),
    ).rejects.toThrow(/finns inte längre/);
  });

  it("samma fil två gånger ger 0 nya, 460 dubbletter och en varning", async () => {
    const id = await upload(org.viewer, deps, SEED, "seed.csv", 100_000);
    const preview = await previewUploadFor(org.viewer, deps, {
      uploadId: id,
      dataSourceId: org.sourceId,
    });
    if (preview.kind !== "preview") throw new Error("väntade förhandsvisning");
    expect(preview.result.summary).toMatchObject({ new: 0, duplicate: 460, conflict: 0, error: 0 });
    expect(preview.result.warnings.map((w) => w.code)).toContain("duplicate_file");
    expect(preview.result.previousImports).toHaveLength(1);

    const done = await runUploadFor(org.viewer, deps, {
      uploadId: id,
      dataSourceId: org.sourceId,
      dryRun: false,
    });
    expect(done.summary.new).toBe(0);
    const count = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.orders where organization_id = ${org.orgId}`,
    );
    expect(count.n).toBe(460);

    const data = await loadDatakallorFor(org.viewer);
    expect(data.imports.map((i) => i.rowsNew)).toEqual([0, 460]);
    expect(data.imports[0]?.rowsDuplicate).toBe(460);
    expect(data.sources[0]?.orders).toBe(460);
    expect(data.sources[0]?.lastSyncedAt).not.toBeNull();
    // Hur ny datan är: den senaste ordern (1 nov. 17:17 svensk tid), inte uppladdningen.
    expect(data.sources[0]?.latestOrderAt).toBe("2026-11-01T16:17:00.000Z");
  });

  it("bitarna ligger i databasen (inte på disk) och tas bort efter importen", async () => {
    const id = await upload(org.viewer, deps, SEED, "seed.csv", 64 * 1024);
    const staged = await one<{ uploads: number; chunks: number; bytes: number }>(
      db(),
      sql`select (select count(*)::int from public.import_uploads where id = ${id}) as uploads,
                 (select count(*)::int from public.import_upload_chunks where upload_id = ${id}) as chunks,
                 (select coalesce(sum(octet_length(data)), 0)::int from public.import_upload_chunks
                   where upload_id = ${id}) as bytes`,
    );
    expect(staged).toEqual({
      uploads: 1,
      chunks: Math.ceil(SEED.byteLength / (64 * 1024)),
      bytes: SEED.byteLength,
    });
    await runUploadFor(org.viewer, deps, {
      uploadId: id,
      dataSourceId: org.sourceId,
      dryRun: false,
    });
    const left = await one<{ n: number }>(
      db(),
      sql`select (select count(*)::int from public.import_uploads where id = ${id})
               + (select count(*)::int from public.import_upload_chunks where upload_id = ${id}) as n`,
    );
    expect(left.n).toBe(0);
  });

  it("källans tidszon som förhandsvisades måste gälla vid importen och sparas med importen", async () => {
    const id = await upload(org.viewer, deps, SEED);
    await expect(
      runUploadFor(org.viewer, deps, {
        uploadId: id,
        dataSourceId: org.sourceId,
        dryRun: false,
        expectedSourceTimezone: "UTC",
      }),
    ).rejects.toThrow(/tidszon har ändrats/);
    const done = await runUploadFor(org.viewer, deps, {
      uploadId: id,
      dataSourceId: org.sourceId,
      dryRun: false,
      expectedSourceTimezone: "Asia/Shanghai",
    });
    // Tidszonen följer importen även när källans tidszon ändras senare.
    await updateDataSourceFor(org.viewer, { id: org.sourceId, sourceTimezone: "UTC" });
    const detail = await loadImportDetailFor(org.viewer, done.importId!, "nya");
    expect(detail?.sourceTimezone).toBe("Asia/Shanghai");
    expect(detail?.sourceTimezoneRecorded).toBe(true);
    await updateDataSourceFor(org.viewer, { id: org.sourceId, sourceTimezone: "Asia/Shanghai" });
  });

  it("en annan fil än den förhandsvisade importeras inte", async () => {
    const id = await upload(org.viewer, deps, SEED);
    await expect(
      runUploadFor(org.viewer, deps, {
        uploadId: id,
        dataSourceId: org.sourceId,
        dryRun: false,
        expectedSha256: "0".repeat(64),
      }),
    ).rejects.toThrow(/ändrats/);
  });
});

describe("bitarna", () => {
  it("omförsök av en bit ignoreras, en hoppad bit och för stor fil avvisas", async () => {
    const org = await newOrg();
    const deps = newDeps();
    const bytes = new TextEncoder().encode(awishCsv([{ no: "1", time: "2026-11-01 10:00:00" }]));
    const { uploadId } = await startUploadFor(org.viewer, deps, {
      fileName: "a.csv",
      size: bytes.byteLength,
    });
    const half = Math.floor(bytes.byteLength / 2);
    await appendChunkFor(org.viewer, deps, { uploadId, index: 0, bytes: bytes.slice(0, half) });
    // Samma bit igen (nätverksfel och omförsök): ingen dubblering.
    const again = await appendChunkFor(org.viewer, deps, {
      uploadId,
      index: 0,
      bytes: bytes.slice(0, half),
    });
    expect(again.received).toBe(half);
    await expect(
      appendChunkFor(org.viewer, deps, { uploadId, index: 2, bytes: bytes.slice(half) }),
    ).rejects.toThrow(/saknas/);
    // Inte färdig: kan inte förhandsvisas.
    await expect(
      previewUploadFor(org.viewer, deps, { uploadId, dataSourceId: org.sourceId }),
    ).rejects.toThrow(/inte färdiguppladdad/);
    await expect(
      appendChunkFor(org.viewer, deps, {
        uploadId,
        index: 1,
        bytes: new Uint8Array(bytes.byteLength),
      }),
    ).rejects.toThrow(/större än väntat/);
    await appendChunkFor(org.viewer, deps, { uploadId, index: 1, bytes: bytes.slice(half) });
    const preview = await previewUploadFor(org.viewer, deps, {
      uploadId,
      dataSourceId: org.sourceId,
    });
    expect(preview.kind === "preview" && preview.result.summary.new).toBe(1);

    await expect(
      startUploadFor(org.viewer, deps, { fileName: "x.csv", size: 51 * 1024 * 1024 }),
    ).rejects.toThrow(/för stor/);
  });

  it("en annan användare kan inte läsa uppladdningen, inte ens en admin i samma organisation", async () => {
    const org = await newOrg();
    const deps = newDeps();
    const id = await upload(org.viewer, deps, SEED);
    const admin = await createMember(org.orgId, "admin");
    const adminViewer = await viewerFor(admin, org.orgId);
    await expect(
      previewUploadFor(adminViewer, deps, { uploadId: id, dataSourceId: org.sourceId }),
    ).rejects.toThrow(/finns inte längre/);
    // RLS: varken admin, läsare eller påfyllare ser någon annans bitar.
    for (const role of ["admin", "viewer", "refiller"] as const) {
      const member = role === "admin" ? admin : await createMember(org.orgId, role);
      const seen = await asUser(member, (tx) =>
        one<{ n: number }>(
          tx,
          sql`select (select count(*)::int from public.import_uploads)
                   + (select count(*)::int from public.import_upload_chunks) as n`,
        ),
      );
      expect(seen.n).toBe(0);
    }
  });

  it("uppladdningar äldre än ett dygn tas bort vid nästa uppladdning", async () => {
    const org = await newOrg();
    const deps = newDeps();
    const old = await upload(org.viewer, deps, SEED);
    const later = new Date(Date.now() + 25 * 60 * 60 * 1000);
    await deps.staging.start(
      { organizationId: org.orgId, user: org.viewer.user },
      { fileName: "ny.csv", size: 10 },
      later,
    );
    const left = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.import_upload_chunks where upload_id = ${old}`,
    );
    expect(left.n).toBe(0);
  });
});

describe("kolumnmappning", () => {
  it("saknas kolumner får användaren välja; vald mappning sparas på källan vid import", async () => {
    const org = await newOrg();
    const deps = newDeps();
    const csv = [
      "Nr,Vara,Plats,Summa,Status,Tidpunkt",
      '5001,Mystery Pack,BL-001 Centrum,"Amount: 199.00",Paid Success,2026-11-01 12:00:00',
    ].join("\n");
    const id = await upload(org.viewer, deps, csv);
    const first = await previewUploadFor(org.viewer, deps, {
      uploadId: id,
      dataSourceId: org.sourceId,
    });
    expect(first.kind).toBe("mapping");
    if (first.kind !== "mapping") return;
    expect(first.needed.mapping.headers).toEqual([
      "Nr",
      "Vara",
      "Plats",
      "Summa",
      "Status",
      "Tidpunkt",
    ]);
    expect(first.needed.missing.length).toBeGreaterThan(0);

    const mapping = {
      columns: {
        externalId: "Nr",
        title: "Vara",
        machine: "Plats",
        amount: "Summa",
        isPaid: "Status",
        paidAt: "Tidpunkt",
      },
    };
    const second = await previewUploadFor(org.viewer, deps, {
      uploadId: id,
      dataSourceId: org.sourceId,
      mapping,
    });
    expect(second.kind).toBe("preview");
    if (second.kind !== "preview") return;
    expect(second.result.summary.new).toBe(1);
    expect(second.result.mapping?.source.externalId).toBe("override");

    await runUploadFor(org.viewer, deps, {
      uploadId: id,
      dataSourceId: org.sourceId,
      mapping,
      dryRun: false,
      saveMapping: true,
    });
    const data = await loadDatakallorFor(org.viewer);
    expect(data.sources[0]?.savedMapping?.externalId).toBe("Nr");

    // Nästa fil med samma rubriker mappas med den sparade mappningen.
    const next = await upload(org.viewer, deps, csv.replace("5001", "5002"));
    const third = await previewUploadFor(org.viewer, deps, {
      uploadId: next,
      dataSourceId: org.sourceId,
    });
    expect(third.kind === "preview" && third.result.mapping?.source.externalId).toBe("saved");
  });
});

describe("okända automater, tidszon och radlogg", () => {
  let org: Org;
  let deps: UploadDeps;
  let importId: string;

  beforeAll(async () => {
    org = await newOrg();
    deps = newDeps();
    // 42780 i den här filen avviker från seed-filen (annan titel och automat) → konflikt.
    await runUploadFor(org.viewer, deps, {
      uploadId: await upload(org.viewer, deps, SEED),
      dataSourceId: org.sourceId,
      dryRun: false,
    });
    const r = await runUploadFor(org.viewer, deps, {
      uploadId: await upload(org.viewer, deps, fixture("orderlista-2026-11-02.csv")),
      dataSourceId: org.sourceId,
      dryRun: false,
    });
    importId = r.importId!;
    expect(r.summary).toMatchObject({ conflict: 1, error: 2 });
  });

  it("kön visar okända automater med väntande order och ett förslag", async () => {
    const machine = await asUser(org.owner, (tx) =>
      one<{ id: string }>(
        tx,
        sql`insert into public.machines (organization_id, code, name, active_from)
            values (${org.orgId}, 'BL-001', 'Centrum', '2025-01-01') returning id`,
      ),
    );
    const data = await loadDatakallorFor(org.viewer);
    const centrum = data.queue.find((q) => q.externalName === "BL-001 Centrum");
    expect(centrum?.pendingOrders).toBeGreaterThan(0);
    expect(centrum?.suggestedMachineId).toBe(machine.id);

    const result = await mapSourceMachineFor(org.viewer, {
      sourceMachineId: centrum!.id,
      machineId: machine.id,
    });
    expect(result.orders).toBe(centrum!.pendingOrders);
    const left = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.orders
          where organization_id = ${org.orgId} and source_machine_id = ${centrum!.id} and machine_id is null`,
    );
    expect(left.n).toBe(0);
    const audit = await rows<{ actor_id: string }>(
      db(),
      sql`select actor_id from public.audit_log
          where organization_id = ${org.orgId} and table_name = 'source_machines' and row_id = ${centrum!.id}`,
    );
    expect(audit.map((a) => a.actor_id)).toEqual([org.owner.id]);

    // En kopplad källautomat kopplas inte om.
    await expect(
      mapSourceMachineFor(org.viewer, { sourceMachineId: centrum!.id, machineId: machine.id }),
    ).rejects.toThrow(/redan kopplad/);
    const after = await loadDatakallorFor(org.viewer);
    expect(after.queue.some((q) => q.id === centrum!.id)).toBe(false);
    expect(after.lastMapped).toMatchObject({ machineCode: "BL-001", name: "BL-001 Centrum" });
  });

  it("kön visar inte källautomater från arkiverade källor", async () => {
    const other = await newOrg();
    await runUploadFor(other.viewer, deps, {
      uploadId: await upload(other.viewer, deps, fixture("orderlista-2026-11-02.csv")),
      dataSourceId: other.sourceId,
      dryRun: false,
    });
    expect((await loadDatakallorFor(other.viewer)).queue.length).toBeGreaterThan(0);
    await asUser(other.owner, (tx) =>
      tx.execute(
        sql`update public.data_sources set archived_at = now()
            where organization_id = ${other.orgId} and id = ${other.sourceId}`,
      ),
    );
    expect((await loadDatakallorFor(other.viewer)).queue).toEqual([]);
  });

  it("radloggen filtrerar fel och konflikter och läser fälten ur källraden", async () => {
    const problems = await loadImportDetailFor(org.viewer, importId, "problem");
    expect(problems?.counts).toMatchObject({ conflict: 1, error: 2 });
    expect(problems?.rows.map((r) => r.status).sort()).toEqual(["conflict", "error", "error"]);
    const conflict = problems?.rows.find((r) => r.status === "conflict");
    expect(conflict?.externalId).toBe("42780");
    expect(conflict?.paidAt).toBe("2026-11-02 00:17:00");
    expect(conflict?.message).toBeTruthy();
    const errors = await loadImportDetailFor(org.viewer, importId, "fel");
    expect(errors?.rows.every((r) => r.status === "error")).toBe(true);
    expect(await loadImportDetailFor(org.viewer, "not-a-uuid", "problem")).toBeNull();
  });

  it("byte av källans tidszon loggas och ändrar tolkningen i nästa förhandsvisning", async () => {
    await updateDataSourceFor(org.viewer, { id: org.sourceId, sourceTimezone: "Europe/Stockholm" });
    const audit = await rows<{ before: string; after: string }>(
      db(),
      sql`select before->>'source_timezone' as before, after->>'source_timezone' as after
          from public.audit_log
          where organization_id = ${org.orgId} and table_name = 'data_sources' and action = 'update'
          order by occurred_at desc limit 1`,
    );
    expect(audit[0]).toEqual({ before: "Asia/Shanghai", after: "Europe/Stockholm" });
    const preview = await previewUploadFor(org.viewer, deps, {
      uploadId: await upload(org.viewer, deps, SEED),
      dataSourceId: org.sourceId,
    });
    if (preview.kind !== "preview") throw new Error("väntade förhandsvisning");
    expect(preview.result.firstRow?.utc).toBe("2026-11-01T23:17:00.000Z");
    // Orderna finns redan med Shanghai-tid: samma ordernummer med ny tid blir konflikter.
    expect(preview.result.summary.conflict).toBeGreaterThan(0);
  });

  it("importer loggas inte i audit_log för varje synk (last_synced_at strippas)", async () => {
    const audit = await rows<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.audit_log
          where organization_id = ${org.orgId} and table_name = 'data_sources' and action = 'update'`,
    );
    // Bara tidszonsbytet (två importer har körts mot källan).
    expect(audit[0]?.n).toBe(1);
  });
});

describe("behörighet", () => {
  let org: Org;
  let deps: UploadDeps;

  beforeAll(async () => {
    org = await newOrg();
    deps = newDeps();
  });

  it.each(["viewer", "refiller"] as const)(
    "%s får varken läsa sidan eller ändra något",
    async (role) => {
      const member = await createMember(org.orgId, role);
      const v = await viewerFor(member, org.orgId);
      for (const op of [
        () => loadDatakallorFor(v),
        () => startUploadFor(v, deps, { fileName: "a.csv", size: 10 }),
        () => createDataSourceFor(v, { name: "X", sourceTimezone: "UTC" }),
        () => updateDataSourceFor(v, { id: org.sourceId, sourceTimezone: "UTC" }),
        () =>
          mapSourceMachineFor(v, {
            sourceMachineId: org.sourceId,
            machineId: org.sourceId,
          }),
      ]) {
        await expect(op()).rejects.toBeInstanceOf(AuthorizationError);
      }
    },
  );

  it("ägaren i en annan organisation når inte källan, ens med rätt id", async () => {
    const other = await newOrg();
    await expect(
      updateDataSourceFor(other.viewer, { id: org.sourceId, sourceTimezone: "UTC" }),
    ).rejects.toThrow(/finns inte/);
    const id = await upload(other.viewer, deps, SEED);
    await expect(
      previewUploadFor(other.viewer, deps, { uploadId: id, dataSourceId: org.sourceId }),
    ).rejects.toThrow(/finns inte/);
  });
});
