/**
 * Gemensamt för den röda granskningen i fas 7 (test/db/redteam-fas7-*.test.ts).
 *
 * Testerna kör HELA serverstacken som i appen: den riktiga dev-inloggningen
 * (HS256-cookien bl_session verifieras mot DEV_AUTH_SECRET och auth.users),
 * src/server/session.ts, requireRole/requireContextRole, laddarna och RLS. Det
 * enda som ersätts är Nexts förfrågan (next/headers: cookies och headers),
 * redirect/notFound (kastar NextSignal) och revalidatePath. Mockarna själva
 * ligger i varje testfil (vi.mock hissas bara där), byggda med
 * `createRequestMock()` härifrån.
 *
 * Personerna (Cast):
 *   A-organisationen (offret, seedTenantFixture: en rad i varje tabell)
 *     owner, admin, viewer, refiller, store (butiksanvändare för A:s butik)
 *   outsider  ägare i organisationen B (egen fixtur), aktiv organisation B
 *   stranger  inloggad men utan medlemskap
 *   anon      ingen session alls
 */

import { sql } from "drizzle-orm";

import { signDevSession } from "../../src/server/auth/session-token";
import {
  createMember,
  createUser,
  db,
  one,
  orgScopedTables,
  rows,
  seedTenantFixture,
  uniqueSuffix,
  type TenantFixture,
  type TestUser,
} from "./helpers";

// ---------------------------------------------------------------------------
// Nexts förfrågan
// ---------------------------------------------------------------------------

export interface FakeRequest {
  cookies: Map<string, string>;
  headers: Map<string, string>;
}

/** Signalen som redirect()/notFound() kastar i testerna (med Nexts digest). */
export class NextSignal extends Error {
  constructor(readonly digest: string) {
    super(digest);
    this.name = "NextSignal";
  }
  get redirectTo(): string | null {
    return this.digest.startsWith("NEXT_REDIRECT;") ? (this.digest.split(";")[2] ?? null) : null;
  }
}

/** Implementationerna bakom vi.mock("next/headers") och vi.mock("next/navigation"). */
export function createRequestMock(req: FakeRequest) {
  const cookieStore = {
    get: (name: string) =>
      req.cookies.has(name) ? { name, value: req.cookies.get(name)! } : undefined,
    getAll: () => [...req.cookies].map(([name, value]) => ({ name, value })),
    has: (name: string) => req.cookies.has(name),
    set: (nameOrObj: string | { name: string; value: string }, value?: string) => {
      if (typeof nameOrObj === "string") req.cookies.set(nameOrObj, value ?? "");
      else req.cookies.set(nameOrObj.name, nameOrObj.value);
    },
    delete: (nameOrObj: string | { name: string }) => {
      req.cookies.delete(typeof nameOrObj === "string" ? nameOrObj : nameOrObj.name);
    },
  };
  return {
    headers: {
      cookies: async () => cookieStore,
      headers: async () => new Headers([...req.headers]),
    },
    navigation: {
      redirect: (url: string): never => {
        throw new NextSignal(`NEXT_REDIRECT;replace;${url};307;`);
      },
      permanentRedirect: (url: string): never => {
        throw new NextSignal(`NEXT_REDIRECT;replace;${url};308;`);
      },
      notFound: (): never => {
        throw new NextSignal("NEXT_HTTP_ERROR_FALLBACK;404");
      },
      forbidden: (): never => {
        throw new NextSignal("NEXT_HTTP_ERROR_FALLBACK;403");
      },
      unauthorized: (): never => {
        throw new NextSignal("NEXT_HTTP_ERROR_FALLBACK;401");
      },
      unstable_rethrow: (error: unknown) => {
        if (error instanceof NextSignal) throw error;
      },
    },
  };
}

// ---------------------------------------------------------------------------
// Personerna
// ---------------------------------------------------------------------------

export type PersonaName =
  | "owner"
  | "admin"
  | "viewer"
  | "refiller"
  | "store"
  | "outsider"
  | "stranger"
  | "anon";

export interface Persona {
  name: PersonaName;
  user: TestUser | null;
  /** Organisationen i cookien bl_org (den aktiva). */
  orgId: string | null;
}

export interface Cast {
  A: TenantFixture;
  B: TenantFixture;
  personas: Record<PersonaName, Persona>;
  storeUser: TestUser;
  /** Ett id per tabell i A (första raden), för IDOR-försök. */
  idsA: Record<string, string>;
  /** Ett id per tabell i B. */
  idsB: Record<string, string>;
}

/** Användaren med rollen store i organisationen (fixturens butiksanvändare). */
async function storeUserOf(orgId: string): Promise<TestUser> {
  const row = await one<{ id: string; email: string }>(
    db(),
    sql`select u.id, u.email::text as email
        from public.memberships m join auth.users u on u.id = m.user_id
        where m.organization_id = ${orgId} and m.role = 'store'
        limit 1`,
  );
  return row;
}

/** Ett id (kolumnen id) per organisationsbunden tabell. */
export async function idsPerTable(orgId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of await orgScopedTables()) {
    const hasId = await rows(
      db(),
      sql`select 1 from information_schema.columns
          where table_schema = 'public' and table_name = ${table} and column_name = 'id'`,
    );
    if (hasId.length === 0) continue;
    const found = await rows<{ id: string }>(
      db(),
      sql`select id::text as id from ${sql.identifier("public")}.${sql.identifier(table)}
          where organization_id = ${orgId} order by created_at nulls last, id limit 1`,
    ).catch(() =>
      rows<{ id: string }>(
        db(),
        sql`select id::text as id from ${sql.identifier("public")}.${sql.identifier(table)}
            where organization_id = ${orgId} limit 1`,
      ),
    );
    if (found[0]) out[table] = found[0].id;
  }
  return out;
}

export async function seedCast(): Promise<Cast> {
  const A = await seedTenantFixture();
  const B = await seedTenantFixture();
  const admin = await createMember(A.orgId, "admin");
  const viewer = await createMember(A.orgId, "viewer");
  const refiller = await createMember(A.orgId, "refiller");
  const storeUser = await storeUserOf(A.orgId);
  const stranger = await createUser(`stranger-${uniqueSuffix()}@test.binderlab.se`);
  const personas: Record<PersonaName, Persona> = {
    owner: { name: "owner", user: A.owner, orgId: A.orgId },
    admin: { name: "admin", user: admin, orgId: A.orgId },
    viewer: { name: "viewer", user: viewer, orgId: A.orgId },
    refiller: { name: "refiller", user: refiller, orgId: A.orgId },
    // Butiksanvändaren försöker med A som aktiv organisation (cookien kan sättas fritt).
    store: { name: "store", user: storeUser, orgId: A.orgId },
    outsider: { name: "outsider", user: B.owner, orgId: B.orgId },
    stranger: { name: "stranger", user: stranger, orgId: A.orgId },
    anon: { name: "anon", user: null, orgId: A.orgId },
  };
  return {
    A,
    B,
    personas,
    storeUser,
    idsA: await idsPerTable(A.orgId),
    idsB: await idsPerTable(B.orgId),
  };
}

/** Loggar in personen i den fejkade förfrågan (riktig dev-sessionscookie). */
export async function loginAs(req: FakeRequest, persona: Persona): Promise<void> {
  req.cookies.clear();
  req.headers.clear();
  req.headers.set("host", "localhost:3200");
  req.headers.set("x-forwarded-for", `10.0.${Math.floor(Math.random() * 250)}.1`);
  if (persona.orgId) req.cookies.set("bl_org", persona.orgId);
  if (!persona.user) return;
  const secret = process.env.DEV_AUTH_SECRET;
  if (!secret) throw new Error("DEV_AUTH_SECRET saknas (.env.local).");
  req.cookies.set(
    "bl_session",
    await signDevSession({ userId: persona.user.id, email: persona.user.email }, secret),
  );
}

// ---------------------------------------------------------------------------
// Fingeravtryck: har något i organisationen ändrats?
// ---------------------------------------------------------------------------

/** md5 per organisationsbunden tabell (alla kolumner, sorterat), plus storage.objects. */
export async function fingerprint(orgId: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const table of await orgScopedTables()) {
    const r = await one<{ h: string | null }>(
      db(),
      sql`select md5(coalesce(string_agg(t::text, '|' order by t::text), '')) as h
          from ${sql.identifier("public")}.${sql.identifier(table)} t
          where t.organization_id = ${orgId}`,
    );
    out[table] = r.h ?? "";
  }
  const objects = await one<{ h: string | null }>(
    db(),
    sql`select md5(coalesce(string_agg(name || ':' || coalesce(bucket_id, ''), '|' order by name), '')) as h
        from storage.objects where name like ${`${orgId}/%`}`,
  );
  out["storage.objects"] = objects.h ?? "";
  return out;
}

/** Tabellerna som skiljer sig mellan två fingeravtryck. */
export function changedTables(
  before: Record<string, string>,
  after: Record<string, string>,
): string[] {
  return Object.keys({ ...before, ...after })
    .filter((k) => before[k] !== after[k])
    .sort();
}

// ---------------------------------------------------------------------------
// Utfallet av ett anrop
// ---------------------------------------------------------------------------

export type CallOutcome =
  | { kind: "ok"; value: unknown }
  | { kind: "refused"; value: unknown; error: string }
  | { kind: "redirect"; to: string }
  | { kind: "notFound" }
  | { kind: "threw"; name: string; message: string };

/** Kör ett serveranrop och sorterar utfallet. */
export async function call(fn: () => Promise<unknown>): Promise<CallOutcome> {
  try {
    const value = await fn();
    if (value && typeof value === "object" && "ok" in value) {
      const v = value as { ok: unknown; error?: unknown; errors?: unknown; message?: unknown };
      if (v.ok === false) {
        const error =
          typeof v.error === "string"
            ? v.error
            : typeof v.message === "string"
              ? v.message
              : v.errors
              ? JSON.stringify(v.errors)
              : "(inget meddelande)";
        return { kind: "refused", value, error };
      }
    }
    return { kind: "ok", value };
  } catch (error) {
    if (error instanceof NextSignal) {
      return error.redirectTo !== null
        ? { kind: "redirect", to: error.redirectTo }
        : { kind: "notFound" };
    }
    const e = error as { name?: string; message?: string };
    return { kind: "threw", name: e?.name ?? "Error", message: String(e?.message ?? error) };
  }
}

/** Nekad: fel, omdirigering eller undantag (inte ett lyckat anrop). */
export function isDenied(outcome: CallOutcome): boolean {
  return outcome.kind !== "ok";
}

/**
 * Nekad PÅ GRUND AV BEHÖRIGHET (inte valideringsfel): visar att kontrollen av rollen
 * faktiskt nåddes. Meddelandena är appens egna svenska texter.
 */
export function isAuthDenial(outcome: CallOutcome): boolean {
  const AUTH =
    /behörighet|bara ägare|bara ägaren|inte inloggad|inte medlem|logga in|ägare och admin|ägare, admin|forbidden|får inte|kan inte ändra/i;
  switch (outcome.kind) {
    case "ok":
      return false;
    case "redirect":
      return outcome.to.startsWith("/logga-in") || outcome.to === "/";
    case "notFound":
      return true;
    case "refused":
      return AUTH.test(outcome.error);
    case "threw":
      return outcome.name === "AuthorizationError" || AUTH.test(outcome.message);
  }
}

/** Alla nycklar (rekursivt) i ett värde. Tål cykler (React-element har _owner). */
export function keysDeep(value: unknown, out = new Set<string>(), seen = new WeakSet<object>()): Set<string> {
  if (!value || typeof value !== "object" || seen.has(value)) return out;
  seen.add(value);
  if (Array.isArray(value)) {
    for (const v of value) keysDeep(v, out, seen);
    return out;
  }
  for (const [k, v] of Object.entries(value)) {
    // Reacts egna fält i utvecklingsläge (inte data från appen).
    if (k === "_owner" || k === "_store" || k === "_debugInfo" || k === "_debugStack") continue;
    out.add(k);
    keysDeep(v, out, seen);
  }
  return out;
}

/** Ord i nycklar som bär belopp eller ekonomi (påfyllaren får aldrig se dem). */
const MONEY_WORDS = new Set([
  "ore",
  "amount",
  "amounts",
  "price",
  "prices",
  "revenue",
  "profit",
  "margin",
  "cost",
  "costs",
  "commission",
  "rent",
  "payout",
  "payouts",
  "fee",
  "fees",
  "kronor",
  "belopp",
  "turnover",
  "income",
  "cash",
  "sek",
  "refunded",
  "refund",
  "compensation",
  "ersattning",
]);

/** Nyckeln (camelCase eller snake_case) innehåller ett ord som bär belopp. */
export const MONEY_KEY = {
  test(key: string): boolean {
    const words = key
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean);
    return words.some((w) => MONEY_WORDS.has(w));
  },
};
