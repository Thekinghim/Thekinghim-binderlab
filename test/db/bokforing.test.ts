/**
 * Ekonomi → Bokföring mot testdatabasen (20261103210000_bokforing.sql):
 *
 * - RLS och kolumnbehörigheter: läsaren ser men ändrar inget, påfyllaren och andra
 *   organisationer ser ingenting; "skickad" sätts med tid och användare av databasen och kan
 *   inte sättas för en månad som inte är slut; bucketen 'receipts' följer samma policy.
 * - Tjänsten: månadsraderna med VMB och underskott som förs vidare, markera som skickad med
 *   ögonblicksbild (och ändrad sedan), kvitton (typkontroll, dubbletter, borttagning) och
 *   månadspaketet (ZIP med SIE, sammanfattning, Excel och kvitton).
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { inflateRawSync } from "node:zlib";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { LocalFileStore } from "../../src/import/file-store";
import { decodeCp437 } from "../../src/reports";
import { AuthorizationError, listOrganizationsFor } from "../../src/server/access";
import {
  archiveReceiptFor,
  loadBokforingFor,
  markMonthSentFor,
  monthPackageFor,
  readReceiptFor,
  saveBokforingSettingsFor,
  setBokforingVmbFor,
  unmarkMonthSentFor,
  uploadReceiptFor,
} from "../../src/server/bokforing/service";
import { DEFAULT_PLAN } from "../../src/server/bokforing/plan";
import type { Viewer } from "../../src/server/data/core/loaders";

import {
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

vi.mock("server-only", () => ({}));

const TODAY = "2026-11-03";

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let dir: string;
let files: LocalFileStore;
beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "binderlab-bokforing-"));
  files = new LocalFileStore(dir);
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

interface Org {
  orgId: string;
  owner: TestUser;
  ownerV: Viewer;
  adminV: Viewer;
  viewer: TestUser;
  viewerV: Viewer;
  refiller: TestUser;
  refillerV: Viewer;
  ids: {
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
  const orgId = await createOrg(owner, `Bokföring ${uniqueSuffix()}`);
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
      dataSourceId: source!.id,
      sourceMachineId: sm!.id,
      machineId: machine!.id,
      titleId: title!.id,
      importId: imp!.id,
    };
  });
  const admin = await createMember(orgId, "admin");
  const viewer = await createMember(orgId, "viewer");
  const refiller = await createMember(orgId, "refiller");
  return {
    orgId,
    owner,
    ownerV: await viewerFor(owner, orgId),
    adminV: await viewerFor(admin, orgId),
    viewer,
    viewerV: await viewerFor(viewer, orgId),
    refiller,
    refillerV: await viewerFor(refiller, orgId),
    ids,
  };
}

/** `count` order à `amountOre` i månaden, en per dag mitt på dagen. */
async function addOrders(o: Org, month: string, count: number, amountOre = 10_000, startDay = 1) {
  await asUser(o.owner, (tx) =>
    tx.insert(s.orders).values(
      Array.from({ length: count }, (_, i) => ({
        organizationId: o.orgId,
        dataSourceId: o.ids.dataSourceId,
        externalId: `${month}-${i}-${uniqueSuffix()}`,
        rawTitle: "Pokemon 151",
        titleId: o.ids.titleId,
        orderedAt: new Date(`${month}-${String(startDay + i).padStart(2, "0")}T10:00:00Z`),
        amountOre,
        sourceMachineId: o.ids.sourceMachineId,
        machineId: o.ids.machineId,
        importId: o.ids.importId,
        sourceHash: `h-${uniqueSuffix()}`,
      })),
    ),
  );
}

const settings = (over: Record<string, unknown> = {}) => ({
  plan: { ...DEFAULT_PLAN },
  series: "A",
  orgNumber: "",
  purchaseBasis: "cost_of_goods" as const,
  openingCarryOre: 0,
  ...over,
});

const PDF = new TextEncoder().encode("%PDF-1.4\n% kvitto\n");

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

// ---------------------------------------------------------------------------

describe("behörigheter (RLS)", () => {
  let o: Org;
  let other: Org;
  beforeAll(async () => {
    o = await seedOrg();
    other = await seedOrg();
    await saveBokforingSettingsFor(o.adminV, settings());
    await addOrders(o, "2026-09", 2);
  });

  it("läsaren ser inställningarna men kan inte skriva; påfyllaren och andra ser inget", async () => {
    const count = (u: TestUser) =>
      asUser(
        u,
        async (tx) =>
          (
            await rows<{ n: number }>(
              tx,
              sql`select count(*)::int as n from public.bookkeeping_settings where organization_id = ${o.orgId}`,
            )
          )[0]!.n,
      );
    expect(await count(o.viewer)).toBe(1);
    expect(await count(o.refiller)).toBe(0);
    expect(await count(other.owner)).toBe(0);

    const write = (u: TestUser, q: ReturnType<typeof sql>) =>
      asUser(u, (tx) => attempt(tx, (sp) => sp.execute(q)));
    const upd = sql`update public.bookkeeping_settings set voucher_series = 'B' where organization_id = ${o.orgId}`;
    const viewerUpd = await write(o.viewer, upd);
    // RLS: inga rader påverkas för läsaren (eller nekas).
    const series = await asUser(
      o.owner,
      async (tx) =>
        (
          await rows<{ v: string }>(
            tx,
            sql`select voucher_series as v from public.bookkeeping_settings where organization_id = ${o.orgId}`,
          )
        )[0]!.v,
    );
    expect(viewerUpd.ok === false || series === "A").toBe(true);
    expect(series).toBe("A");
    const ins = await write(
      o.viewer,
      sql`insert into public.bookkeeping_months (organization_id, month, sent_at) values (${o.orgId}, '2026-09-01', now())`,
    );
    expect(ins.ok).toBe(false);
    const foreign = await write(
      other.owner,
      sql`insert into public.bookkeeping_receipts (organization_id, month, storage_path, file_name, content_type, size_bytes, file_sha256)
          values (${o.orgId}, '2026-09-01', ${`${o.orgId}/2026-09/${"a".repeat(64)}.pdf`}, 'x.pdf', 'application/pdf', 10, ${"a".repeat(64)})`,
    );
    expect(foreign.ok).toBe(false);
  });

  it("tjänsten nekar läsaren ändringar och påfyllaren allt", async () => {
    await expect(saveBokforingSettingsFor(o.viewerV, settings())).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(markMonthSentFor(o.viewerV, "2026-09", TODAY)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(
      uploadReceiptFor(o.viewerV, "2026-09", { name: "k.pdf", bytes: PDF }, TODAY, files),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(loadBokforingFor(o.refillerV, TODAY)).rejects.toBeInstanceOf(AuthorizationError);
    await expect(monthPackageFor(o.refillerV, "2026-09", TODAY)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    const view = await loadBokforingFor(o.viewerV, TODAY);
    expect(view.months.map((m) => m.month)).toEqual(["2026-11", "2026-10", "2026-09"]);
  });

  it("skickad: tid och användare sätts av databasen, en pågående månad nekas", async () => {
    const fake = "00000000-0000-0000-0000-000000000001";
    await asUser(o.owner, (tx) =>
      tx.execute(
        sql`insert into public.bookkeeping_months (organization_id, month, sent_at) values (${o.orgId}, '2026-09-01', '2000-01-01')`,
      ),
    );
    const [row] = await asUser(o.owner, (tx) =>
      rows<{ sent_by: string; old: boolean }>(
        tx,
        sql`select sent_by, sent_at < now() - interval '1 day' as old from public.bookkeeping_months where organization_id = ${o.orgId} and month = '2026-09-01'`,
      ),
    );
    expect(row!.sent_by).toBe(o.owner.id);
    expect(row!.old).toBe(false);
    const setBy = await asUser(o.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.bookkeeping_months set sent_by = ${fake} where organization_id = ${o.orgId}`,
        ),
      ),
    );
    expect(setBy.ok).toBe(false); // ingen kolumnbehörighet
    const current = await asUser(o.owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.bookkeeping_months (organization_id, month, sent_at) values (${o.orgId}, date_trunc('month', now())::date, now())`,
        ),
      ),
    );
    expect(current.ok).toBe(false);
    if (!current.ok) expect(current.code).toBe("22023");
    await expect(markMonthSentFor(o.ownerV, "2026-11", TODAY)).rejects.toThrow(/inte slut/);
  });

  it("storage: bucket receipts följer samma policy som contracts", async () => {
    const p = `${o.orgId}/2026-09/${"c".repeat(64)}.pdf`;
    const upload = (u: TestUser) =>
      asUser(u, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`insert into storage.objects (bucket_id, name, owner) values ('receipts', ${p}, ${u.id})`,
          ),
        ),
      );
    expect((await upload(o.viewer)).ok).toBe(false);
    expect((await upload(o.refiller)).ok).toBe(false);
    expect((await upload(other.owner)).ok).toBe(false);
    expect((await upload(o.owner)).ok).toBe(true);
    const visible = (u: TestUser) =>
      asUser(
        u,
        async (tx) =>
          (
            await rows<{ n: number }>(
              tx,
              sql`select count(*)::int as n from storage.objects where bucket_id = 'receipts' and name = ${p}`,
            )
          )[0]!.n,
      );
    expect(await visible(o.viewer)).toBe(1);
    expect(await visible(o.refiller)).toBe(0);
    expect(await visible(other.owner)).toBe(0);
  });
});

describe("månader, VMB och skickad", () => {
  let o: Org;
  beforeAll(async () => {
    o = await seedOrg();
    // September: 10 × 100 kr (inköp 10 × 20 kr). Oktober: 5 × 100 kr.
    await addOrders(o, "2026-09", 10);
    await addOrders(o, "2026-10", 5);
    await saveBokforingSettingsFor(o.ownerV, settings({ openingCarryOre: 90_000 }));
    // "VMB i bokföringen" på (standard av): samma utfall som före valet.
    await setBokforingVmbFor(o.ownerV, true);
  });

  it("en rad per månad, nyast först, med VMB och underskott som förs vidare", async () => {
    const view = await loadBokforingFor(o.ownerV, TODAY);
    expect(view.settings.saved).toBe(true);
    expect(view.months.map((m) => [m.month, m.status])).toEqual([
      ["2026-11", "open"],
      ["2026-10", "closed"],
      ["2026-09", "closed"],
    ]);
    const sep = view.months.find((m) => m.month === "2026-09")!.book;
    expect(sep.salesInclVatOre).toBe(100_000);
    expect(sep.purchasesOre).toBe(20_000);
    expect(sep.vmb).toMatchObject({
      carryInOre: 90_000,
      marginOre: -10_000,
      vatOre: 0,
      carryOutOre: 10_000,
    });
    expect(sep.storeShareOre).toBe(10_000);
    const oct = view.months.find((m) => m.month === "2026-10")!.book;
    expect(oct.vmb).toMatchObject({ carryInOre: 10_000, marginOre: 30_000, vatOre: 6_000 });
    expect(oct.resultOre).toBe(50_000 - 6_000 - 10_000 - 0 - 5_000);
  });

  it("markera som skickad sparar siffrorna; ändringar efteråt syns, underskottet följer det skickade", async () => {
    await markMonthSentFor(o.adminV, "2026-09", TODAY);
    let view = await loadBokforingFor(o.viewerV, TODAY);
    const sep = view.months.find((m) => m.month === "2026-09")!;
    expect(sep.status).toBe("sent");
    expect(sep.sentAt).not.toBeNull();
    expect(sep.changedSinceSent).toBe(false);

    // En sen order i september: siffrorna ändras, men oktober fortsätter från det skickade.
    await addOrders(o, "2026-09", 1, 10_000, 20);
    view = await loadBokforingFor(o.ownerV, TODAY);
    const sep2 = view.months.find((m) => m.month === "2026-09")!;
    expect(sep2.changedSinceSent).toBe(true);
    expect(sep2.book.vmb.carryOutOre).toBe(2_000);
    expect(view.months.find((m) => m.month === "2026-10")!.book.vmb.carryInOre).toBe(10_000);

    await unmarkMonthSentFor(o.ownerV, "2026-09");
    view = await loadBokforingFor(o.ownerV, TODAY);
    expect(view.months.find((m) => m.month === "2026-09")!.status).toBe("closed");
    expect(view.months.find((m) => m.month === "2026-10")!.book.vmb.carryInOre).toBe(2_000);
  });

  it("kontoplanen valideras och sparas", async () => {
    await expect(
      saveBokforingSettingsFor(o.ownerV, settings({ plan: { ...DEFAULT_PLAN, vat_vmb: "26" } })),
    ).rejects.toThrow(/fyra siffror/);
    await expect(
      saveBokforingSettingsFor(o.ownerV, settings({ orgNumber: "123" })),
    ).rejects.toThrow(/Organisationsnummer/);
    await saveBokforingSettingsFor(
      o.ownerV,
      settings({
        plan: { ...DEFAULT_PLAN, sales_vmb: "3212" },
        orgNumber: "5590001234",
        series: "bl",
      }),
    );
    const view = await loadBokforingFor(o.ownerV, TODAY);
    expect(view.settings.plan.sales_vmb).toBe("3212");
    expect(view.settings.orgNumber).toBe("559000-1234");
    expect(view.settings.series).toBe("BL");
  });
});

describe("kvitton och månadspaketet", () => {
  let o: Org;
  beforeAll(async () => {
    o = await seedOrg();
    await addOrders(o, "2026-10", 3);
    await saveBokforingSettingsFor(o.ownerV, settings());
    await setBokforingVmbFor(o.ownerV, true);
  });

  it("laddar upp, känner igen dubbletter, nekar fel filtyp och tar bort", async () => {
    const a = await uploadReceiptFor(
      o.ownerV,
      "2026-10",
      { name: "Kvitto Åhléns.pdf", bytes: PDF },
      TODAY,
      files,
    );
    expect(a.duplicate).toBe(false);
    const again = await uploadReceiptFor(
      o.adminV,
      "2026-10",
      { name: "igen.pdf", bytes: PDF },
      TODAY,
      files,
    );
    expect(again).toEqual({ id: a.id, duplicate: true });
    await expect(
      uploadReceiptFor(
        o.ownerV,
        "2026-10",
        { name: "x.pdf", bytes: new TextEncoder().encode("<script>") },
        TODAY,
        files,
      ),
    ).rejects.toThrow(/PDF, JPG, PNG eller HEIC/);
    await expect(
      uploadReceiptFor(o.ownerV, "2026-12", { name: "x.pdf", bytes: PDF }, TODAY, files),
    ).rejects.toThrow(/inte börjat/);

    const file = await readReceiptFor(o.viewerV, a.id, files);
    expect(file).toMatchObject({ fileName: "Kvitto Åhléns.pdf", contentType: "application/pdf" });
    await expect(readReceiptFor(o.refillerV, a.id, files)).rejects.toBeInstanceOf(
      AuthorizationError,
    );

    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 9, 9]);
    const b = await uploadReceiptFor(
      o.ownerV,
      "2026-10",
      { name: "foto.png", bytes: png },
      TODAY,
      files,
    );
    await archiveReceiptFor(o.ownerV, b.id);
    await expect(archiveReceiptFor(o.ownerV, b.id)).rejects.toThrow(/finns inte/);
    const view = await loadBokforingFor(o.ownerV, TODAY);
    expect(view.months.find((m) => m.month === "2026-10")!.receipts.map((r) => r.fileName)).toEqual(
      ["Kvitto Åhléns.pdf"],
    );
  });

  it("paketet innehåller SIE, sammanfattning, Excel och månadens kvitton; läsaren kan ladda ned", async () => {
    const pkg = await monthPackageFor(o.viewerV, "2026-10", TODAY, {
      store: files,
      renderPdf: null,
    });
    expect(pkg.fileName).toBe("bokforing-2026-10.zip");
    const z = zipNames(pkg.bytes);
    expect([...z.keys()]).toEqual([
      "verifikation-2026-10.si",
      "sammanfattning-2026-10.html",
      "rader-2026-10.xlsx",
      "kvitton/001-Kvitto-Ahlens.pdf",
      "kvitton/index.csv",
      "LAS-MIG.txt",
    ]);
    expect(new Uint8Array(z.get("kvitton/001-Kvitto-Ahlens.pdf")!)).toEqual(PDF);
    const sie = decodeCp437(new Uint8Array(z.get("verifikation-2026-10.si")!));
    // Oktober är räkenskapsårets tionde månad; 3 × 100 kr, inköp 60 kr → moms 48 kr.
    expect(sie).toContain('#VER "A" "10" 20261031');
    expect(sie).toContain("#TRANS 1580 {} 300.00 20261031");
    expect(sie).toContain("#TRANS 2616 {} -48.00 20261031");
    await expect(monthPackageFor(o.ownerV, "2026-11", TODAY)).rejects.toThrow(/pågår/);
  });
});

describe("återbetalningar, mottagna inköp och ofärdig vinstdelning", () => {
  let o: Org;
  beforeAll(async () => {
    o = await seedOrg();
    // September: 10 × 100 kr, en återbetalning på 50 kr, en inköpsorder där 4 av 10 kom.
    await addOrders(o, "2026-09", 10);
    await asUser(o.owner, async (tx) => {
      const org = { organizationId: o.orgId };
      await tx.insert(s.incidents).values({
        ...org,
        machineId: o.ids.machineId,
        kind: "refund_request",
        startedAt: new Date("2026-09-15T10:00:00Z"),
        refundedOre: 5_000,
        refundedOn: "2026-09-15",
      });
      const [supplier] = await tx
        .insert(s.suppliers)
        .values({ ...org, name: "Grossist" })
        .returning();
      const [po] = await tx
        .insert(s.purchaseOrders)
        .values({
          ...org,
          supplierId: supplier!.id,
          status: "draft",
          orderedOn: "2026-09-01",
        })
        .returning();
      await tx.insert(s.purchaseOrderLines).values({
        ...org,
        purchaseOrderId: po!.id,
        titleId: o.ids.titleId,
        quantity: 10,
        unitCostOre: 1_000,
      });
      await tx.execute(
        sql`update public.purchase_order_lines set received_quantity = 4 where purchase_order_id = ${po!.id}`,
      );
      await tx.execute(
        sql`update public.purchase_orders set status = 'received', received_on = '2026-09-10' where id = ${po!.id}`,
      );
    });
    await saveBokforingSettingsFor(o.ownerV, settings({ purchaseBasis: "received_purchases" }));
    await setBokforingVmbFor(o.ownerV, true);
  });

  it("återbetalningen dras från försäljningen och bara mottaget antal räknas som inköp", async () => {
    const view = await loadBokforingFor(o.ownerV, TODAY);
    const sep = view.months.find((m) => m.month === "2026-09")!.book;
    expect(sep.salesInclVatOre).toBe(100_000);
    expect(sep.refundsOre).toBe(5_000);
    expect(sep.purchasesOre).toBe(4_000);
    // Marginal = 100 000 − 5 000 − 4 000 = 91 000 → moms 18 200.
    expect(sep.vmb).toMatchObject({ salesInclVatOre: 95_000, marginOre: 91_000, vatOre: 18_200 });
    const pkg = await monthPackageFor(o.ownerV, "2026-09", TODAY, { store: files });
    const by = (acc: string) =>
      pkg.verification.rows.filter((r) => r.account === acc).reduce((t, r) => t + r.amountOre, 0);
    expect(by("3211")).toBe(-(95_000 - 18_200));
  });

  it("en månad med ofärdig vinstdelning kan inte markeras som skickad", async () => {
    await asUser(o.owner, async (tx) => {
      const [store] = await rows<{ id: string }>(
        tx,
        sql`select id from public.stores where organization_id = ${o.orgId} limit 1`,
      );
      await tx.execute(
        sql`update public.store_agreements set valid_to = '2026-09-30' where store_id = ${store!.id}`,
      );
      await tx.execute(sql`insert into public.store_agreements
          (organization_id, store_id, valid_from, commission_base, commission_bp, loss_treatment)
        values (${o.orgId}, ${store!.id}, '2026-10-01', 'profit_after_costs', 5000, 'zero')`);
      const [title] = await tx
        .insert(s.titles)
        .values({ organizationId: o.orgId, name: `Utan pris ${uniqueSuffix()}` })
        .returning();
      await tx.insert(s.orders).values({
        organizationId: o.orgId,
        dataSourceId: o.ids.dataSourceId,
        externalId: `utan-pris-${uniqueSuffix()}`,
        rawTitle: "Utan pris",
        titleId: title!.id,
        orderedAt: new Date("2026-10-10T10:00:00Z"),
        amountOre: 10_000,
        sourceMachineId: o.ids.sourceMachineId,
        machineId: o.ids.machineId,
        importId: o.ids.importId,
        sourceHash: `h-${uniqueSuffix()}`,
      });
    });
    const view = await loadBokforingFor(o.ownerV, TODAY);
    const oct = view.months.find((m) => m.month === "2026-10")!.book;
    expect(oct.profitSplitUnpricedOrders).toBe(1);
    await expect(markMonthSentFor(o.ownerV, "2026-10", TODAY)).rejects.toThrow(
      /inte färdigräknad: 1 order saknar inköpspris/,
    );
  });
});
