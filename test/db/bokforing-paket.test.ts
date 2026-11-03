/**
 * Bokföring: sparade månadspaket mot testdatabasen (20261104130000_bokforing_paket.sql).
 *
 * - RLS: ägare, admin och läsare ser raden; påfyllaren och andra organisationer ser
 *   ingenting; ingen klientroll kan skriva.
 * - Jobbet (runBokforingForAll): förra månadens paket sparas, samma underlag ger inget nytt,
 *   ett nytt kvitto ger nästa version, vinstdelning utan inköpspris ger ett preliminärt paket.
 * - Nedladdningen (storedPackageFor) skickar det sparade paketet; påfyllaren nekas.
 * - Raden i Att göra (readyPackageFor) och private.bokforing_cron_tick.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { getServiceDb } from "../../src/db/client";
import * as s from "../../src/db/schema";
import { LocalFileStore } from "../../src/import/file-store";
import { AuthorizationError, listOrganizationsFor } from "../../src/server/access";
import { DEFAULT_PLAN } from "../../src/server/bokforing/plan";
import {
  loadBokforingFor,
  markMonthSentFor,
  saveBokforingSettingsFor,
  uploadReceiptFor,
} from "../../src/server/bokforing/service";
import {
  readyPackageFor,
  runBokforingForAll,
  storedPackageFor,
  type PackageDeps,
} from "../../src/server/bokforing/stored";
import type { Viewer } from "../../src/server/data/core/loaders";

import {
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  one,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

vi.mock("server-only", () => ({}));

const TODAY = "2026-11-03";
const NOW = new Date("2026-11-03T08:00:00Z");

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let dir: string;
let deps: PackageDeps;
let receipts: LocalFileStore;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "binderlab-bokforing-paket-"));
  receipts = new LocalFileStore(path.join(dir, "receipts"));
  deps = {
    db: getServiceDb(),
    receipts,
    packages: new LocalFileStore(path.join(dir, "packages")),
    renderPdf: null,
  };
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Org {
  orgId: string;
  owner: TestUser;
  ownerV: Viewer;
  viewer: TestUser;
  viewerV: Viewer;
  refiller: TestUser;
  refillerV: Viewer;
  ids: {
    storeId: string;
    dataSourceId: string;
    sourceMachineId: string;
    machineId: string;
    titleId: string;
    importId: string;
  };
}

/** Organisation med butik (provision 10 %), automat, titel (inköpspris 20 kr) och en källa. */
async function seedOrg(): Promise<Org> {
  const owner = await createUser(`agare-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(owner, `Paket ${uniqueSuffix()}`);
  const ids = await asUser(owner, async (tx) => {
    const org = { organizationId: orgId };
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: "Butik Ett" })
      .returning();
    await tx
      .insert(s.storeAgreements)
      .values({ ...org, storeId: store!.id, validFrom: "2025-01-01", commissionBp: 1000 });
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
      .values({
        ...org,
        provider: "awish_csv",
        name: "Awish CSV",
        sourceTimezone: "Europe/Stockholm",
      })
      .returning();
    const [sm] = await tx
      .insert(s.sourceMachines)
      .values({
        ...org,
        dataSourceId: source!.id,
        externalId: "AW-1",
        externalName: "Automat",
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
        fileSha256: "b".repeat(64),
        storagePath: `${orgId}/imports/orders.csv`,
        parserVersion: "awish-csv@1",
        status: "succeeded",
      })
      .returning();
    return {
      storeId: store!.id,
      dataSourceId: source!.id,
      sourceMachineId: sm!.id,
      machineId: machine!.id,
      titleId: title!.id,
      importId: imp!.id,
    };
  });
  const viewer = await createMember(orgId, "viewer");
  const refiller = await createMember(orgId, "refiller");
  const ownerV = await viewerFor(owner, orgId);
  await saveBokforingSettingsFor(ownerV, {
    plan: { ...DEFAULT_PLAN },
    series: "A",
    orgNumber: "",
    purchaseBasis: "cost_of_goods",
    openingCarryOre: 0,
  });
  return {
    orgId,
    owner,
    ownerV,
    viewer,
    viewerV: await viewerFor(viewer, orgId),
    refiller,
    refillerV: await viewerFor(refiller, orgId),
    ids,
  };
}

async function addOrders(o: Org, month: string, count: number, titleId = o.ids.titleId) {
  await asUser(o.owner, (tx) =>
    tx.insert(s.orders).values(
      Array.from({ length: count }, (_, i) => ({
        organizationId: o.orgId,
        dataSourceId: o.ids.dataSourceId,
        externalId: `${month}-${i}-${uniqueSuffix()}`,
        rawTitle: "Pokemon 151",
        titleId,
        orderedAt: new Date(`${month}-${String(1 + i).padStart(2, "0")}T10:00:00Z`),
        amountOre: 10_000,
        sourceMachineId: o.ids.sourceMachineId,
        machineId: o.ids.machineId,
        importId: o.ids.importId,
        sourceHash: `h-${uniqueSuffix()}`,
      })),
    ),
  );
}

function zipNames(bytes: Uint8Array): Map<string, Buffer> {
  const b = Buffer.from(bytes);
  const eocd = b.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const count = b.readUInt16LE(eocd + 10);
  let p = b.readUInt32LE(eocd + 16);
  const out = new Map<string, Buffer>();
  for (let i = 0; i < count; i++) {
    const method = b.readUInt16LE(p + 10);
    const csize = b.readUInt32LE(p + 20);
    const nlen = b.readUInt16LE(p + 28);
    const elen = b.readUInt16LE(p + 30);
    const clen = b.readUInt16LE(p + 32);
    const off = b.readUInt32LE(p + 42);
    const name = b.subarray(p + 46, p + 46 + nlen).toString("utf8");
    const start = off + 30 + b.readUInt16LE(off + 26) + b.readUInt16LE(off + 28);
    const body = b.subarray(start, start + csize);
    out.set(name, method === 8 ? inflateRawSync(body) : Buffer.from(body));
    p += 46 + nlen + elen + clen;
  }
  return out;
}

const PDF = new TextEncoder().encode("%PDF-1.4\n% kvitto paket\n");

const run = (o: Org, now = NOW) => runBokforingForAll({ ...deps, now, organizationIds: [o.orgId] });

// ---------------------------------------------------------------------------

describe("jobbet: förra månadens paket sparas", () => {
  let o: Org;
  beforeAll(async () => {
    o = await seedOrg();
    await addOrders(o, "2026-10", 3);
  });

  it("sparar oktober som klart (version 1), en andra körning gör ingenting", async () => {
    const first = await run(o);
    expect(first.organizations).toEqual([
      { id: o.orgId, month: "2026-10", status: "created", version: 1, packageStatus: "final" },
    ]);
    const again = await run(o);
    expect(again.organizations).toEqual([
      { id: o.orgId, month: "2026-10", status: "unchanged", version: 1, packageStatus: "final" },
    ]);
    const view = await loadBokforingFor(o.ownerV, TODAY);
    expect(view.months.find((m) => m.month === "2026-10")!.stored).toEqual({
      version: 1,
      status: "final",
      reason: null,
    });
  });

  it("ett nytt kvitto ger version 2, och nedladdningen skickar det sparade paketet", async () => {
    await uploadReceiptFor(
      o.ownerV,
      "2026-10",
      { name: "kvitto.pdf", bytes: PDF },
      TODAY,
      receipts,
    );
    const r = await run(o);
    expect(r.organizations[0]).toMatchObject({ status: "created", version: 2 });

    const pkg = await storedPackageFor(o.viewerV, "2026-10", TODAY, deps);
    expect(pkg.stored.version).toBe(2);
    expect(pkg.fileName).toBe("bokforing-2026-10.zip");
    const names = [...zipNames(pkg.bytes).keys()];
    expect(names).toContain("verifikation-2026-10.si");
    expect(names).toContain("kvitton/001-kvitto.pdf");
    // Samma underlag: ingen ny version vid nedladdningen.
    expect((await storedPackageFor(o.ownerV, "2026-10", TODAY, deps)).stored.version).toBe(2);
  });

  it("påfyllaren får inte ladda ned; en pågående månad nekas", async () => {
    await expect(storedPackageFor(o.refillerV, "2026-10", TODAY, deps)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(storedPackageFor(o.ownerV, "2026-11", TODAY, deps)).rejects.toThrow(/pågår/);
  });

  it("Att göra: en rad tills månaden är skickad; bara ägare och admin", async () => {
    expect(await readyPackageFor(o.ownerV)).toEqual({
      month: "2026-10",
      status: "final",
      reason: null,
      version: 2,
    });
    expect(await readyPackageFor(o.viewerV)).toBeNull();
    expect(await readyPackageFor(o.refillerV)).toBeNull();
    await markMonthSentFor(o.ownerV, "2026-10", TODAY);
    expect(await readyPackageFor(o.ownerV)).toBeNull();
  });
});

describe("jobbet: vinstdelning utan inköpspris ger ett preliminärt paket", () => {
  let o: Org;
  beforeAll(async () => {
    o = await seedOrg();
    await asUser(o.owner, async (tx) => {
      await tx.execute(
        sql`update public.store_agreements set valid_to = '2026-09-30' where store_id = ${o.ids.storeId}`,
      );
      await tx.execute(sql`insert into public.store_agreements
          (organization_id, store_id, valid_from, commission_base, commission_bp, loss_treatment)
        values (${o.orgId}, ${o.ids.storeId}, '2026-10-01', 'profit_after_costs', 5000, 'zero')`);
    });
    const unpriced = await asUser(o.owner, async (tx) => {
      const [t] = await tx
        .insert(s.titles)
        .values({ organizationId: o.orgId, name: `Utan pris ${uniqueSuffix()}` })
        .returning();
      return t!.id;
    });
    await addOrders(o, "2026-10", 2);
    await addOrders(o, "2026-10", 1, unpriced);
  });

  it("status preliminär med en rad om varför, och raden i Att göra säger det", async () => {
    const r = await run(o);
    expect(r.organizations[0]).toMatchObject({
      status: "created",
      version: 1,
      packageStatus: "preliminary",
    });
    const pkg = await storedPackageFor(o.ownerV, "2026-10", TODAY, deps);
    expect(pkg.fileName).toBe("bokforing-2026-10-preliminar.zip");
    expect(zipNames(pkg.bytes).get("LAS-MIG.txt")!.toString("utf8")).toContain(
      "PRELIMINÄR: 1 order saknar inköpspris, så butikens andel är inte klar.",
    );
    expect(await readyPackageFor(o.ownerV)).toMatchObject({
      status: "preliminary",
      reason: "1 order saknar inköpspris, så butikens andel är inte klar.",
    });
  });

  it("när priset läggs in blir nästa version klar", async () => {
    await asUser(o.owner, async (tx) => {
      const [t] = await rows<{ id: string }>(
        tx,
        sql`select id from public.titles where organization_id = ${o.orgId} and name like 'Utan pris%'`,
      );
      await tx.insert(s.purchasePrices).values({
        organizationId: o.orgId,
        titleId: t!.id,
        unitCostOre: 3000,
        validFrom: "2025-01-01",
      });
    });
    const r = await run(o);
    expect(r.organizations[0]).toMatchObject({
      status: "created",
      version: 2,
      packageStatus: "final",
    });
  });
});

describe("jobbet: ingenting före den första månaden med order", () => {
  it("en organisation med order bara i innevarande månad får inget paket", async () => {
    const o = await seedOrg();
    await addOrders(o, "2026-11", 1);
    const r = await run(o);
    expect(r.organizations).toEqual([{ id: o.orgId, month: "2026-10", status: "empty" }]);
    expect(await readyPackageFor(o.ownerV)).toBeNull();
  });
});

describe("behörigheter (RLS) för bookkeeping_packages", () => {
  let o: Org;
  let other: Org;
  beforeAll(async () => {
    o = await seedOrg();
    other = await seedOrg();
    await addOrders(o, "2026-10", 1);
    await run(o);
  });

  it("ägare och läsare ser raden; påfyllaren och andra organisationer ser ingenting", async () => {
    const count = (u: TestUser) =>
      asUser(u, async (tx) =>
        one<{ n: number }>(
          tx,
          sql`select count(*)::int as n from public.bookkeeping_packages where organization_id = ${o.orgId}`,
        ),
      );
    expect((await count(o.owner)).n).toBe(1);
    expect((await count(o.viewer)).n).toBe(1);
    expect((await count(o.refiller)).n).toBe(0);
    expect((await count(other.owner)).n).toBe(0);
  });

  it("ingen klientroll kan skriva", async () => {
    const ins = await asUser(o.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`insert into public.bookkeeping_packages
          (organization_id, month, version, status, fingerprint, storage_path, file_name, size_bytes, file_sha256)
          values (${o.orgId}, '2026-09-01', 1, 'final', ${"a".repeat(64)},
                  ${`${o.orgId}/2026-09/v1-${"b".repeat(64)}.zip`}, 'x.zip', 1, ${"b".repeat(64)})`),
      ),
    );
    expect(ins.ok).toBe(false);
    const upd = await asUser(o.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.bookkeeping_packages set version = 9 where organization_id = ${o.orgId}`,
        ),
      ),
    );
    expect(upd.ok).toBe(false);
  });
});

describe("pg_cron: private.bokforing_cron_tick", () => {
  it("finns och gör ingenting utan pg_net", async () => {
    const r = await getServiceDb().execute(
      sql`select private.bokforing_cron_tick() as r, to_regnamespace('net') is null as no_net`,
    );
    const row = Array.from(r)[0] as { r: unknown; no_net: boolean };
    if (row.no_net) expect(row.r).toBeNull();
  });

  it("kan inte köras av klientroller", async () => {
    const o = await seedOrg();
    const res = await asUser(o.owner, (tx) =>
      attempt(tx, (sp) => sp.execute(sql`select private.bokforing_cron_tick()`)),
    );
    expect(res.ok).toBe(false);
  });
});
