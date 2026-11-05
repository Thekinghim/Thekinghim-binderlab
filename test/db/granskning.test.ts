/**
 * Granskning och oberoende (20261111020000/20261111020100):
 *
 *   - "Annan automat (CSV)": en datakälla manual_csv importerar försäljning genom samma
 *     pipeline som Awish (nya, dubbletter, okända automater, lager) och räknas som en
 *     uppladdad källa i täckningen (sales_data_until.manual).
 *   - "Exportera all data": bara ägaren får en ZIP; den innehåller organisationens egna
 *     rader och aldrig en annan organisations; högst 3 per timme (i databasen); loggen
 *     data_exports syns bara för ägaren och kan inte ändras.
 */

import { sql } from "drizzle-orm";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const req = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
}));

vi.mock("next/headers", async () => {
  const { createRequestMock } = await import("./redteam-fas7-harness");
  return createRequestMock(req).headers;
});
vi.mock("next/navigation", async () => {
  const { createRequestMock } = await import("./redteam-fas7-harness");
  return createRequestMock(req).navigation;
});
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
  refresh: vi.fn(),
  unstable_noStore: vi.fn(),
}));

import { MANUAL_CSV_TEMPLATE } from "../../src/import/adapters/manual-csv";
import { parseExportCsv, unzip } from "../../src/server/export/testing/unzip";
import { asUser, attempt, createMember, db, one, rows } from "./helpers";
import { mapMachine, ordersOf, setupImportOrg } from "./import-fixtures";
import { loginAs, NextSignal, seedCast, type Cast, type PersonaName } from "./redteam-fas7-harness";

// ---------------------------------------------------------------------------
// Annan automat (CSV)
// ---------------------------------------------------------------------------

describe("Annan automat (manual_csv)", () => {
  it("importerar mallen: nya order, samma fil igen blir dubbletter, automaten kopplas", async () => {
    const f = await setupImportOrg({ provider: "manual_csv", sourceTimezone: "Europe/Stockholm" });
    const machineId = await mapMachine(f, "Butik Centrum", "AN-1");

    const preview = await f.run(MANUAL_CSV_TEMPLATE, { dryRun: true });
    expect(preview.dataSource.provider).toBe("manual_csv");
    expect(preview.summary).toMatchObject({ total: 3, new: 3, error: 0 });

    const first = await f.run(MANUAL_CSV_TEMPLATE, { name: "forsaljning.csv" });
    expect(first.summary).toMatchObject({ new: 3, duplicate: 0, conflict: 0, error: 0 });
    expect(first.parserVersion).toMatch(/^manual_csv\//);

    const orders = await ordersOf(f.orgId);
    expect(orders).toHaveLength(3);
    expect(orders.every((o) => o.machine_id === machineId)).toBe(true);
    // 178 kr för två pack blir två order om 89 kr.
    expect(orders.map((o) => o.amount_ore).sort()).toEqual(["7900", "8900", "8900"]);
    expect(orders.find((o) => o.amount_ore === "7900")).toMatchObject({
      ordered_at: "2026-11-03T13:05:00Z",
      business_date: "2026-11-03",
    });

    const again = await f.run(MANUAL_CSV_TEMPLATE, { name: "forsaljning.csv" });
    expect(again.summary).toMatchObject({ new: 0, duplicate: 3, conflict: 0 });
    expect(again.warnings.map((w) => w.code)).toContain("duplicate_file");

    // Försäljningen blev lagerhändelser i automaten (samma pipeline som Awish).
    const sales = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.stock_events e
          join public.stock_locations l on l.organization_id = e.organization_id and l.id = e.location_id
          where e.organization_id = ${f.orgId} and e.kind = 'sale' and l.machine_id = ${machineId}`,
    );
    expect(sales.n).toBe(3);

    // Täckningen räknar källan som uppladdad: datat räcker till den senaste ordern.
    const coverage = await asUser(f.owner, (tx) =>
      one<{ manual: boolean; data_until: string }>(
        tx,
        sql`select manual, to_char(data_until at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"') as data_until
            from public.sales_data_until(${f.orgId}::uuid, '2026-11-04T00:00:00Z'::timestamptz)
            where machine_id = ${machineId}`,
      ),
    );
    expect(coverage).toEqual({ manual: true, data_until: "2026-11-03T15:40:00Z" });
  });

  it("filer med saknade kolumner nekas med ett svenskt fel; inget sparas", async () => {
    const f = await setupImportOrg({ provider: "manual_csv", sourceTimezone: "Europe/Stockholm" });
    await expect(f.run("Datum;Produkt\n2026-11-05;X\n")).rejects.toThrow(/saknar kolumner/);
    expect(await ordersOf(f.orgId)).toHaveLength(0);
  });

  it("läsaren kan inte importera till en manuell källa", async () => {
    const f = await setupImportOrg({ provider: "manual_csv", sourceTimezone: "Europe/Stockholm" });
    const viewer = await createMember(f.orgId, "viewer");
    await expect(f.run(MANUAL_CSV_TEMPLATE, { user: viewer })).rejects.toMatchObject({
      name: "ImportForbiddenError",
    });
  });
});

// ---------------------------------------------------------------------------
// Exportera all data
// ---------------------------------------------------------------------------

let cast: Cast;

beforeAll(async () => {
  cast = await seedCast();
}, 180_000);

afterEach(() => {
  req.cookies.clear();
  req.headers.clear();
});

const BASE = "http://localhost:3200";

// En Request i Node kan inte sätta Host; proxyn (Vercel) skickar x-forwarded-host.
const SAME = { origin: BASE, "x-forwarded-host": "localhost:3200" };

async function post(
  headers: Record<string, string> = SAME,
): Promise<{ status: number; bytes: Uint8Array; text: string; headers: Headers }> {
  const { POST } = await import("@/app/(app)/installningar/export/route");
  try {
    const res = await POST(
      new Request(`${BASE}/installningar/export`, { method: "POST", headers }),
    );
    const bytes = new Uint8Array(await res.arrayBuffer());
    return {
      status: res.status,
      bytes,
      text: new TextDecoder().decode(bytes),
      headers: res.headers,
    };
  } catch (error) {
    if (error instanceof NextSignal) {
      return { status: 307, bytes: new Uint8Array(), text: "", headers: new Headers() };
    }
    throw error;
  }
}

async function clearExports(orgId: string): Promise<void> {
  // Testerna börjar om räkningen; loggen är append-only, så triggern slås av för städningen.
  await db().execute(sql`alter table public.data_exports disable trigger t01_append_only`);
  try {
    await db().execute(sql`delete from public.data_exports where organization_id = ${orgId}`);
  } finally {
    await db().execute(sql`alter table public.data_exports enable trigger t01_append_only`);
  }
}

const NOT_OWNER: PersonaName[] = ["admin", "viewer", "refiller", "store", "stranger", "anon"];

describe("Exportera all data", () => {
  it("ägaren får en ZIP med organisationens egna data och aldrig B:s", async () => {
    await clearExports(cast.A.orgId);
    await loginAs(req, cast.personas.owner);
    const r = await post();
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/zip");
    expect(r.headers.get("content-disposition")).toMatch(
      /^attachment; filename="binderlab-export-[a-z0-9-]+-\d{4}-\d{2}-\d{2}\.zip"$/,
    );
    expect(Number(r.headers.get("content-length"))).toBe(r.bytes.length);

    const files = unzip(r.bytes);
    const names = files.map((f) => f.name);
    expect(names[0]).toBe("LASMIG.txt");
    for (const n of [
      "automater.csv",
      "butiker.csv",
      "titlar.csv",
      "inkopspriser.csv",
      "order.csv",
      "lagerhandelser.csv",
      "avrakningar.csv",
    ]) {
      expect(names).toContain(n);
    }

    const all = files.map((f) => f.text).join("\n");
    // A:s egna rader finns med.
    for (const id of [
      cast.A.machineId,
      cast.A.storeId,
      cast.A.titleId,
      cast.A.priceId,
      ...cast.A.orderIds,
    ]) {
      expect(all).toContain(id);
    }
    // B:s rader finns aldrig med.
    for (const id of [
      cast.B.orgId,
      cast.B.machineId,
      cast.B.storeId,
      cast.B.titleId,
      ...cast.B.orderIds,
    ]) {
      expect(all).not.toContain(id);
    }

    const order = parseExportCsv(files.find((f) => f.name === "order.csv")!.text);
    const header = order[0]!;
    expect(header).toEqual(
      expect.arrayContaining(["id", "amount_ore", "ordered_at", "machine_id"]),
    );
    expect(order.length - 1).toBe(cast.A.orderIds.length);
    const orgCol = header.indexOf("organization_id");
    expect(order.slice(1).every((row) => row[orgCol] === cast.A.orgId)).toBe(true);
    const at = order[1]![header.indexOf("ordered_at")]!;
    expect(at).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    // Inga hänvisningar till hemligheter eller interna inställningar.
    const ds = parseExportCsv(files.find((f) => f.name === "datakallor.csv")!.text)[0]!;
    expect(ds).not.toContain("secret_ref");
    expect(ds).not.toContain("config");
    expect(ds).not.toContain("cursor");

    const readme = files[0]!.text;
    expect(readme).toMatch(/Belopp i öre/);
    expect(readme).toMatch(new RegExp(`order\\.csv \\(${cast.A.orderIds.length} rader\\)`));
  });

  it("B:s ägare får bara B:s data", async () => {
    await clearExports(cast.B.orgId);
    await loginAs(req, cast.personas.outsider);
    const r = await post();
    expect(r.status).toBe(200);
    const all = unzip(r.bytes)
      .map((f) => f.text)
      .join("\n");
    expect(all).toContain(cast.B.machineId);
    for (const id of [cast.A.orgId, cast.A.machineId, cast.A.storeId, ...cast.A.orderIds]) {
      expect(all).not.toContain(id);
    }
  });

  it("alla andra nekas: admin, läsare, påfyllare, butiken, en icke-medlem och en utloggad", async () => {
    for (const p of NOT_OWNER) {
      await loginAs(req, cast.personas[p]);
      const r = await post();
      expect([401, 403, 307], p).toContain(r.status);
      expect(r.text, p).not.toContain(cast.A.machineId);
      expect(r.bytes.slice(0, 2), p).not.toEqual(new Uint8Array([0x50, 0x4b]));
    }
  });

  it("fel ursprung nekas innan något händer", async () => {
    await loginAs(req, cast.personas.owner);
    const before = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.data_exports where organization_id = ${cast.A.orgId}`,
    );
    const r = await post({ ...SAME, origin: "https://evil.example" });
    expect(r.status).toBe(403);
    const after = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.data_exports where organization_id = ${cast.A.orgId}`,
    );
    expect(after.n).toBe(before.n);
  });

  it("högst 3 exporter per timme och organisation (429), räknat i databasen", async () => {
    await clearExports(cast.A.orgId);
    await loginAs(req, cast.personas.owner);
    for (let i = 0; i < 3; i += 1) expect((await post()).status).toBe(200);
    const blocked = await post();
    expect(blocked.status).toBe(429);
    expect(blocked.headers.get("retry-after")).toBe("3600");
    expect(blocked.text).toMatch(/Högst 3 exporter per timme/);
    // Egen felkod (BL094): BL090 är demons "inga inbjudningar", koderna får inte blandas ihop.
    const direct = await asUser(cast.personas.owner.user!, (tx) =>
      attempt(tx, (sp) => sp.execute(sql`select public.start_data_export(${cast.A.orgId}::uuid)`)),
    );
    expect(direct.code).toBe("BL094");
    // B påverkas inte av A:s gräns.
    await clearExports(cast.B.orgId);
    await loginAs(req, cast.personas.outsider);
    expect((await post()).status).toBe(200);
    await clearExports(cast.A.orgId);
  });

  it("loggen: ägaren ser sina exporter, läsaren och admin ser inget, ingen kan ändra", async () => {
    await clearExports(cast.A.orgId);
    await loginAs(req, cast.personas.owner);
    expect((await post()).status).toBe(200);

    const owner = cast.personas.owner.user!;
    const seen = await asUser(owner, (tx) =>
      rows<{ created_by: string }>(
        tx,
        sql`select created_by from public.data_exports where organization_id = ${cast.A.orgId}`,
      ),
    );
    expect(seen).toEqual([{ created_by: owner.id }]);

    for (const p of ["admin", "viewer", "refiller"] as const) {
      const user = cast.personas[p].user!;
      const n = await asUser(user, (tx) =>
        one<{ n: number }>(tx, sql`select count(*)::int as n from public.data_exports`),
      );
      expect(n.n, p).toBe(0);
    }

    for (const stmt of [
      sql`insert into public.data_exports (organization_id) values (${cast.A.orgId})`,
      sql`update public.data_exports set format = 'zip-csv' where organization_id = ${cast.A.orgId}`,
      sql`delete from public.data_exports where organization_id = ${cast.A.orgId}`,
    ]) {
      const outcome = await asUser(owner, (tx) => attempt(tx, (sp) => sp.execute(stmt)));
      expect(outcome.code).toBe("42501");
    }
    // Inte ens databasägaren kan ändra en rad (append-only-triggern).
    const owned = await db().transaction((tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`delete from public.data_exports where organization_id = ${cast.A.orgId}`),
      ),
    );
    expect(owned.ok).toBe(false);
  });

  it("start_data_export direkt: admin nekas (42501), B:s ägare kan inte starta för A", async () => {
    const admin = cast.personas.admin.user!;
    const a = await asUser(admin, (tx) =>
      attempt(tx, (sp) => sp.execute(sql`select public.start_data_export(${cast.A.orgId}::uuid)`)),
    );
    expect(a.code).toBe("42501");
    const b = await asUser(cast.B.owner, (tx) =>
      attempt(tx, (sp) => sp.execute(sql`select public.start_data_export(${cast.A.orgId}::uuid)`)),
    );
    expect(b.code).toBe("42501");
  });
});
