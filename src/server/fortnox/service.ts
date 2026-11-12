/**
 * Fortnox för sidorna (Datakällor → Fortnox och raden på Ekonomi → Bokföring): koppla,
 * koppla från, inställningar, torrkörning/skarpt läge, "Kör nu" och rättelser.
 *
 * Bara ägare och admin som inte har Enkel vy (requireTeamManagerFor läser rollen och vyn
 * ur databasen). Läsning och inställningar görs som användaren (RLS). Token skrivs och
 * jobbet körs som systemrollen, efter att rollen kontrollerats här: token får aldrig vara
 * läsbara för en klientroll.
 */

import "server-only";

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import { sql } from "drizzle-orm";
import { z } from "zod";

import { getServiceDb, type Tx } from "@/db/client";
import type { IsoDate } from "@/domain";
import { AuthorizationError, requireTeamManagerFor, withUserDbFor } from "@/server/access";
import { AccountingError } from "@/server/accounting/service";
import { businessToday, type Viewer } from "@/server/data/core/loaders";
import { safely } from "@/server/monitoring/failures";
import { resolveSystemAlert } from "@/server/monitoring/system-alerts";

import {
  authorizeUrl,
  exchangeCode,
  FortnoxApiError,
  FortnoxAuthError,
  FortnoxClient,
  revokeRefreshToken,
  type FortnoxDeps,
} from "./client";
import { fortnoxConfig, fortnoxConfigProblem, FORTNOX_SCOPES, type FortnoxConfig } from "./config";
import { mappingInputSchema, type FortnoxMapping } from "./mapping";
import { computeDesired, readConnection, type FortnoxConnection } from "./plan";
import {
  diffOutbox,
  HUMAN_BLOCKS,
  readOutbox,
  runFortnoxFor,
  type FortnoxRunResult,
  type OutboxDiff,
  type OutboxRow,
} from "./sync";
import { clearTokens, readTokens, saveTokens } from "./tokens";
import type { DesiredVoucher } from "./vouchers";

/** Fel som visas för ägaren som de är. */
export class FortnoxError extends AccountingError {
  constructor(message: string) {
    super(message);
    this.name = "FortnoxError";
  }
}

const NOT_ALLOWED = "Bara ägare och administratörer får hantera Fortnox.";

async function operator(viewer: Viewer): Promise<void> {
  try {
    await requireTeamManagerFor(viewer.user, viewer.organization.id);
  } catch (error) {
    if (error instanceof AuthorizationError) throw new AuthorizationError("forbidden", NOT_ALLOWED);
    throw error;
  }
}

/** Får personen se och hantera Fortnox? (Ägare/admin, inte Enkel vy.) */
export async function canManageFortnox(viewer: Viewer): Promise<boolean> {
  try {
    await operator(viewer);
    return true;
  } catch (error) {
    if (error instanceof AuthorizationError) return false;
    throw error;
  }
}

async function isDemo(tx: Tx, orgId: string): Promise<boolean> {
  const rows = Array.from(
    await tx.execute<{ is_demo: boolean }>(
      sql`select is_demo from public.organizations where id = ${orgId}::uuid`,
    ),
  );
  return rows[0]?.is_demo !== false;
}

// ---------------------------------------------------------------------------
// Koppla
// ---------------------------------------------------------------------------

export const FORTNOX_STATE_COOKIE = "bl_fortnox_state";
const STATE_TTL_MS = 10 * 60_000;

interface ConnectState {
  readonly state: string;
  readonly verifier: string;
  readonly organizationId: string;
  readonly userId: string;
  readonly expiresAt: number;
}

function sign(config: FortnoxConfig, payload: string): string {
  return createHmac("sha256", `binderlab-fortnox-state:${config.clientSecret}`)
    .update(payload)
    .digest("base64url");
}

function sealState(config: FortnoxConfig, value: ConnectState): string {
  const payload = Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
  return `${payload}.${sign(config, payload)}`;
}

function openState(config: FortnoxConfig, cookie: string | undefined): ConnectState | null {
  if (!cookie) return null;
  const [payload, mac] = cookie.split(".");
  if (!payload || !mac) return null;
  const expected = Buffer.from(sign(config, payload));
  const given = Buffer.from(mac);
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return null;
  try {
    const v = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as ConnectState;
    return typeof v.state === "string" && typeof v.verifier === "string" ? v : null;
  } catch {
    return null;
  }
}

/**
 * Början på kopplingen: adressen hos Fortnox dit ägaren skickas, och värdet för en
 * httpOnly-cookie som binder svaret till den här användaren och organisationen.
 */
export async function startFortnoxConnectFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<{ url: string; cookie: string; maxAgeSeconds: number }> {
  await operator(viewer);
  const problem = fortnoxConfigProblem();
  const config = fortnoxConfig();
  if (problem || !config) throw new FortnoxError(problem ?? "Fortnox är inte inställt.");
  if (await withUserDbFor(viewer.user, (tx) => isDemo(tx, viewer.organization.id))) {
    throw new FortnoxError("En demo kan inte kopplas till Fortnox.");
  }
  const state = randomBytes(24).toString("base64url");
  const verifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return {
    url: authorizeUrl(config, FORTNOX_SCOPES, state, challenge),
    cookie: sealState(config, {
      state,
      verifier,
      organizationId: viewer.organization.id,
      userId: viewer.user.userId,
      expiresAt: now.getTime() + STATE_TTL_MS,
    }),
    maxAgeSeconds: STATE_TTL_MS / 1000,
  };
}

export interface ConnectResult {
  readonly companyName: string | null;
  /** Sant när kopplingen fanns sedan förut (kopplad igen). */
  readonly reconnected: boolean;
}

/**
 * Slutet på kopplingen: Fortnox skickade tillbaka ägaren med en kod. Koden byts mot token
 * som sparas i Vault. En ny koppling börjar alltid i torrkörning.
 */
export async function finishFortnoxConnectFor(
  viewer: Viewer,
  input: { code: string | null; state: string | null; error: string | null; cookie?: string },
  options: { now?: Date; deps?: FortnoxDeps } = {},
): Promise<ConnectResult> {
  await operator(viewer);
  const config = fortnoxConfig();
  if (!config) throw new FortnoxError(fortnoxConfigProblem() ?? "Fortnox är inte inställt.");
  const now = options.now ?? new Date();
  if (input.error) {
    throw new FortnoxError("Kopplingen avbröts hos Fortnox. Inget är ändrat. Försök igen.");
  }
  const saved = openState(config, input.cookie);
  if (
    !saved ||
    !input.code ||
    !input.state ||
    saved.state !== input.state ||
    saved.expiresAt < now.getTime() ||
    saved.organizationId !== viewer.organization.id ||
    saved.userId !== viewer.user.userId
  ) {
    throw new FortnoxError(
      "Kopplingen tog för lång tid eller startades någon annanstans. Försök igen.",
    );
  }
  const orgId = viewer.organization.id;
  let tokens;
  try {
    tokens = await exchangeCode(config, input.code, saved.verifier, options.deps);
  } catch (error) {
    if (error instanceof FortnoxAuthError) {
      throw new FortnoxError(
        error.kind === "invalid_client"
          ? "Fortnox godtar inte appens Client-Id eller Client-Secret. Kontrollera dem på servern."
          : "Fortnox godtog inte kopplingen. Försök igen.",
      );
    }
    throw error;
  }
  // Vilket bolag blev det? (Visas för ägaren, och ett annat bolag än förut nekas.)
  let company: { name: string | null; tenant: string | null } = { name: null, tenant: null };
  try {
    company = await new FortnoxClient(
      config,
      async () => tokens.accessToken,
      options.deps,
      orgId,
    ).company();
  } catch (error) {
    if (!(error instanceof FortnoxApiError)) throw error;
  }
  const db = getServiceDb();
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`fortnox-token:${orgId}`}))`);
    if (await isDemo(tx, orgId)) throw new FortnoxError("En demo kan inte kopplas till Fortnox.");
    const existing = Array.from(
      await tx.execute<{ fortnox_tenant: string | null }>(sql`
        select fortnox_tenant from public.fortnox_connections
        where organization_id = ${orgId}::uuid for update`),
    )[0];
    const anySent = Array.from(
      await tx.execute<{ tenant: string | null }>(sql`
        select 1 as tenant from public.fortnox_vouchers
        where organization_id = ${orgId}::uuid and state in ('sent', 'sending') limit 1`),
    ).length;
    const before = existing?.fortnox_tenant ?? null;
    if (anySent > 0 && before && company.tenant && before !== company.tenant) {
      throw new FortnoxError(
        "Det här är ett annat bolag i Fortnox än det som verifikaten redan skickats till. Logga in i rätt bolag hos Fortnox och koppla igen.",
      );
    }
    await saveTokens(tx, orgId, tokens);
    await tx.execute(sql`
      insert into public.fortnox_connections
        (organization_id, status, fortnox_tenant, company_name, connected_at, connected_by, created_by)
      values (${orgId}::uuid, 'connected', ${company.tenant}, ${company.name},
              ${now.toISOString()}::timestamptz, ${viewer.user.userId}::uuid,
              ${viewer.user.userId}::uuid)
      on conflict (organization_id) do update set
        status = 'connected',
        fortnox_tenant = coalesce(excluded.fortnox_tenant, fortnox_connections.fortnox_tenant),
        company_name = coalesce(excluded.company_name, fortnox_connections.company_name),
        connected_at = excluded.connected_at,
        connected_by = excluded.connected_by`);
    return { companyName: company.name, reconnected: Boolean(existing) };
  });
}

/** Kopplar från: token raderas (och återkallas hos Fortnox om det går). Utkorgen står kvar. */
export async function disconnectFortnoxFor(
  viewer: Viewer,
  options: { deps?: FortnoxDeps } = {},
): Promise<void> {
  await operator(viewer);
  const orgId = viewer.organization.id;
  const db = getServiceDb();
  const tokens = await readTokens(db, orgId);
  const config = fortnoxConfig();
  if (tokens && config) {
    await safely(
      "återkalla Fortnox-token",
      () => revokeRefreshToken(config, tokens.refreshToken, options.deps),
      false,
    );
  }
  await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`fortnox-token:${orgId}`}))`);
    await clearTokens(tx, orgId);
    await tx.execute(
      sql`delete from public.fortnox_connections where organization_id = ${orgId}::uuid`,
    );
  });
  for (const key of ["fortnox:koppling", "fortnox:atgard"]) {
    await safely("stänga Fortnox-larm", () => resolveSystemAlert(db, orgId, key), 0);
  }
}

// ---------------------------------------------------------------------------
// Inställningar och läge
// ---------------------------------------------------------------------------

export const fortnoxSettingsSchema = z.object({
  startMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, "Välj en månad."),
  series: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{1,6}$/, "Serien är 1–6 bokstäver eller siffror."),
  mapping: mappingInputSchema,
});
export type FortnoxSettingsInput = z.input<typeof fortnoxSettingsSchema>;

async function connectionOrThrow(tx: Tx, orgId: string): Promise<FortnoxConnection> {
  const c = await readConnection(tx, orgId);
  if (!c) throw new FortnoxError("Fortnox är inte kopplat.");
  return c;
}

export async function saveFortnoxSettingsFor(
  viewer: Viewer,
  raw: FortnoxSettingsInput,
): Promise<void> {
  const input = fortnoxSettingsSchema.parse(raw);
  await operator(viewer);
  const orgId = viewer.organization.id;
  await withUserDbFor(viewer.user, async (tx) => {
    const current = await connectionOrThrow(tx, orgId);
    if (current.startMonth && current.startMonth !== input.startMonth) {
      const outbox = await readOutbox(tx, orgId);
      if (outbox.some((r) => r.state === "sent" || r.state === "sending")) {
        throw new FortnoxError(
          "Startmånaden kan inte ändras när verifikat redan har skickats till Fortnox.",
        );
      }
    }
    await tx.execute(sql`
      update public.fortnox_connections
      set start_month = ${`${input.startMonth}-01`}::date, voucher_series = ${input.series},
          mapping = ${JSON.stringify(input.mapping)}::jsonb
      where organization_id = ${orgId}::uuid`);
  });
}

/** Slår på skarpt läge (eller tillbaka till torrkörning). Inget skickas förrän jobbet kör. */
export async function setFortnoxLiveFor(viewer: Viewer, live: boolean): Promise<void> {
  if (typeof live !== "boolean") throw new FortnoxError("Ogiltigt val.");
  await operator(viewer);
  const orgId = viewer.organization.id;
  await withUserDbFor(viewer.user, async (tx) => {
    const current = await connectionOrThrow(tx, orgId);
    if (live) {
      if (current.status !== "connected") {
        throw new FortnoxError("Koppla Fortnox igen först.");
      }
      if (!current.startMonth) {
        throw new FortnoxError("Välj först från vilken månad Fortnox ska bokföras.");
      }
      if (!fortnoxConfig()) {
        throw new FortnoxError(fortnoxConfigProblem() ?? "Fortnox är inte inställt på servern.");
      }
    }
    await tx.execute(sql`
      update public.fortnox_connections set live = ${live}
      where organization_id = ${orgId}::uuid`);
  });
}

/** "Kör nu": samma körning som nattens jobb. */
export async function runFortnoxNowFor(
  viewer: Viewer,
  options: { now?: Date; deps?: FortnoxDeps } = {},
): Promise<FortnoxRunResult> {
  await operator(viewer);
  return runFortnoxFor(getServiceDb(), viewer.organization.id, options);
}

/** Ber om att ett skickat verifikat vänds (ett nytt verifikat med motsatta belopp). */
export async function requestFortnoxReversalFor(viewer: Viewer, voucherId: string): Promise<void> {
  if (!z.uuid().safeParse(voucherId).success) throw new FortnoxError("Verifikatet finns inte.");
  await operator(viewer);
  await withUserDbFor(viewer.user, async (tx) => {
    await tx.execute(
      sql`select public.fortnox_request_reversal(${viewer.organization.id}::uuid, ${voucherId}::uuid)`,
    );
  });
}

// ---------------------------------------------------------------------------
// Vyn
// ---------------------------------------------------------------------------

export type FortnoxTone = "ok" | "info" | "warn";

export interface FortnoxStatusLine {
  readonly tone: FortnoxTone;
  readonly text: string;
}

export interface FortnoxView {
  /** Varför servern inte kan prata med Fortnox (saknade miljövariabler), eller null. */
  readonly configProblem: string | null;
  readonly connection: (FortnoxConnection & { readonly companyName: string | null }) | null;
  readonly line: FortnoxStatusLine;
  /** Verifikat som skickas vid nästa körning (i torrkörning: som SKULLE skickas). */
  readonly next: readonly DesiredVoucher[];
  /** Verifikat som inte kan tas fram än, med orsaken. */
  readonly held: readonly DesiredVoucher[];
  /** Utkorgen, nyast verifikatdatum först. */
  readonly outbox: readonly OutboxRow[];
  /** Skickade verifikat vars underlag ändrats eller försvunnit sedan dess. */
  readonly changed: readonly { readonly row: OutboxRow; readonly reason: "changed" | "gone" }[];
  readonly lastRunAt: string | null;
  readonly lastError: string | null;
  /** Förslag på startmånad när ingen är vald. */
  readonly suggestedStartMonth: string;
}

function dayBefore(date: IsoDate): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const count = (n: number) => (n === 1 ? "1 verifikat" : `${n} verifikat`);

/** Raden ägaren ser. Ren funktion. */
export function fortnoxStatusLine(input: {
  readonly connection: Pick<FortnoxConnection, "status" | "live" | "startMonth"> | null;
  readonly configProblem: string | null;
  readonly diff: Pick<OutboxDiff, "insert" | "held" | "changed" | "orphaned">;
  readonly outbox: readonly Pick<OutboxRow, "state" | "blockCode" | "blockDetail">[];
  readonly lastOkOn: IsoDate | null;
  readonly today: IsoDate;
}): FortnoxStatusLine {
  const c = input.connection;
  if (!c) return { tone: "info", text: "Fortnox är inte kopplat." };
  if (c.status === "needs_reconnect") {
    return { tone: "warn", text: "Fortnox: kopplingen gäller inte längre. Koppla Fortnox igen." };
  }
  if (!c.startMonth) {
    return { tone: "info", text: "Fortnox är kopplat. Välj från vilken månad det ska bokföras." };
  }
  const toSend = input.diff.insert.length;
  if (!c.live) {
    return {
      tone: "info",
      text:
        toSend === 0
          ? "Fortnox: torrkörning. Inget att skicka just nu. Inget skickas förrän du slår på."
          : `Fortnox: torrkörning. ${count(toSend)} skulle skickas. Inget skickas förrän du slår på.`,
    };
  }
  if (input.configProblem) return { tone: "warn", text: `Fortnox: ${input.configProblem}` };
  const blocked = input.outbox.filter(
    (r) => r.state === "blocked" && r.blockCode && HUMAN_BLOCKS.includes(r.blockCode),
  );
  if (blocked.length > 0) {
    return {
      tone: "warn",
      text: `Fortnox: ${count(blocked.length)} är ${blocked.length === 1 ? "stoppat" : "stoppade"}. ${blocked[0]!.blockDetail ?? ""}`.trim(),
    };
  }
  const corrections = input.diff.changed.length + input.diff.orphaned.length;
  if (corrections > 0) {
    return {
      tone: "warn",
      text: `Fortnox: ${count(corrections)} har ändrats här efter att ${corrections === 1 ? "det" : "de"} bokfördes. Se listan och välj Rätta.`,
    };
  }
  const waiting =
    toSend + input.outbox.filter((r) => r.state === "pending" || r.state === "sending").length;
  if (waiting > 0) {
    return { tone: "info", text: `Fortnox: ${count(waiting)} väntar. Försöker igen i natt.` };
  }
  if (!input.lastOkOn) {
    return { tone: "ok", text: "Fortnox är på. Första körningen görs i natt." };
  }
  const through = dayBefore(input.lastOkOn);
  return {
    tone: "ok",
    text:
      input.lastOkOn === input.today
        ? "Fortnox: allt bokfört t.o.m. i går."
        : `Fortnox: allt bokfört t.o.m. ${through}.`,
  };
}

function suggestedStart(today: IsoDate, sentMonths: readonly string[]): string {
  const last = [...sentMonths].sort().at(-1);
  if (!last) return today.slice(0, 7);
  const [y, m] = last.split("-").map(Number) as [number, number];
  const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, "0")}`;
  return next;
}

/** Allt sidan visar. null = personen får inte se Fortnox (läsare, påfyllare, Enkel vy). */
export async function loadFortnoxFor(
  viewer: Viewer,
  now: Date = new Date(),
): Promise<FortnoxView | null> {
  if (!(await canManageFortnox(viewer))) return null;
  const org = viewer.organization;
  const today = businessToday(now, org.timezone);
  const configProblem = fortnoxConfigProblem();
  return withUserDbFor(viewer.user, async (tx) => {
    const connection = await readConnection(tx, org.id);
    const sentMonths = Array.from(
      await tx.execute<{ m: string }>(sql`
        select to_char(month, 'YYYY-MM') as m from public.bookkeeping_months
        where organization_id = ${org.id}::uuid and sent_at is not null`),
    ).map((r) => r.m);
    const suggestedStartMonth = suggestedStart(today, sentMonths);
    const empty = { insert: [], held: [], changed: [], orphaned: [] };
    if (!connection) {
      return {
        configProblem,
        connection: null,
        line: fortnoxStatusLine({
          connection: null,
          configProblem,
          diff: empty,
          outbox: [],
          lastOkOn: null,
          today,
        }),
        next: [],
        held: [],
        outbox: [],
        changed: [],
        lastRunAt: null,
        lastError: null,
        suggestedStartMonth,
      };
    }
    const [extra] = Array.from(
      await tx.execute<{ company_name: string | null }>(sql`
        select company_name from public.fortnox_connections
        where organization_id = ${org.id}::uuid`),
    );
    const [state] = Array.from(
      await tx.execute<{
        last_run_at: string | null;
        last_ok_at: string | null;
        last_error: string | null;
      }>(sql`
        select last_run_at::text as last_run_at, last_ok_at::text as last_ok_at, last_error
        from public.fortnox_sync_state where organization_id = ${org.id}::uuid`),
    );
    const outbox = await readOutbox(tx, org.id);
    const diff = diffOutbox(await computeDesired(tx, org, today, connection), outbox);
    return {
      configProblem,
      connection: { ...connection, companyName: extra?.company_name ?? null },
      line: fortnoxStatusLine({
        connection,
        configProblem,
        diff,
        outbox,
        lastOkOn: state?.last_ok_at
          ? businessToday(new Date(state.last_ok_at), org.timezone)
          : null,
        today,
      }),
      next: diff.insert.map((i) => i.voucher),
      held: diff.held,
      outbox: [...outbox].reverse(),
      changed: [
        ...diff.changed.map((c) => ({ row: c.row, reason: "changed" as const })),
        ...diff.orphaned.map((row) => ({ row, reason: "gone" as const })),
      ],
      lastRunAt: state?.last_run_at ? new Date(state.last_run_at).toISOString() : null,
      lastError: state?.last_error ?? null,
      suggestedStartMonth,
    };
  });
}

export type { FortnoxMapping };
