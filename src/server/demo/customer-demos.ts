/**
 * Demo för kunder (Inställningar → Demo för kunder).
 *
 * En ägare i en RIKTIG organisation skapar en egen demoorganisation åt en presumtiv
 * kund, med påhittad data (src/seed/demo) som slutar "nu", och bjuder in kunden som
 * ägare. Kunden får hela panelen men ser aldrig något från den riktiga organisationen:
 *
 * - Demon är en egen organisation (organizations.is_demo) per kund, så två kunder ser
 *   aldrig varandra. RLS isolerar den som alla andra organisationer.
 * - Ingen riktig användare är medlem. Demon ägs av tre platshållarkonton
 *   (t.ex. elin.strand.1a2b3c4d@nordljus.invalid, slumpat lösenord som aldrig sparas eller visas) med namnen ur
 *   demokatalogen. Seeden skriver som dem, med RLS, precis som den lokala demon.
 *   Databasen nekar att en medlem i en riktig organisation går med i en demo (BL091).
 * - Kopplingen till den riktiga organisationen finns bara i private.customer_demos, som
 *   kunden inte kan läsa.
 * - Inget skickas ut från demon (src/server/demo/guard.ts och migreringen).
 *
 * UNDANTAG från regeln att användarförfrågningar går via withUserDb: rollen kontrolleras
 * först under RLS (ägare i en riktig organisation), sedan arbetar servern som
 * databasägare, som seeden, eftersom demon inte har någon medlem som kan göra det och
 * konton bara kan skapas med inloggningstjänstens admin-API.
 *
 * Demon byggs i steg (organisationen och grunddata, en månadsfil i taget, lager,
 * ärenden, larm). Varje anrop till continueCustomerDemoFor kör steg tills tidsbudgeten
 * är slut, och sidan anropar igen tills demon är klar. Allt är idempotent, så ett
 * avbrutet steg körs bara om.
 */

import { randomBytes } from "node:crypto";

import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";

import { getServiceDb, type Db, type Tx } from "@/db/client";
import type { FileStore } from "@/import/file-store";
import { demoCatalog, type DemoClock } from "@/seed/demo/calendar";
import { DEMO_ORGANIZATION, DEMO_USERS } from "@/seed/demo/catalog";
import { purgeDemoOrganization, runDemoSeed, type DemoActor } from "@/seed/demo/run-demo-seed";
import { requireRoleFor, type SessionUser, withUserDbFor } from "@/server/access";
import type { ActionResult } from "@/server/auth/flows";
import { dbErrorMessage, pgErrorOf, safeErrorForLog } from "@/server/errors";

export const CUSTOMER_DEMO_MESSAGES = {
  forbidden: "Bara ägaren kan skapa demos för kunder.",
  insideDemo: "Det här är en demo. Kunddemos skapas från din riktiga organisation.",
  invalidEmail: "Ange kundens e-postadress.",
  realUser: "Den e-posten används redan i Binderlab. Använd kundens egen adress.",
  duplicate: "Det finns redan en demo för den adressen.",
  limit: "Du har redan tio demos. Ta bort en först.",
  missing: "Demon finns inte längre.",
  busy: "Demon arbetar redan. Vänta en stund.",
  failed: "Demon kunde inte skapas. Tryck på Återställ för att försöka igen.",
  notReady: "Demon är inte klar än.",
  accepted: "Kunden har redan gått med.",
  unavailable: "Det går inte att skapa demos här (inloggningstjänsten saknar admin-åtkomst).",
} as const;

/** Högst så många demos per organisation. */
export const CUSTOMER_DEMO_LIMIT = 10;
/** Inbjudan till demon gäller så här länge. */
export const CUSTOMER_DEMO_INVITE_DAYS = 14;
/** Tid per anrop innan steget lämnar tillbaka (Vercel tillåter 300 s). */
export const CUSTOMER_DEMO_STEP_BUDGET_MS = 90_000;
const LEASE_SECONDS = 240;

export interface CustomerDemoDeps {
  db?: () => Db;
  /** Inloggningstjänstens admin: platshållarkonton och radering. */
  users: {
    createSystemUser(email: string, fullName: string): Promise<string>;
    deleteUser(userId: string): Promise<void>;
  };
  /** Skickar inbjudningsmejlet (samma som Användare → Bjud in). */
  sendInvite(email: string, acceptUrl: string): Promise<void>;
  /** Appens adress utan avslutande snedstreck. */
  baseUrl: string;
  now?: () => Date;
  fileStore?: FileStore;
  stepBudgetMs?: number;
  log?: (message: string) => void;
}

export interface CustomerDemoListItem {
  id: string;
  customerEmail: string;
  status: "creating" | "ready" | "failed";
  step: number;
  steps: number;
  createdAt: string;
  accepted: boolean;
  invitationExpiresAt: string | null;
}

export interface CustomerDemoProgress {
  id: string;
  status: "creating" | "ready" | "failed";
  step: number;
  steps: number;
  /** Mejlet till kunden gick iväg (när demon blev klar). */
  emailSent?: boolean;
}

interface DemoRow extends Record<string, unknown> {
  id: string;
  organization_id: string;
  demo_organization_id: string | null;
  customer_email: string;
  placeholder_user_ids: string[];
  customer_user_id: string | null;
  clock_date: string;
  clock_hour: number;
  status: "creating" | "ready" | "failed";
  step: number;
  steps: number;
  created_at: string;
}

const emailInput = z.email().trim().toLowerCase().max(320);
const idInput = z.uuid();

async function rows<T extends Record<string, unknown>>(
  executor: Db | Tx,
  query: SQL,
): Promise<T[]> {
  return Array.from(await executor.execute(query)) as T[];
}

/**
 * Platshållarens e-post: namnet ur katalogen och ett slumpat suffix på .invalid (kan aldrig
 * ta emot mejl). Syns för kunden under Användare, så den ska se ut som en kollega.
 */
export function placeholderEmailFor(fullName: string): string {
  const local = fullName
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ".")
    .replace(/^\.+|\.+$/g, "");
  return `${local || "demo"}.${randomBytes(4).toString("hex")}@nordljus.invalid`;
}

/** Demons "nu": svenskt datum och hel timme just nu. */
export function stockholmClock(now: Date): DemoClock {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Europe/Stockholm",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  return { date: `${get("year")}-${get("month")}-${get("day")}`, hour: Number(get("hour")) % 24 };
}

/** Ägare i den aktiva organisationen, och organisationen är inte själv en demo. */
async function requireRealOwner(
  user: SessionUser | null,
  organizationId: unknown,
): Promise<{ ok: true; organizationId: string } | { ok: false; error: string }> {
  const parsed = idInput.safeParse(organizationId);
  if (!user || !parsed.success) {
    return { ok: false, error: CUSTOMER_DEMO_MESSAGES.forbidden };
  }
  try {
    await requireRoleFor(user, parsed.data, ["owner"]);
  } catch {
    return { ok: false, error: CUSTOMER_DEMO_MESSAGES.forbidden };
  }
  const demo = await withUserDbFor(user, async (tx) => {
    const r = await rows<{ is_demo: boolean }>(
      tx,
      sql`select is_demo from public.organizations where id = ${parsed.data}::uuid`,
    );
    return r[0]?.is_demo ?? true;
  });
  if (demo) {
    return { ok: false, error: CUSTOMER_DEMO_MESSAGES.insideDemo };
  }
  return { ok: true, organizationId: parsed.data };
}

async function demoRow(
  db: Db | Tx,
  organizationId: string,
  demoId: unknown,
): Promise<DemoRow | null> {
  const id = idInput.safeParse(demoId);
  if (!id.success) return null;
  const r = await rows<DemoRow>(
    db,
    sql`select id, organization_id, demo_organization_id, customer_email::text as customer_email,
               placeholder_user_ids::text[] as placeholder_user_ids, customer_user_id,
               clock_date::text as clock_date, clock_hour, status, step, steps, created_at::text as created_at
        from private.customer_demos
        where id = ${id.data}::uuid and organization_id = ${organizationId}::uuid`,
  );
  return r[0] ?? null;
}

/** Tar raden för ett steg (eller null om någon annan redan arbetar med den). */
async function claim(db: Db, id: string): Promise<boolean> {
  const r = await rows(
    db,
    sql`update private.customer_demos
        set lease_until = now() + make_interval(secs => ${LEASE_SECONDS}), updated_at = now()
        where id = ${id}::uuid and (lease_until is null or lease_until < now())
        returning id`,
  );
  return r.length > 0;
}

async function release(db: Db, id: string): Promise<void> {
  await db.execute(
    sql`update private.customer_demos set lease_until = null where id = ${id}::uuid`,
  );
}

async function placeholders(db: Db, ids: readonly string[]): Promise<DemoActor[]> {
  const r = await rows<{ id: string; email: string; full_name: string | null }>(
    db,
    sql`select id::text as id, email::text as email, raw_user_meta_data ->> 'full_name' as full_name
        from auth.users where id = any(${`{${ids.join(",")}}`}::uuid[])`,
  );
  return ids.map((id) => {
    const u = r.find((x) => x.id === id);
    if (!u) throw new Error("Demons platshållarkonto saknas.");
    return { id: u.id, email: u.email, fullName: u.full_name ?? "Demo" };
  });
}

/** Som platshållaren, med RLS (samma som seeden). `setup`: får bjuda in i demon. */
async function asPlaceholder<T>(db: Db, actor: DemoActor, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const claims = JSON.stringify({
    sub: actor.id,
    email: actor.email,
    role: "authenticated",
    aud: "authenticated",
    user_metadata: { full_name: actor.fullName },
  });
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`select set_config('request.jwt.claims', ${claims}, true),
                 set_config('binderlab.demo_setup', 'on', true),
                 set_config('role', 'authenticated', true)`,
    );
    return fn(tx);
  });
}

/** Ny demoorganisation som platshållarägaren, markerad som demo i samma transaktion. */
async function createDemoOrganization(db: Db, owner: DemoActor): Promise<string> {
  // Inte "nordljus-demo…": den lokala demon (slug nordljus-demo) får inte anropa Claude i
  // produktion, men kunden ska kunna prova assistenten (med samma tak och gränser).
  const slug = `kunddemo-${randomBytes(5).toString("hex")}`;
  return asPlaceholder(db, owner, async (tx) => {
    const r = await rows<{ id: string }>(
      tx,
      sql`select public.create_organization(${DEMO_ORGANIZATION.name}, ${slug}) as id`,
    );
    const id = r[0]?.id;
    if (!id) throw new Error("Organisationen skapades inte.");
    await tx.execute(sql`reset role`);
    await tx.execute(sql`update public.organizations set is_demo = true where id = ${id}::uuid`);
    return id;
  });
}

/**
 * Spärren innan en demo raderas (körs med organisationsraden låst): demoorganisationen är
 * skapad av en av radens platshållare, och ingen medlem är med i en riktig organisation.
 */
function purgeCheck(row: DemoRow, demoOrgId: string) {
  return async (tx: Tx): Promise<string | null> => {
    const owned = await rows(
      tx,
      sql`select 1 from public.organizations o
          where o.id = ${demoOrgId}::uuid and o.is_demo
            and o.created_by = any(${`{${row.placeholder_user_ids.join(",")}}`}::uuid[])`,
    );
    if (owned.length === 0) {
      return "demon hör inte till den här kunddemon.";
    }
    const real = await rows(
      tx,
      sql`select 1 from public.memberships m
          where m.organization_id = ${demoOrgId}::uuid
            and exists (
              select 1 from public.memberships r
              join public.organizations o on o.id = r.organization_id
              where r.user_id = m.user_id and not o.is_demo
            )`,
    );
    return real.length > 0 ? "demon har en medlem från en riktig organisation." : null;
  };
}

async function sendDemoInvitation(
  db: Db,
  deps: CustomerDemoDeps,
  row: DemoRow,
  owner: DemoActor,
): Promise<boolean> {
  const token = await asPlaceholder(db, owner, async (tx) => {
    const r = await rows<{ token: string }>(
      tx,
      sql`select public.create_invitation(
            ${row.demo_organization_id}::uuid, ${row.customer_email}, 'owner'::public.member_role,
            ${CUSTOMER_DEMO_INVITE_DAYS}::integer
          ) as token`,
    );
    const value = r[0]?.token;
    if (!value) throw new Error("Inbjudan skapades inte.");
    return value;
  });
  try {
    await deps.sendInvite(row.customer_email, `${deps.baseUrl}/inbjudan/${token}`);
    return true;
  } catch (error) {
    console.error("[demo] inbjudan gick inte iväg", safeErrorForLog(error));
    return false;
  }
}

/** Kunden (efter återställning) läggs tillbaka som ägare, annars bjuds hen in. */
async function welcomeCustomer(
  db: Db,
  deps: CustomerDemoDeps,
  row: DemoRow,
  owner: DemoActor,
): Promise<boolean | undefined> {
  if (row.customer_user_id) {
    try {
      await db.transaction(async (tx) => {
        await tx.execute(
          sql`insert into public.memberships (organization_id, user_id, role)
              select ${row.demo_organization_id}::uuid, u.id, 'owner'
              from auth.users u
              where u.id = ${row.customer_user_id}::uuid
                and lower(u.email::text) = lower(${row.customer_email})
              on conflict (organization_id, user_id) do nothing`,
        );
        await tx.execute(
          sql`insert into public.profiles (organization_id, user_id, display_name)
              select ${row.demo_organization_id}::uuid, u.id,
                     coalesce(nullif(btrim(u.raw_user_meta_data ->> 'full_name'), ''),
                              split_part(u.email::text, '@', 1))
              from auth.users u
              join public.memberships m on m.user_id = u.id
                and m.organization_id = ${row.demo_organization_id}::uuid
              where u.id = ${row.customer_user_id}::uuid
              on conflict (organization_id, user_id) do nothing`,
        );
      });
      const back = await rows(
        db,
        sql`select 1 from public.memberships
            where organization_id = ${row.demo_organization_id}::uuid
              and user_id = ${row.customer_user_id}::uuid`,
      );
      if (back.length > 0) return undefined;
    } catch (error) {
      // T.ex. BL091: kunden har sedan dess blivit medlem i en riktig organisation.
      console.warn("[demo] kunden kunde inte läggas tillbaka", safeErrorForLog(error));
    }
  }
  return sendDemoInvitation(db, deps, row, owner);
}

function errorMessage(error: unknown, fallback: string): string {
  const pg = pgErrorOf(error);
  return pg && /^BL0\d\d$/.test(pg.code) ? dbErrorMessage(error) : fallback;
}

// ---------------------------------------------------------------------------
// Flöden (anropas av server actions)
// ---------------------------------------------------------------------------

/** Ägarens lista (RPC list_customer_demos under RLS). */
export async function listCustomerDemosFor(
  user: SessionUser | null,
  organizationId: unknown,
): Promise<ActionResult<CustomerDemoListItem[]>> {
  const owner = await requireRealOwner(user, organizationId);
  if (!owner.ok || !user) return { ok: false, error: owner.ok ? "" : owner.error };
  const list = await withUserDbFor(user, (tx) =>
    rows<{
      id: string;
      customer_email: string;
      status: CustomerDemoListItem["status"];
      step: number;
      steps: number;
      created_at: string | Date;
      accepted: boolean;
      invitation_expires_at: string | Date | null;
    }>(tx, sql`select * from public.list_customer_demos(${owner.organizationId}::uuid)`),
  );
  const iso = (v: string | Date) =>
    v instanceof Date ? v.toISOString() : new Date(v).toISOString();
  return {
    ok: true,
    data: list.map((d) => ({
      id: d.id,
      customerEmail: d.customer_email,
      status: d.status,
      step: d.step,
      steps: d.steps,
      createdAt: iso(d.created_at),
      accepted: d.accepted,
      invitationExpiresAt: d.invitation_expires_at ? iso(d.invitation_expires_at) : null,
    })),
  };
}

/** Skapar konton och organisation (snabbt). Datan byggs sedan med continueCustomerDemoFor. */
export async function createCustomerDemoFor(
  user: SessionUser | null,
  deps: CustomerDemoDeps,
  input: { organizationId: unknown; email: unknown },
): Promise<ActionResult<CustomerDemoProgress>> {
  const owner = await requireRealOwner(user, input?.organizationId);
  if (!owner.ok || !user) return { ok: false, error: owner.ok ? "" : owner.error };
  const email = emailInput.safeParse(input?.email);
  if (!email.success || email.data.endsWith(".invalid")) {
    return { ok: false, error: CUSTOMER_DEMO_MESSAGES.invalidEmail };
  }
  const db = (deps.db ?? getServiceDb)();
  const real = await rows(
    db,
    sql`select 1 from auth.users u
        join public.memberships m on m.user_id = u.id
        join public.organizations o on o.id = m.organization_id
        where lower(u.email::text) = ${email.data} and not o.is_demo
        limit 1`,
  );
  if (real.length > 0) return { ok: false, error: CUSTOMER_DEMO_MESSAGES.realUser };
  const existing = await rows<{ customer_email: string }>(
    db,
    sql`select customer_email::text as customer_email from private.customer_demos
        where organization_id = ${owner.organizationId}::uuid`,
  );
  if (existing.some((d) => d.customer_email.toLowerCase() === email.data)) {
    return { ok: false, error: CUSTOMER_DEMO_MESSAGES.duplicate };
  }
  if (existing.length >= CUSTOMER_DEMO_LIMIT) {
    return { ok: false, error: CUSTOMER_DEMO_MESSAGES.limit };
  }

  const clock = stockholmClock((deps.now ?? (() => new Date()))());
  const created: string[] = [];
  try {
    for (const role of ["owner", "viewer", "refiller"] as const) {
      const placeholderEmail = placeholderEmailFor(DEMO_USERS[role].fullName);
      created.push(await deps.users.createSystemUser(placeholderEmail, DEMO_USERS[role].fullName));
    }
    const [ownerActor] = await placeholders(db, created);
    const orgId = await createDemoOrganization(db, ownerActor as DemoActor);
    const r = await rows<{ id: string }>(
      db,
      sql`insert into private.customer_demos
            (organization_id, demo_organization_id, customer_email, placeholder_user_ids,
             clock_date, clock_hour, status, step, steps, created_by)
          values (${owner.organizationId}::uuid, ${orgId}::uuid, ${email.data},
                  ${`{${created.join(",")}}`}::uuid[], ${clock.date}::date, ${clock.hour}::integer,
                  'creating', 0, 0, ${user.userId}::uuid)
          returning id`,
    );
    const id = r[0]?.id as string;
    return { ok: true, data: { id, status: "creating", step: 0, steps: 0 } };
  } catch (error) {
    console.error("[demo] kunde inte skapas", safeErrorForLog(error));
    for (const id of created) {
      await deps.users.deleteUser(id).catch(() => {});
    }
    return { ok: false, error: errorMessage(error, CUSTOMER_DEMO_MESSAGES.failed) };
  }
}

/** Bygger demon vidare i högst stegbudgeten. Anropas tills status är "ready". */
export async function continueCustomerDemoFor(
  user: SessionUser | null,
  deps: CustomerDemoDeps,
  input: { organizationId: unknown; demoId: unknown },
): Promise<ActionResult<CustomerDemoProgress>> {
  const owner = await requireRealOwner(user, input?.organizationId);
  if (!owner.ok) return { ok: false, error: owner.error };
  const db = (deps.db ?? getServiceDb)();
  const row = await demoRow(db, owner.organizationId, input?.demoId);
  if (!row) return { ok: false, error: CUSTOMER_DEMO_MESSAGES.missing };
  const progress = (r: DemoRow, extra: Partial<CustomerDemoProgress> = {}) => ({
    ok: true as const,
    data: { id: r.id, status: r.status, step: r.step, steps: r.steps, ...extra },
  });
  if (row.status === "ready") return progress(row);
  if (!row.demo_organization_id) return { ok: false, error: CUSTOMER_DEMO_MESSAGES.failed };
  if (!(await claim(db, row.id))) return progress(row);
  try {
    const [o, v, r] = await placeholders(db, row.placeholder_user_ids);
    const users = { owner: o as DemoActor, viewer: v as DemoActor, refiller: r as DemoActor };
    const budget = deps.stepBudgetMs ?? CUSTOMER_DEMO_STEP_BUDGET_MS;
    const result = await runDemoSeed(db, {
      password: "",
      manageUsers: false,
      catalog: demoCatalog({ date: row.clock_date, hour: row.clock_hour }),
      existing: { organizationId: row.demo_organization_id, users },
      deadlineMs: Date.now() + budget,
      fileStore: deps.fileStore,
      log: deps.log,
    });
    const next: DemoRow = {
      ...row,
      step: result.progress.step,
      steps: result.progress.steps,
      status: result.done ? "ready" : "creating",
    };
    let emailSent: boolean | undefined;
    if (result.done) {
      emailSent = await welcomeCustomer(db, deps, row, users.owner);
    }
    await db.execute(
      sql`update private.customer_demos
          set step = ${next.step}, steps = ${next.steps}, status = ${next.status},
              customer_user_id = case when ${next.status} = 'ready' then null else customer_user_id end,
              updated_at = now()
          where id = ${row.id}::uuid`,
    );
    return progress(next, emailSent === undefined ? {} : { emailSent });
  } catch (error) {
    console.error("[demo] steget misslyckades", safeErrorForLog(error));
    await db.execute(
      sql`update private.customer_demos set status = 'failed', updated_at = now() where id = ${row.id}::uuid`,
    );
    return { ok: false, error: CUSTOMER_DEMO_MESSAGES.failed };
  } finally {
    await release(db, row.id);
  }
}

/** Ny inbjudan till kunden (den gamla länken slutar gälla). */
export async function resendCustomerDemoInviteFor(
  user: SessionUser | null,
  deps: CustomerDemoDeps,
  input: { organizationId: unknown; demoId: unknown },
): Promise<ActionResult<{ emailSent: boolean }>> {
  const owner = await requireRealOwner(user, input?.organizationId);
  if (!owner.ok) return { ok: false, error: owner.error };
  const db = (deps.db ?? getServiceDb)();
  const row = await demoRow(db, owner.organizationId, input?.demoId);
  if (!row || !row.demo_organization_id)
    return { ok: false, error: CUSTOMER_DEMO_MESSAGES.missing };
  if (row.status !== "ready") return { ok: false, error: CUSTOMER_DEMO_MESSAGES.notReady };
  const joined = await rows(
    db,
    sql`select 1 from public.memberships m join auth.users u on u.id = m.user_id
        where m.organization_id = ${row.demo_organization_id}::uuid
          and lower(u.email::text) = lower(${row.customer_email})`,
  );
  if (joined.length > 0) return { ok: false, error: CUSTOMER_DEMO_MESSAGES.accepted };
  try {
    const [o] = await placeholders(db, row.placeholder_user_ids);
    return {
      ok: true,
      data: { emailSent: await sendDemoInvitation(db, deps, row, o as DemoActor) },
    };
  } catch (error) {
    console.error("[demo] inbjudan kunde inte skapas", safeErrorForLog(error));
    return { ok: false, error: errorMessage(error, CUSTOMER_DEMO_MESSAGES.failed) };
  }
}

/**
 * Återställer demon: en ny demoorganisation med färsk data som slutar nu, och den gamla
 * raderas. Har kunden gått med läggs hen tillbaka som ägare när den nya är klar (annars
 * en ny inbjudan). Datan byggs med continueCustomerDemoFor.
 */
export async function resetCustomerDemoFor(
  user: SessionUser | null,
  deps: CustomerDemoDeps,
  input: { organizationId: unknown; demoId: unknown },
): Promise<ActionResult<CustomerDemoProgress>> {
  const owner = await requireRealOwner(user, input?.organizationId);
  if (!owner.ok) return { ok: false, error: owner.error };
  const db = (deps.db ?? getServiceDb)();
  const row = await demoRow(db, owner.organizationId, input?.demoId);
  if (!row) return { ok: false, error: CUSTOMER_DEMO_MESSAGES.missing };
  if (!(await claim(db, row.id))) return { ok: false, error: CUSTOMER_DEMO_MESSAGES.busy };
  try {
    const [o] = await placeholders(db, row.placeholder_user_ids);
    let customerUserId = row.customer_user_id;
    if (row.demo_organization_id) {
      const customer = await rows<{ id: string }>(
        db,
        sql`select u.id::text as id from public.memberships m join auth.users u on u.id = m.user_id
            where m.organization_id = ${row.demo_organization_id}::uuid
              and lower(u.email::text) = lower(${row.customer_email})`,
      );
      customerUserId = customer[0]?.id ?? customerUserId;
    }
    const clock = stockholmClock((deps.now ?? (() => new Date()))());
    const newOrg = await createDemoOrganization(db, o as DemoActor);
    const oldOrg = row.demo_organization_id;
    await db.execute(
      sql`update private.customer_demos
          set demo_organization_id = ${newOrg}::uuid, customer_user_id = ${customerUserId}::uuid,
              clock_date = ${clock.date}::date, clock_hour = ${clock.hour}::integer,
              status = 'creating', step = 0, steps = 0, updated_at = now()
          where id = ${row.id}::uuid`,
    );
    if (oldOrg) {
      await purgeDemoOrganization(db, oldOrg, purgeCheck(row, oldOrg));
    }
    return { ok: true, data: { id: row.id, status: "creating", step: 0, steps: 0 } };
  } catch (error) {
    console.error("[demo] återställningen misslyckades", safeErrorForLog(error));
    return { ok: false, error: errorMessage(error, CUSTOMER_DEMO_MESSAGES.failed) };
  } finally {
    await release(db, row.id);
  }
}

/**
 * Tar bort demon: organisationen med all data, platshållarna och kundens demokonto (om
 * kontot skapades för demon och inte är med någon annanstans).
 */
export async function deleteCustomerDemoFor(
  user: SessionUser | null,
  deps: CustomerDemoDeps,
  input: { organizationId: unknown; demoId: unknown },
): Promise<ActionResult> {
  const owner = await requireRealOwner(user, input?.organizationId);
  if (!owner.ok) return { ok: false, error: owner.error };
  const db = (deps.db ?? getServiceDb)();
  const row = await demoRow(db, owner.organizationId, input?.demoId);
  if (!row) return { ok: false, error: CUSTOMER_DEMO_MESSAGES.missing };
  if (!(await claim(db, row.id))) return { ok: false, error: CUSTOMER_DEMO_MESSAGES.busy };
  try {
    if (row.demo_organization_id) {
      await purgeDemoOrganization(
        db,
        row.demo_organization_id,
        purgeCheck(row, row.demo_organization_id),
      );
    }
    // Kundens konto: bara om det skapades efter demon och inte är med i någon organisation.
    const orphan = await rows<{ id: string }>(
      db,
      sql`select u.id::text as id from auth.users u
          where lower(u.email::text) = lower(${row.customer_email})
            and u.created_at >= ${row.created_at}::timestamptz
            and not exists (select 1 from public.memberships m where m.user_id = u.id)
            and not exists (
              select 1 from private.customer_demos d
              where d.id <> ${row.id}::uuid and d.customer_email = ${row.customer_email}::extensions.citext
            )`,
    );
    for (const u of orphan) {
      await deps.users.deleteUser(u.id);
    }
    for (const id of row.placeholder_user_ids) {
      const stillUsed = await rows(
        db,
        sql`select 1 from public.memberships where user_id = ${id}::uuid limit 1`,
      );
      if (stillUsed.length === 0) await deps.users.deleteUser(id);
    }
    await db.execute(sql`delete from private.customer_demos where id = ${row.id}::uuid`);
    return { ok: true };
  } catch (error) {
    console.error("[demo] kunde inte tas bort", safeErrorForLog(error));
    await release(db, row.id);
    return { ok: false, error: errorMessage(error, CUSTOMER_DEMO_MESSAGES.failed) };
  }
}
