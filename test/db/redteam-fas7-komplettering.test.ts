/**
 * Röd granskning fas 7, komplettering (oberoende granskare).
 *
 * redteam-fas7-actions/-routes/-db täcker varje server action mot en person i taget
 * med EN roll (fel roll, fel organisation, utan medlemskap, utloggad). Det som saknades
 * och prövas här, med samma riktiga stack (dev-sessionscookie → session.ts →
 * requireRole → RLS; bara Nexts förfrågan är fejkad):
 *
 *  1. Personer med medlemskap i FLERA organisationer (läsare/påfyllare/butik i A och
 *     ägare i B). Rollen ska gälla den aktiva organisationen, inte den högsta rollen,
 *     och med B aktiv får A:s id:n aldrig ändra något i A.
 *  2. Indrag av behörighet slår igenom direkt för en redan utfärdad session: nedgraderad
 *     admin, borttagen påfyllare, borttagen butiksanvändare och raderat konto.
 *  3. Sidokanaler utanför A:s tabeller: mejl (rapportutskick och inbjudningar). Matrisen
 *     tittar bara på A:s tabeller, inte på vad som skickas ut.
 *  4. Sidor med id i adressen (/automater/[automat], /butiker/[butik], /drift/automat/[id],
 *     /inkorg/[id], /datakallor/importer/[id], /rapport/[id], /rapport/[id]/epost,
 *     /portal/rapporter/[id]) och sidans metadata, med en annan organisations id.
 *  5. RPC:er (security definer) som bara fanns i katalogtestet: attach_contract_file,
 *     list_members, lager_performers och register_refill, anropade direkt som
 *     PostgREST gör (authenticated med JWT-claims).
 *  6. Överpostning: en tillåten ägare i A skickar organizationId/organization_id för B
 *     i varje action tillsammans med B:s id:n. B får aldrig ändras.
 *
 * Konvention som i redteam-fas7-*.test.ts: ett känt hål skrivs som `it.fails("HÅL …")`.
 */

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

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

import {
  addMember,
  asAnon,
  asPostgres,
  asUser,
  createMember,
  createUser,
  db,
  one,
  orgScopedTables,
  pgError,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";
import { ACTIONS, sink, type ActionSpec } from "./redteam-fas7-catalog";
import {
  call,
  changedTables,
  fingerprint,
  isAuthDenial,
  isDenied,
  keysDeep,
  loginAs,
  MONEY_KEY,
  seedCast,
  type CallOutcome,
  type Cast,
  type Persona,
  type PersonaName,
} from "./redteam-fas7-harness";

// Filer (avtal, import, rapporter, utskick) i en egen katalog, inte i projektets .data.
const FILE_DIR = mkdtempSync(path.join(tmpdir(), "rt7k-files-"));
process.env.CONTRACT_FILE_DIR = path.join(FILE_DIR, "contracts");
process.env.CONTRACT_FILE_STORE = "local";
process.env.IMPORT_FILE_STORE = "local";
process.env.IMPORT_FILE_DIR = path.join(FILE_DIR, "imports");
process.env.REPORT_STORAGE = "local";
process.env.REPORT_STORAGE_DIR = path.join(FILE_DIR, "reports");
process.env.MAIL_PROVIDER = "outbox";
process.env.MAIL_OUTBOX_DIR = path.join(FILE_DIR, "outbox");
/** Dev-inloggningens inbjudningsmejl (src/server/mail/dev-mailbox.ts, går inte att flytta). */
const DEV_MAIL_DIR = path.resolve(process.cwd(), ".data", "mail");

/** Unika namn i A, så att ett läckt namn går att känna igen (fixturerna är annars lika). */
const SECRET_STORE = `RT7K-hemlig-butik-${uniqueSuffix()}`;
const SECRET_MACHINE = `RT7K-hemlig-automat-${uniqueSuffix()}`;

let cast: Cast;
/** Alla id:n i A och i B (alla organisationsbundna tabeller). */
let allIdsA: Set<string>;
let allIdsB: Set<string>;

/** Läsare, påfyllare respektive butik i A som också är ägare i B. */
interface Dual {
  label: string;
  roleInA: "viewer" | "refiller" | "store";
  user: TestUser;
}
let duals: Dual[];

async function idsOf(orgId: string): Promise<Set<string>> {
  const out = new Set([orgId]);
  for (const table of await orgScopedTables()) {
    const has = await rows(
      db(),
      sql`select 1 from information_schema.columns
          where table_schema = 'public' and table_name = ${table} and column_name = 'id'`,
    );
    if (has.length === 0) continue;
    for (const r of await rows<{ id: string }>(
      db(),
      sql`select id::text as id from ${sql.identifier("public")}.${sql.identifier(table)}
          where organization_id = ${orgId}`,
    )) {
      out.add(r.id);
    }
  }
  return out;
}

async function addStoreMember(orgId: string, storeId: string, user: TestUser): Promise<void> {
  await asPostgres((tx) =>
    tx.execute(
      sql`insert into public.memberships (organization_id, user_id, role, store_id)
          values (${orgId}::uuid, ${user.id}::uuid, 'store', ${storeId}::uuid)`,
    ),
  );
}

beforeAll(async () => {
  cast = await seedCast();
  await asPostgres(async (tx) => {
    await tx.execute(
      sql`update public.stores set name = ${SECRET_STORE}
          where organization_id = ${cast.A.orgId} and id = ${cast.A.storeId}`,
    );
    await tx.execute(
      sql`update public.machines set name = ${SECRET_MACHINE}
          where organization_id = ${cast.A.orgId} and id = ${cast.A.machineId}`,
    );
  });
  allIdsA = await idsOf(cast.A.orgId);
  allIdsB = await idsOf(cast.B.orgId);

  const make = async (roleInA: Dual["roleInA"]): Promise<Dual> => {
    const user = await createUser(`dual-${roleInA}-${uniqueSuffix()}@test.binderlab.se`);
    if (roleInA === "store") await addStoreMember(cast.A.orgId, cast.A.storeId, user);
    else await addMember(cast.A.orgId, user, roleInA);
    await addMember(cast.B.orgId, user, "owner");
    return { label: `${roleInA} i A + ägare i B`, roleInA, user };
  };
  duals = [await make("viewer"), await make("refiller"), await make("store")];

  // Rapportens PDF finns i lagringen, så att ett utskick faktiskt kan gå iväg
  // (positiv kontroll nedan); annars bevisar ett nekat utskick ingenting.
  const files = await rows<{ storage_path: string }>(
    db(),
    sql`select storage_path from public.report_files where organization_id = ${cast.A.orgId}`,
  );
  for (const f of files) {
    const full = path.join(process.env.REPORT_STORAGE_DIR!, f.storage_path);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, "%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");
  }
}, 240_000);

async function load(spec: { module: string; name: string }) {
  const mod = (await import(/* @vite-ignore */ spec.module)) as Record<string, unknown>;
  const fn = mod[spec.name];
  if (typeof fn !== "function") throw new Error(`${spec.module} saknar ${spec.name}`);
  return fn as (...args: unknown[]) => Promise<unknown>;
}

function label(spec: ActionSpec): string {
  return `${spec.module.replace("@/app/(app)/", "").replace("@/", "")}#${spec.name}`;
}

/** Alla strängar i ett värde (React-träd, svar). Tål cykler. */
function stringsDeep(value: unknown, out: string[] = [], seen = new WeakSet<object>()): string[] {
  if (typeof value === "string") {
    out.push(value);
    return out;
  }
  if (!value || typeof value !== "object" || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const v of value) stringsDeep(v, out, seen);
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    if (k === "_owner" || k === "_store" || k === "_debugInfo" || k === "_debugStack") continue;
    stringsDeep(v, out, seen);
  }
  return out;
}

/** Id:n ur `ids` (och de hemliga namnen) i utfallet som inte fanns i anropet. */
function leaked(ids: Set<string>, sent: unknown, outcome: unknown): string[] {
  const sentText = JSON.stringify(sent) ?? "";
  const text = stringsDeep(outcome).join("\n");
  const uuids = text.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
  const out = [...new Set(uuids)].filter((u) => ids.has(u) && !sentText.includes(u));
  if (ids === allIdsA) {
    for (const secret of [SECRET_STORE, SECRET_MACHINE]) {
      if (text.includes(secret)) out.push(secret);
    }
  }
  return out;
}

/** En Cast där B spelar A:s roll (för anrop med B:s id:n). */
function swapped(c: Cast): Cast {
  return { ...c, A: c.B, B: c.A, idsA: c.idsB, idsB: c.idsA };
}

function persona(user: TestUser | null, orgId: string | null): Persona {
  return { name: "owner" as PersonaName, user, orgId };
}

// ---------------------------------------------------------------------------
// 1. Medlemskap i flera organisationer
// ---------------------------------------------------------------------------

describe("medlem i flera organisationer: rollen gäller den aktiva organisationen", () => {
  it.each(ACTIONS.map((spec) => [label(spec), spec] as const))(
    "%s",
    async (_label, spec) => {
      const fn = await load(spec);
      const problems: string[] = [];
      for (const dual of duals) {
        for (const active of [cast.A.orgId, cast.B.orgId]) {
          const activeLabel = active === cast.A.orgId ? "A aktiv" : "B aktiv";
          // Med A aktiv får den tillåtna rollen i A göra ändringen; det prövas inte här.
          if (active === cast.A.orgId && spec.allowed.includes(dual.roleInA as PersonaName)) {
            continue;
          }
          const args = spec.args(cast);
          const before = await fingerprint(cast.A.orgId);
          await loginAs(req, persona(dual.user, active));
          const outcome = await call(() => fn(...args));
          const changed = changedTables(before, await fingerprint(cast.A.orgId));
          if (changed.length > 0) {
            problems.push(`${dual.label}, ${activeLabel}: ändrade ${changed.join(", ")} i A`);
          }
          // Läsaren och påfyllaren med A aktiv: ägarrollen i B får inte smitta av sig.
          if (active === cast.A.orgId && dual.roleInA !== "store") {
            if (!isDenied(outcome)) {
              problems.push(`${dual.label}, ${activeLabel}: lyckades`);
            } else if (!isAuthDenial(outcome)) {
              problems.push(
                `${dual.label}, ${activeLabel}: inte ett behörighetsnej (${JSON.stringify(outcome).slice(0, 140)})`,
              );
            }
          }
          // Butiksanvändaren har ingen approll i A: svaret får aldrig bära A:s data.
          if (dual.roleInA === "store") {
            const l = leaked(allIdsA, args, outcome);
            if (l.length > 0) problems.push(`${dual.label}, ${activeLabel}: svaret visar ${l[0]}`);
          }
          // Påfyllaren i A får aldrig belopp ur A, inte heller med B aktiv.
          if (dual.roleInA === "refiller" && leaked(allIdsA, args, outcome).length > 0) {
            const money = [...keysDeep(outcome)].filter((k) => MONEY_KEY.test(k));
            if (money.length > 0) {
              problems.push(`${dual.label}, ${activeLabel}: A-data med beloppsnycklar ${money[0]}`);
            }
          }
        }
      }
      expect(problems).toEqual([]);
    },
    180_000,
  );

  it("butiksanvändaren i A som är ägare i B: cookien bl_org=A ger aldrig en approll i A", async () => {
    const { getActiveOrganization } = await import("@/server/session");
    const dual = duals.find((d) => d.roleInA === "store")!;
    await loginAs(req, persona(dual.user, cast.A.orgId));
    const active = await getActiveOrganization();
    expect(active?.id).toBe(cast.B.orgId);
  });
});

// ---------------------------------------------------------------------------
// 2. Indragen behörighet slår igenom direkt för en befintlig session
// ---------------------------------------------------------------------------

describe("indragen behörighet gäller direkt (sessionen är redan utfärdad)", () => {
  const createStore = { module: "@/app/(app)/butiker/actions", name: "createStore" };
  const inviteMember = {
    module: "@/app/(app)/installningar/anvandare/actions",
    name: "inviteMember",
  };

  it("admin som nedgraderas till läsare nekas i nästa anrop med samma cookie", async () => {
    const admin = await createMember(cast.A.orgId, "admin");
    await loginAs(req, persona(admin, cast.A.orgId));
    const session = new Map(req.cookies);
    // Positiv kontroll: som admin går det.
    const ok = await call(async () =>
      (await load(createStore))(
        sink(cast, { code: `RT7K-${uniqueSuffix()}`, name: `RT7K ${uniqueSuffix()}` }),
      ),
    );
    expect(ok.kind, JSON.stringify(ok).slice(0, 200)).toBe("ok");

    await asPostgres((tx) =>
      tx.execute(
        sql`update public.memberships set role = 'viewer'
            where organization_id = ${cast.A.orgId} and user_id = ${admin.id}`,
      ),
    );
    const before = await fingerprint(cast.A.orgId);
    for (const spec of [createStore, inviteMember]) {
      req.cookies.clear();
      for (const [k, v] of session) req.cookies.set(k, v);
      const outcome = await call(async () =>
        (await load(spec))(
          spec === inviteMember
            ? { email: `rt7k-${uniqueSuffix()}@example.se`, role: "admin" }
            : sink(cast, { code: `RT7K-${uniqueSuffix()}` }),
        ),
      );
      expect(isAuthDenial(outcome), `${spec.name}: ${JSON.stringify(outcome).slice(0, 200)}`).toBe(
        true,
      );
    }
    expect(changedTables(before, await fingerprint(cast.A.orgId))).toEqual([]);
  });

  it("borttagen påfyllare kan inte registrera påfyllning, inventering eller offline-synk", async () => {
    const refiller = await createMember(cast.A.orgId, "refiller");
    await loginAs(req, persona(refiller, cast.A.orgId));
    const session = new Map(req.cookies);
    await asPostgres((tx) =>
      tx.execute(
        sql`delete from public.memberships
            where organization_id = ${cast.A.orgId} and user_id = ${refiller.id}`,
      ),
    );
    const before = await fingerprint(cast.A.orgId);
    const attempts: Array<[{ module: string; name: string }, unknown[]]> = [
      [{ module: "@/app/(app)/lager/actions", name: "registerRefill" }, [sink(cast)]],
      [
        { module: "@/app/(app)/lager/actions", name: "registerCount" },
        [sink(cast, { counted: 1, locationId: cast.A.machineLocationId })],
      ],
      [{ module: "@/app/(app)/att-gora/actions", name: "registerRefill" }, [sink(cast)]],
      [
        { module: "@/app/(app)/drift/actions", name: "syncRefills" },
        [
          [
            {
              clientId: crypto.randomUUID(),
              machineId: cast.A.machineId,
              titleId: cast.A.titleId,
              quantity: 1,
              fromWarehouse: false,
              occurredAt: new Date().toISOString(),
            },
          ],
        ],
      ],
    ];
    const problems: string[] = [];
    for (const [spec, args] of attempts) {
      req.cookies.clear();
      for (const [k, v] of session) req.cookies.set(k, v);
      const outcome = await call(async () => (await load(spec))(...args));
      if (!isDenied(outcome)) problems.push(`${spec.module}#${spec.name}: lyckades`);
    }
    expect(problems).toEqual([]);
    expect(changedTables(before, await fingerprint(cast.A.orgId))).toEqual([]);
  });

  it("borttagen butiksanvändare kan inte felanmäla eller hämta butiksrapporten", async () => {
    const user = await createUser(`store-rt7k-${uniqueSuffix()}@test.binderlab.se`);
    await addStoreMember(cast.A.orgId, cast.A.storeId, user);
    await loginAs(req, persona(user, cast.A.orgId));
    const session = new Map(req.cookies);
    await asPostgres((tx) =>
      tx.execute(
        sql`delete from public.memberships
            where organization_id = ${cast.A.orgId} and user_id = ${user.id}`,
      ),
    );
    const before = await fingerprint(cast.A.orgId);
    const fault = await load({ module: "@/server/portal/actions", name: "reportFault" });
    const outcome = await call(() =>
      fault({
        storeId: cast.A.storeId,
        machineId: cast.A.machineId,
        kind: "store_other",
        description: "rt7k",
      }),
    );
    expect(isDenied(outcome), JSON.stringify(outcome).slice(0, 200)).toBe(true);

    req.cookies.clear();
    for (const [k, v] of session) req.cookies.set(k, v);
    const { GET } = (await import("@/app/portal/rapporter/[id]/pdf/route")) as {
      GET: (r: Request, ctx: { params: Promise<{ id: string }> }) => Promise<Response>;
    };
    const res = await call(() =>
      GET(new Request(`http://localhost:3200/portal/rapporter/${cast.idsA.reports}/pdf`), {
        params: Promise.resolve({ id: cast.idsA.reports! }),
      }),
    );
    if (res.kind === "ok") {
      expect((res.value as Response).status).not.toBe(200);
    }
    expect(changedTables(before, await fingerprint(cast.A.orgId))).toEqual([]);
  });

  it("raderat konto: den signerade cookien gäller inte längre", async () => {
    const owner = await createMember(cast.A.orgId, "admin");
    await loginAs(req, persona(owner, cast.A.orgId));
    await asPostgres((tx) => tx.execute(sql`delete from auth.users where id = ${owner.id}`));
    const before = await fingerprint(cast.A.orgId);
    const outcome = await call(async () =>
      (await load(createStore))(sink(cast, { code: `RT7K-${uniqueSuffix()}` })),
    );
    expect(isAuthDenial(outcome), JSON.stringify(outcome).slice(0, 200)).toBe(true);
    expect(changedTables(before, await fingerprint(cast.A.orgId))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Mejl: inget skickas ut åt den som inte får
// ---------------------------------------------------------------------------

/** Utskickade rapportmejl (outbox) efter `since`, med mottagare. */
async function outboxSince(since: number): Promise<string[]> {
  const dir = process.env.MAIL_OUTBOX_DIR!;
  const out: string[] = [];
  for (const entry of await readdir(dir).catch(() => [] as string[])) {
    const meta = path.join(dir, entry, "meta.json");
    const s = await stat(meta).catch(() => null);
    if (!s || s.mtimeMs < since) continue;
    const parsed = JSON.parse(await readFile(meta, "utf8")) as { to: string };
    out.push(parsed.to);
  }
  return out;
}

/** Dev-inloggningens inbjudningsmejl efter `since` till någon av adresserna. */
async function devMailsTo(since: number, emails: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(DEV_MAIL_DIR).catch(() => [] as string[])) {
    const file = path.join(DEV_MAIL_DIR, entry);
    const s = await stat(file).catch(() => null);
    if (!s || s.mtimeMs < since - 1000) continue;
    const text = await readFile(file, "utf8");
    for (const email of emails) {
      if (text.toLowerCase().includes(`to: ${email.toLowerCase()}`)) out.push(email);
    }
  }
  return out;
}

describe("mejl som sidokanal", () => {
  const sendReport = { module: "@/app/(app)/rapporter/actions", name: "sendReport" };
  /** En riktig, godkänd butiksrapport i A med sparad PDF (fixturens rapport har ett äldre underlag). */
  let reportId: string;

  beforeAll(async () => {
    const { listOrganizationsFor } = await import("@/server/access");
    const { LocalFileStore } = await import("@/import/file-store");
    const { approveReportFor, createReportFor, ensurePdfFor } =
      await import("@/server/reports/service");
    const user = { userId: cast.A.owner.id, email: cast.A.owner.email };
    const organization = (await listOrganizationsFor(user)).find((o) => o.id === cast.A.orgId)!;
    const viewer = { user, organization };
    reportId = await createReportFor(viewer, {
      type: "butik",
      month: "2025-03",
      storeId: cast.A.storeId,
    });
    await ensurePdfFor(viewer, reportId, {
      store: new LocalFileStore(process.env.REPORT_STORAGE_DIR!),
      render: async () => new TextEncoder().encode("%PDF-1.4 rt7k"),
    });
    await approveReportFor(viewer, reportId);
  }, 60_000);

  it("utomstående skickar A:s rapport till sin egen mottagare: 'finns inte', inget mejl, inget ändras", async () => {
    const since = Date.now();
    const beforeA = await fingerprint(cast.A.orgId);
    const beforeB = await fingerprint(cast.B.orgId);
    await loginAs(req, cast.personas.outsider);
    const outcome = await call(async () =>
      (await load(sendReport))({
        reportId,
        recipientIds: [cast.idsB.report_recipients],
        resend: true,
      }),
    );
    // Nejet ska komma från uppslaget i den aktiva organisationen, inte från ett senare steg.
    expect(outcome.kind).toBe("refused");
    expect((outcome as { error: string }).error).toBe("Rapporten finns inte.");
    expect(await outboxSince(since)).toEqual([]);
    expect(changedTables(beforeA, await fingerprint(cast.A.orgId))).toEqual([]);
    expect(changedTables(beforeB, await fingerprint(cast.B.orgId))).toEqual([]);
  });

  it("ägaren i A skickar A:s rapport till B:s mottagare: mottagaren avvisas före rendering och utskick", async () => {
    const secretEmail = `rt7k-b-${uniqueSuffix()}@example.se`;
    const original = await one<{ email: string }>(
      db(),
      sql`select email::text as email from public.report_recipients
          where organization_id = ${cast.B.orgId} and id = ${cast.idsB.report_recipients}`,
    );
    await asPostgres((tx) =>
      tx.execute(
        sql`update public.report_recipients set email = ${secretEmail}
            where organization_id = ${cast.B.orgId} and id = ${cast.idsB.report_recipients}`,
      ),
    );
    try {
      const since = Date.now();
      const beforeB = await fingerprint(cast.B.orgId);
      await loginAs(req, cast.personas.owner);
      const outcome = await call(async () =>
        (await load(sendReport))({
          reportId,
          recipientIds: [cast.idsB.report_recipients],
          resend: true,
        }),
      );
      expect(outcome.kind).toBe("refused");
      expect((outcome as { error: string }).error).toBe(
        "En vald mottagare kan inte få den här rapporten.",
      );
      expect(await outboxSince(since)).toEqual([]);
      expect(JSON.stringify(outcome)).not.toContain(secretEmail);
      expect(changedTables(beforeB, await fingerprint(cast.B.orgId))).toEqual([]);
    } finally {
      await asPostgres((tx) =>
        tx.execute(
          sql`update public.report_recipients set email = ${original.email}
              where organization_id = ${cast.B.orgId} and id = ${cast.idsB.report_recipients}`,
        ),
      );
    }
  });

  it("rapportutskick: läsare, påfyllare, butik, icke-medlem och utloggad nekas av rollkontrollen och inget skickas", async () => {
    const problems: string[] = [];
    for (const p of ["viewer", "refiller", "store", "stranger", "anon"] as PersonaName[]) {
      const since = Date.now();
      const before = await fingerprint(cast.A.orgId);
      await loginAs(req, cast.personas[p]);
      const outcome = await call(async () =>
        (await load(sendReport))({
          reportId,
          recipientIds: [cast.idsA.report_recipients],
          resend: true,
        }),
      );
      if (!isAuthDenial(outcome)) {
        problems.push(`${p}: inte ett behörighetsnej (${JSON.stringify(outcome).slice(0, 140)})`);
      }
      const sent = await outboxSince(since);
      if (sent.length > 0) problems.push(`${p}: mejl till ${sent.join(", ")}`);
      const changed = changedTables(before, await fingerprint(cast.A.orgId));
      if (changed.length > 0) problems.push(`${p}: ändrade ${changed.join(", ")}`);
    }
    expect(problems).toEqual([]);
  });

  it("inbjudningar: ingen utom ägare/admin i A får en länk skickad till A:s inbjudna eller ny adress", async () => {
    const invitation = await one<{ email: string }>(
      db(),
      sql`select email::text as email from public.invitations
          where organization_id = ${cast.A.orgId} and id = ${cast.idsA.invitations}`,
    );
    const fresh = `rt7k-inv-${uniqueSuffix()}@example.se`;
    const attempts: Array<[string, { module: string; name: string }, unknown]> = [
      [
        "resendInvitation",
        { module: "@/app/(app)/installningar/anvandare/actions", name: "resendInvitation" },
        { invitationId: cast.idsA.invitations },
      ],
      [
        "inviteMember",
        { module: "@/app/(app)/installningar/anvandare/actions", name: "inviteMember" },
        { email: fresh, role: "admin" },
      ],
      [
        "inviteStoreUser",
        { module: "@/server/portal/actions", name: "inviteStoreUser" },
        { storeId: cast.A.storeId, email: fresh },
      ],
    ];
    const problems: string[] = [];
    for (const p of [
      "viewer",
      "refiller",
      "store",
      "outsider",
      "stranger",
      "anon",
    ] as PersonaName[]) {
      for (const [name, spec, input] of attempts) {
        // B:s ägare får bjuda in till B (inviteMember med B aktiv); det är inte en läcka
        // så länge A inte nämns. Hon får aldrig skicka om A:s inbjudan eller bjuda in
        // till A:s butik.
        if (p === "outsider" && name === "inviteMember") continue;
        const since = Date.now();
        await loginAs(req, cast.personas[p]);
        const outcome = await call(async () => (await load(spec))(input));
        if (!isDenied(outcome)) problems.push(`${p} ${name}: lyckades`);
        const mails = await devMailsTo(since, [invitation.email, fresh]);
        if (mails.length > 0) problems.push(`${p} ${name}: mejl till ${mails.join(", ")}`);
      }
    }
    expect(problems).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 4. Sidor med id i adressen
// ---------------------------------------------------------------------------

interface DynamicPage {
  path: string;
  module: string;
  params: (c: Cast) => Record<string, string>;
}

const DYNAMIC_PAGES: DynamicPage[] = [
  {
    path: "/automater/[automat]",
    module: "@/app/(app)/automater/[automat]/page",
    params: (c) => ({ automat: c.A.machineId }),
  },
  {
    path: "/butiker/[butik]",
    module: "@/app/(app)/butiker/[butik]/page",
    params: (c) => ({ butik: c.A.storeId }),
  },
  {
    path: "/drift/automat/[id]",
    module: "@/app/(app)/drift/automat/[id]/page",
    params: (c) => ({ id: c.A.machineId }),
  },
  {
    path: "/inkorg/[id]",
    module: "@/app/(app)/inkorg/[id]/page",
    params: (c) => ({ id: c.idsA.incidents! }),
  },
  {
    path: "/datakallor/importer/[id]",
    module: "@/app/(app)/datakallor/importer/[id]/page",
    params: (c) => ({ id: c.A.importId }),
  },
  {
    path: "/rapport/[id]",
    module: "@/app/rapport/[id]/page",
    params: (c) => ({ id: c.idsA.reports! }),
  },
  {
    path: "/rapport/[id]/epost",
    module: "@/app/rapport/[id]/epost/page",
    params: (c) => ({ id: c.idsA.reports! }),
  },
  {
    path: "/portal/rapporter/[id]",
    module: "@/app/portal/rapporter/[id]/page",
    params: (c) => ({ id: c.idsA.reports! }),
  },
];

async function renderDynamic(page: DynamicPage, params: Record<string, string>) {
  const mod = (await import(/* @vite-ignore */ page.module)) as {
    default: (props: unknown) => Promise<unknown>;
  };
  return call(() =>
    mod.default({ params: Promise.resolve(params), searchParams: Promise.resolve({}) }),
  );
}

/** Nekad eller tom: notFound, omdirigering (utan A-data i adressen) eller ett svar utan A-data. */
function pageProblem(outcome: CallOutcome, params: Record<string, string>): string | null {
  if (outcome.kind === "notFound") return null;
  if (outcome.kind === "redirect") {
    const l = leaked(allIdsA, params, outcome.to);
    return l.length > 0 ? `omdirigering bär ${l[0]}` : null;
  }
  // Ett undantag får bara vara rollkontrollens; annat kan dölja att sidan aldrig prövades.
  if (outcome.kind === "threw") {
    return outcome.name === "AuthorizationError"
      ? null
      : `kastade ${outcome.name}: ${outcome.message}`;
  }
  const l = leaked(allIdsA, params, outcome);
  return l.length > 0 ? `sidan visar ${l[0]}` : `sidan renderades (${outcome.kind})`;
}

describe("sidor med en annan organisations id i adressen", () => {
  it.each(DYNAMIC_PAGES.map((p) => [p.path, p] as const))(
    "%s: utomstående, butik i B, icke-medlem och utloggad får inget ur A",
    async (_path, page) => {
      const storeB = await one<{ id: string; email: string }>(
        db(),
        sql`select u.id, u.email::text as email from public.memberships m
            join auth.users u on u.id = m.user_id
            where m.organization_id = ${cast.B.orgId} and m.role = 'store' limit 1`,
      );
      const visitors: Array<[string, Persona]> = [
        ["outsider", cast.personas.outsider],
        ["butik i B", persona(storeB, cast.B.orgId)],
        ["stranger", cast.personas.stranger],
        ["anon", cast.personas.anon],
      ];
      const problems: string[] = [];
      for (const [who, p] of visitors) {
        await loginAs(req, p);
        const params = page.params(cast);
        const problem = pageProblem(await renderDynamic(page, params), params);
        if (problem) problems.push(`${who}: ${problem}`);
      }
      expect(problems).toEqual([]);
    },
    60_000,
  );

  it("kontroll: ägaren i A ser A:s automat och butik (läckkontrollen kan slå till)", async () => {
    await loginAs(req, cast.personas.owner);
    for (const path of ["/drift/automat/[id]", "/butiker/[butik]"]) {
      const page = DYNAMIC_PAGES.find((p) => p.path === path)!;
      const params = page.params(cast);
      const outcome = await renderDynamic(page, params);
      expect(outcome.kind, path).toBe("ok");
      expect(leaked(allIdsA, params, outcome).length, path).toBeGreaterThan(0);
    }
  });

  it("sidans metadata (fliktiteln) visar inte A:s butiksnamn för en utomstående", async () => {
    const mod = (await import("@/app/(app)/butiker/[butik]/page")) as {
      generateMetadata: (p: { params: Promise<{ butik: string }> }) => Promise<{ title?: unknown }>;
    };
    for (const p of ["outsider", "refiller", "store", "stranger"] as PersonaName[]) {
      await loginAs(req, cast.personas[p]);
      const outcome = await call(() =>
        mod.generateMetadata({ params: Promise.resolve({ butik: cast.A.storeId }) }),
      );
      expect(JSON.stringify(outcome), p).not.toContain(SECRET_STORE);
    }
  });

  it("påfyllaren: /inkorg/[id] nekas och /datakallor/importer/[id] nekas", async () => {
    await loginAs(req, cast.personas.refiller);
    for (const page of DYNAMIC_PAGES.filter((p) =>
      [
        "/inkorg/[id]",
        "/datakallor/importer/[id]",
        "/rapport/[id]",
        "/rapport/[id]/epost",
      ].includes(p.path),
    )) {
      const outcome = await renderDynamic(page, page.params(cast));
      expect(outcome.kind, page.path).not.toBe("ok");
    }
  });

  it("påfyllaren: /drift/automat/[id] för A:s automat bär inga belopp till klienten", async () => {
    await loginAs(req, cast.personas.refiller);
    const page = DYNAMIC_PAGES.find((p) => p.path === "/drift/automat/[id]")!;
    const outcome = await renderDynamic(page, page.params(cast));
    expect(outcome.kind, outcome.kind === "ok" ? "" : JSON.stringify(outcome).slice(0, 200)).toBe(
      "ok",
    );
    const money = [...keysDeep((outcome as { value: unknown }).value)].filter((k) =>
      MONEY_KEY.test(k),
    );
    expect(money).toEqual([]);
  });

  it("läsaren: /datakallor/importer/[id] (operatörssida) nekas", async () => {
    await loginAs(req, cast.personas.viewer);
    const page = DYNAMIC_PAGES.find((p) => p.path === "/datakallor/importer/[id]")!;
    const outcome = await renderDynamic(page, page.params(cast));
    expect(outcome.kind).not.toBe("ok");
  });
});

// ---------------------------------------------------------------------------
// 5. RPC:er direkt (som PostgREST)
// ---------------------------------------------------------------------------

async function rpcAs(
  who: TestUser | "anon",
  query: ReturnType<typeof sql>,
): Promise<{ ok: true; rows: unknown[] } | { ok: false; code: string }> {
  try {
    const run = async (tx: Parameters<Parameters<typeof asPostgres>[0]>[0]) =>
      Array.from(await tx.execute(query));
    const result = who === "anon" ? await asAnon(run) : await asUser(who, run);
    return { ok: true, rows: result };
  } catch (error) {
    return { ok: false, code: pgError(error)?.code ?? "?" };
  }
}

describe("RPC:er som bara fanns i katalogtestet", () => {
  const sha = "a".repeat(64);
  const attach = (c: Cast) =>
    sql`select public.attach_contract_file(
          ${c.A.orgId}::uuid, ${c.A.contractId}::uuid,
          ${`${c.A.orgId}/${c.A.contractId}/${sha}.pdf`}, 'rt7k.pdf', 'application/pdf', 10, ${sha})`;

  it("attach_contract_file: läsare, påfyllare, butik, utomstående och anon nekas (42501) och avtalet ändras inte", async () => {
    const before = await fingerprint(cast.A.orgId);
    const problems: string[] = [];
    for (const p of ["viewer", "refiller", "store", "outsider", "stranger"] as PersonaName[]) {
      const r = await rpcAs(cast.personas[p].user!, attach(cast));
      if (r.ok || r.code !== "42501") problems.push(`${p}: ${JSON.stringify(r).slice(0, 120)}`);
    }
    const anon = await rpcAs("anon", attach(cast));
    if (anon.ok || anon.code !== "42501") problems.push(`anon: ${JSON.stringify(anon)}`);
    expect(problems).toEqual([]);
    expect(changedTables(before, await fingerprint(cast.A.orgId))).toEqual([]);
  });

  it("attach_contract_file: B:s ägare kan inte peka B:s organisation mot A:s avtal", async () => {
    const before = await fingerprint(cast.A.orgId);
    const r = await rpcAs(
      cast.B.owner,
      sql`select public.attach_contract_file(
            ${cast.B.orgId}::uuid, ${cast.A.contractId}::uuid,
            ${`${cast.B.orgId}/${cast.A.contractId}/${sha}.pdf`}, 'x.pdf', 'application/pdf', 10, ${sha})`,
    );
    expect(r.ok).toBe(false);
    expect(changedTables(before, await fingerprint(cast.A.orgId))).toEqual([]);
  });

  it("list_members: läsare, påfyllare, butik och utomstående får inga e-postadresser ur A", async () => {
    const problems: string[] = [];
    for (const p of ["viewer", "refiller", "store", "outsider", "stranger"] as PersonaName[]) {
      const r = await rpcAs(
        cast.personas[p].user!,
        sql`select * from public.list_members(${cast.A.orgId}::uuid)`,
      );
      if (r.ok) problems.push(`${p}: fick ${r.rows.length} rader`);
    }
    expect(problems).toEqual([]);
  });

  it("lager_performers: butik, utomstående och icke-medlem nekas", async () => {
    const problems: string[] = [];
    for (const p of ["store", "outsider", "stranger"] as PersonaName[]) {
      const r = await rpcAs(
        cast.personas[p].user!,
        sql`select * from public.lager_performers(${cast.A.orgId}::uuid)`,
      );
      if (r.ok) problems.push(`${p}: fick ${r.rows.length} rader`);
    }
    expect(problems).toEqual([]);
  });

  it("register_refill: läsare, butik, utomstående och anon nekas och lagret ändras inte", async () => {
    const before = await fingerprint(cast.A.orgId);
    const q = sql`select public.register_refill(
                    ${cast.A.orgId}::uuid, ${cast.A.machineId}::uuid, ${cast.A.titleId}::uuid,
                    1, false, now(), 'rt7k')`;
    const problems: string[] = [];
    for (const p of ["viewer", "store", "outsider", "stranger"] as PersonaName[]) {
      const r = await rpcAs(cast.personas[p].user!, q);
      if (r.ok || r.code !== "42501") problems.push(`${p}: ${JSON.stringify(r).slice(0, 120)}`);
    }
    const anon = await rpcAs("anon", q);
    if (anon.ok) problems.push("anon: lyckades");
    expect(problems).toEqual([]);
    expect(changedTables(before, await fingerprint(cast.A.orgId))).toEqual([]);
  });

  it("register_refill: påfyllaren i A kan inte använda B:s automat eller titel", async () => {
    const beforeB = await fingerprint(cast.B.orgId);
    const problems: string[] = [];
    for (const [machine, title] of [
      [cast.B.machineId, cast.A.titleId],
      [cast.A.machineId, cast.B.titleId],
    ]) {
      const r = await rpcAs(
        cast.personas.refiller.user!,
        sql`select public.register_refill(
              ${cast.A.orgId}::uuid, ${machine}::uuid, ${title}::uuid, 1, false, now(), 'rt7k')`,
      );
      if (r.ok) problems.push(`${machine}/${title}: lyckades`);
    }
    expect(problems).toEqual([]);
    expect(changedTables(beforeB, await fingerprint(cast.B.orgId))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. Överpostning av organisationen
// ---------------------------------------------------------------------------

describe("överpostning: ägaren i A skickar B:s organisation och B:s id:n", () => {
  it.each(ACTIONS.map((spec) => [label(spec), spec] as const))(
    "%s",
    async (_label, spec) => {
      const fn = await load(spec);
      const over = {
        organizationId: cast.B.orgId,
        organization_id: cast.B.orgId,
        orgId: cast.B.orgId,
      };
      // Anropet med B:s id:n (B i A:s roll i katalogen) och B:s organisation i alla fält.
      const args = spec
        .args(swapped(cast))
        .map((a) => (a && typeof a === "object" && !Array.isArray(a) ? { ...a, ...over } : a));
      const before = await fingerprint(cast.B.orgId);
      await loginAs(req, cast.personas.owner);
      const outcome = await call(() => fn(...args));
      const problems: string[] = [];
      const changed = changedTables(before, await fingerprint(cast.B.orgId));
      if (changed.length > 0) problems.push(`ändrade ${changed.join(", ")} i B`);
      const l = leaked(allIdsB, args, outcome);
      if (l.length > 0) problems.push(`svaret innehåller B:s id ${l[0]}`);
      expect(problems).toEqual([]);
    },
    60_000,
  );
});
