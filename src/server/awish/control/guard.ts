/**
 * Skyddet runt VARJE skrivning till Awish via API:t. Stegen, i den här ordningen:
 *
 *  1. Rollen läses ur databasen (standard ägare och admin).
 *  2. En demo anropar aldrig Awish (raden sparas som 'blocked', ingen anslutning görs).
 *  3. AWISH_CONTROL_DISABLED=true stänger av all styrning.
 *  4. Samma bekräftelse (idempotency_key) skickas aldrig två gånger: det sparade utfallet ges.
 *  5. Gränser per automat och organisation (räknas ur awish_actions, utom 'blocked'). De
 *     räknas en gång till under ett lås per organisation, i samma transaktion som raden
 *     'pending' sparas, så att två bekräftelser samtidigt inte båda kommer förbi.
 *  6. Fungerar inte signeringen (sign_status 'failed') pausas alla skrivningar.
 *  7. Skrivningar som rör fack, påfyllning, strömschema, Mata ut och Stäng av kräver att ett
 *     byte av Awishs version har kvitterats (VERSION_GATED_KINDS). Omstart gör det inte: den
 *     behövs ibland just när något är fel, och den rör inga fack.
 *  8. Kräver åtgärden att automaten är online kontrolleras det först (Machine).
 *  9. En rad 'pending' sparas före anropet, 10. anropet görs, 11. utfallet sparas
 *     (ok, failed eller unknown), 12. ett svenskt meddelande ges.
 *
 * Mata ut (shipment) kräver alltid ett skäl (minst 5 tecken), en kvitterad version och att
 * automaten är online, oavsett vad anroparen anger.
 * Begäran som sparas rensas från sign, timestamp, hemligheter och personuppgifter.
 */

import "server-only";

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";

import { getServiceDb, type Db, type Tx } from "@/db/client";
import type { MemberRole, MembershipRole } from "@/db/schema";
import { AuthorizationError, requireRoleFor } from "@/server/access";
import { OPERATOR_ROLES } from "@/server/data/core/types";
import type { Viewer } from "@/server/data/core/loaders";
import { DEMO_MESSAGES, isDemoOrganization } from "@/server/demo/guard";

import { AwishApiError } from "../grpc-client";
import { AwishNotConnectedError } from "../marketing";
import { apiFor, awishMachineIdFor, controlContextFor, type ControlDeps } from "./connect";
import {
  AwishControlInputError,
  AwishUnknownOutcomeError,
  OFFLINE_MESSAGE,
  SIGN_FAILED_MESSAGE,
  controlErrorMessage,
  isSignError,
} from "./errors";
import { updateApiState } from "./state";
import type { AwishControlApi, AwishControlWriteResult } from "./types";

export type AwishActionKind =
  | "reboot"
  | "shutdown"
  | "power_schedule_set"
  | "power_schedule_clear"
  | "shipment"
  | "machine_config"
  | "slot_update"
  | "replenish"
  | "refill_push_api"
  | "good_create"
  | "good_update"
  | "good_delete"
  | "category_create"
  | "category_update"
  | "category_delete"
  | "products_batch"
  | "member_create"
  | "member_update"
  | "member_delete"
  | "merchant_update"
  | "banner_create"
  | "banner_update"
  | "banner_delete"
  | "pickup_code_create"
  | "sign_probe";

export interface ControlActionSpec {
  kind: AwishActionKind;
  machineId?: string | null;
  targetId?: string | null;
  /** Standard OPERATOR_ROLES (ägare, admin). */
  roles?: readonly MembershipRole[];
  /** reboot, shutdown, shipment. */
  physical?: boolean;
  /** shipment, shutdown (tvingas för dem). */
  requireAckedVersion?: boolean;
  requireOnline?: boolean;
  /** uuid från förhandsvisningen. */
  idempotencyKey: string;
  reason?: string | null;
  /** Begäran utan personuppgifter, sign och timestamp (rensas också här). */
  auditRequest: Record<string, unknown>;
  /** Meddelandet när det gick bra (standard "Klart. Awish tog emot det."). */
  successMessage?: string;
}

export type ControlActionFailure =
  | "forbidden"
  | "demo"
  | "disabled"
  | "not_connected"
  | "sign_failed"
  | "version_unacknowledged"
  | "offline"
  | "rate_limited"
  | "awish"
  | "unknown_outcome"
  | "invalid";

/**
 * Vid replayed=true (samma bekräftelse redan skickad) finns inget nytt värde: `value` är då
 * undefined och utfallet är det sparade.
 */
export type ControlActionResult<T> =
  | { ok: true; message: string; value: T; actionId: string; replayed: boolean }
  | { ok: false; message: string; actionId: string | null; kind: ControlActionFailure };

export interface AuditRow {
  id: string;
  kind: AwishActionKind;
  machineId: string | null;
  targetId: string | null;
  status: "pending" | "ok" | "failed" | "unknown" | "blocked";
  actorId: string | null;
  actorName: string | null;
  reason: string | null;
  awishMessage: string | null;
  createdAt: Date;
  finishedAt: Date | null;
}

export const PHYSICAL_KINDS: readonly AwishActionKind[] = ["reboot", "shutdown", "shipment"];

/**
 * Kräver kvitterad version: ett oannonserat byte av fältnumren kan göra att fack-id och
 * antal betyder något annat, och då ska inget skrivas till facken eller automaten.
 */
export const VERSION_GATED_KINDS: readonly AwishActionKind[] = [
  "shipment",
  "shutdown",
  "slot_update",
  "replenish",
  "products_batch",
  "refill_push_api",
  "power_schedule_set",
];

export const VERSION_UNACKNOWLEDGED_MESSAGE =
  "Awish bytte version. Kontrollera under Datakällor och tryck Jag har kontrollerat först.";

/** Har Awish bytt version utan att någon kvitterat? */
export function versionNeedsAck(state: {
  versionChangedAt: Date | null;
  versionAcknowledgedAt: Date | null;
}): boolean {
  const changed = state.versionChangedAt;
  const acked = state.versionAcknowledgedAt;
  return changed !== null && (acked === null || acked.getTime() < changed.getTime());
}

const CATALOG_KINDS: readonly AwishActionKind[] = [
  "good_create",
  "good_update",
  "good_delete",
  "category_create",
  "category_update",
  "category_delete",
  "products_batch",
  "member_create",
  "member_update",
  "member_delete",
  "merchant_update",
  "banner_create",
  "banner_update",
  "banner_delete",
  "pickup_code_create",
];

interface RateLimit {
  scope: "machine" | "org";
  /** Typerna som räknas tillsammans. */
  kinds: readonly AwishActionKind[];
  max: number;
  windowS: number;
  message: string;
}

const SLOT_KINDS: readonly AwishActionKind[] = ["slot_update", "replenish"];
const SCHEDULE_KINDS: readonly AwishActionKind[] = ["power_schedule_set", "power_schedule_clear"];

/** Gränserna per typ. */
export const RATE_LIMITS: Partial<Record<AwishActionKind, readonly RateLimit[]>> = {
  shipment: [
    {
      scope: "machine",
      kinds: ["shipment"],
      max: 1,
      windowS: 120,
      message: "Vänta två minuter mellan två utmatningar i samma automat.",
    },
    {
      scope: "org",
      kinds: ["shipment"],
      max: 5,
      windowS: 3600,
      message: "Högst 5 utmatningar i timmen.",
    },
    {
      scope: "org",
      kinds: ["shipment"],
      max: 10,
      windowS: 86_400,
      message: "Högst 10 utmatningar per dygn.",
    },
  ],
  shutdown: [
    {
      scope: "machine",
      kinds: ["shutdown"],
      max: 1,
      windowS: 1800,
      message: "Automaten stängdes av nyss. Vänta en halvtimme.",
    },
  ],
  reboot: [
    {
      scope: "machine",
      kinds: ["reboot"],
      max: 1,
      windowS: 600,
      message: "Automaten startades om nyss. Vänta tio minuter.",
    },
    {
      scope: "org",
      kinds: ["reboot"],
      max: 10,
      windowS: 3600,
      message: "Högst 10 omstarter i timmen.",
    },
  ],
  power_schedule_set: [
    {
      scope: "machine",
      kinds: SCHEDULE_KINDS,
      max: 10,
      windowS: 3600,
      message: "För många ändringar av schemat. Vänta en stund.",
    },
  ],
  power_schedule_clear: [
    {
      scope: "machine",
      kinds: SCHEDULE_KINDS,
      max: 10,
      windowS: 3600,
      message: "För många ändringar av schemat. Vänta en stund.",
    },
  ],
  machine_config: [
    {
      scope: "machine",
      kinds: ["machine_config"],
      max: 20,
      windowS: 3600,
      message: "För många ändringar av skärmen. Vänta en stund.",
    },
  ],
  slot_update: [
    {
      scope: "machine",
      kinds: SLOT_KINDS,
      max: 60,
      windowS: 3600,
      message: "För många ändringar i facken. Vänta en stund.",
    },
  ],
  replenish: [
    {
      scope: "machine",
      kinds: SLOT_KINDS,
      max: 60,
      windowS: 3600,
      message: "För många ändringar i facken. Vänta en stund.",
    },
  ],
  sign_probe: [
    {
      scope: "org",
      kinds: ["sign_probe"],
      max: 6,
      windowS: 3600,
      message: "Signeringen har testats många gånger. Vänta en timme.",
    },
  ],
  ...Object.fromEntries(
    CATALOG_KINDS.map((k) => [
      k,
      [
        {
          scope: "org" as const,
          kinds: CATALOG_KINDS,
          max: 60,
          windowS: 600,
          message: "För många ändringar i Awish på kort tid. Vänta några minuter.",
        },
      ],
    ]),
  ),
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Nyckel för en bekräftelse (förhandsvisningen ger den, bekräftelsen skickar tillbaka den). */
export function newIdempotencyKey(): string {
  return randomUUID();
}

/** Fält som aldrig sparas i loggen. */
const SECRET_KEYS = new Set([
  "sign",
  "timestamp",
  "token",
  "appid",
  "app_id",
  "appId",
  "app_secret",
  "appSecret",
  "app_key",
  "appKey",
  "config",
  "password",
  "tel",
  "email",
  "principal_balance",
  "principalBalance",
]);
/** För medlemmar sparas bara id och vilka fält som ändrades. */
const MEMBER_PII = new Set(["name", "remark", "member_no", "memberNo"]);

/** Begäran för loggen: utan sign, timestamp, hemligheter och personuppgifter. */
export function redactAuditRequest(
  kind: AwishActionKind,
  request: Record<string, unknown>,
): Record<string, unknown> {
  const member = kind.startsWith("member_");
  const walk = (value: unknown, depth: number): unknown => {
    if (depth > 6) return null;
    if (Array.isArray(value)) return value.slice(0, 200).map((v) => walk(v, depth + 1));
    if (value && typeof value === "object") {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (SECRET_KEYS.has(k)) continue;
        if (member && MEMBER_PII.has(k)) continue;
        out[k] = walk(v, depth + 1);
      }
      return out;
    }
    if (typeof value === "string") return value.slice(0, 500);
    return value;
  };
  return walk(request, 0) as Record<string, unknown>;
}

function clip(text: string | null | undefined, max = 300): string | null {
  if (!text) return null;
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

type Row = Record<string, unknown>;

async function query<T extends Row>(db: Db | Tx, q: ReturnType<typeof sql>): Promise<T[]> {
  return Array.from(await db.execute(q)) as T[];
}

function memberRolesOf(roles: readonly MembershipRole[]): MemberRole[] {
  return roles.filter((r): r is MemberRole => r !== "store" && r !== "machine_refiller");
}

interface Ctx {
  db: Db | Tx;
  orgId: string;
  actorId: string;
  actorRole: string | null;
  spec: ControlActionSpec;
  request: Record<string, unknown>;
  now: Date;
}

/** Sparar en rad som stoppades före anropet (status 'blocked'). Stoppar aldrig flödet. */
async function recordBlocked(ctx: Ctx, errorKind: ControlActionFailure, message: string) {
  try {
    const [row] = await query<{ id: string }>(
      ctx.db,
      sql`insert into public.awish_actions
            (organization_id, actor_id, actor_role, kind, machine_id, target_id, request, reason,
             idempotency_key, status, error_kind, awish_message, finished_at)
          values (${ctx.orgId}::uuid, ${ctx.actorId}::uuid, ${ctx.actorRole}, ${ctx.spec.kind},
                  ${ctx.spec.machineId ?? null}::uuid, ${clip(ctx.spec.targetId, 100)},
                  ${JSON.stringify(ctx.request)}::jsonb, ${clip(ctx.spec.reason, 500)},
                  ${`${ctx.spec.idempotencyKey}:b:${randomUUID().slice(0, 8)}`}, 'blocked',
                  ${errorKind}, ${clip(message)}, ${ctx.now.toISOString()}::timestamptz)
          returning id`,
    );
    return row?.id ?? null;
  } catch (error) {
    console.error(
      "[awish] kunde inte logga stoppad åtgärd",
      error instanceof Error ? error.name : "fel",
    );
    return null;
  }
}

async function rateLimited(ctx: Ctx): Promise<string | null> {
  for (const limit of RATE_LIMITS[ctx.spec.kind] ?? []) {
    if (limit.scope === "machine" && !ctx.spec.machineId) continue;
    const since = new Date(ctx.now.getTime() - limit.windowS * 1000).toISOString();
    const [row] = await query<{ n: number }>(
      ctx.db,
      sql`select count(*)::int as n from public.awish_actions
          where organization_id = ${ctx.orgId}::uuid
            and kind in (select jsonb_array_elements_text(${JSON.stringify(limit.kinds)}::jsonb))
            and status <> 'blocked'
            and created_at > ${since}::timestamptz
            ${limit.scope === "machine" ? sql`and machine_id = ${ctx.spec.machineId}::uuid` : sql``}`,
    );
    if ((row?.n ?? 0) >= limit.max) return limit.message;
  }
  return null;
}

function failure<T>(
  kind: ControlActionFailure,
  message: string,
  actionId: string | null = null,
): ControlActionResult<T> {
  return { ok: false, kind, message, actionId };
}

function isWriteResult(value: unknown): value is AwishControlWriteResult {
  return (
    !!value &&
    typeof value === "object" &&
    typeof (value as AwishControlWriteResult).code === "number" &&
    typeof (value as AwishControlWriteResult).message === "string"
  );
}

/** Kör en skrivning till Awish med alla skydd. Se filens kommentar för stegen. */
export async function runControlAction<T>(
  viewer: Viewer,
  spec: ControlActionSpec,
  fn: (api: AwishControlApi, ctx: { awishMachineId: string | null; db: Db }) => Promise<T>,
  deps: ControlDeps = {},
): Promise<ControlActionResult<T>> {
  const orgId = viewer.organization.id;
  // 1. Rollen ur databasen.
  let actorRole: string;
  try {
    const roles = memberRolesOf(spec.roles ?? OPERATOR_ROLES);
    if (roles.length === 0) throw new AuthorizationError("forbidden");
    actorRole = await requireRoleFor(viewer.user, orgId, roles);
  } catch (error) {
    if (error instanceof AuthorizationError) {
      return failure("forbidden", "Det här får bara ägare och admin göra.");
    }
    throw error;
  }

  const db = deps.db ?? getServiceDb();
  const now = deps.now?.() ?? new Date();
  const env = deps.env ?? process.env;
  const physical = spec.physical === true || PHYSICAL_KINDS.includes(spec.kind);
  const requireAckedVersion =
    spec.requireAckedVersion === true || VERSION_GATED_KINDS.includes(spec.kind);
  const requireOnline = spec.requireOnline === true || spec.kind === "shipment";
  const ctx: Ctx = {
    db,
    orgId,
    actorId: viewer.user.userId,
    actorRole,
    spec,
    request: redactAuditRequest(spec.kind, spec.auditRequest),
    now,
  };

  if (!UUID.test(spec.idempotencyKey)) {
    return failure("invalid", "Bekräftelsen är för gammal. Ladda om sidan och försök igen.");
  }
  if (spec.kind === "shipment" && (spec.reason ?? "").trim().length < 5) {
    return failure("invalid", "Skriv varför (minst 5 tecken).");
  }
  if (physical && !spec.machineId) return failure("invalid", "Välj en automat.");

  // 2. Demo: aldrig något anrop, aldrig någon anslutning.
  if (await isDemoOrganization(db, orgId)) {
    const id = await recordBlocked(ctx, "demo", DEMO_MESSAGES.integrations);
    return failure("demo", DEMO_MESSAGES.integrations, id);
  }

  // 3. Avstängt i miljön.
  if ((env.AWISH_CONTROL_DISABLED ?? "").trim().toLowerCase() === "true") {
    const message = "Styrning via Awish är avstängd.";
    return failure("disabled", message, await recordBlocked(ctx, "disabled", message));
  }

  // 4. Samma bekräftelse en gång.
  const [previous] = await query<{ id: string; status: string; awish_message: string | null }>(
    db,
    sql`select id, status, awish_message from public.awish_actions
        where organization_id = ${orgId}::uuid and idempotency_key = ${spec.idempotencyKey}`,
  );
  if (previous) {
    if (previous.status === "ok") {
      return {
        ok: true,
        message: "Det här är redan skickat.",
        value: undefined as T,
        actionId: previous.id,
        replayed: true,
      };
    }
    if (previous.status === "pending" || previous.status === "unknown") {
      return failure(
        "unknown_outcome",
        previous.status === "pending"
          ? "Det här skickas redan. Vänta en stund och titta i loggen."
          : "Det här skickades redan, men vi vet inte om Awish fick det. Titta på automaten.",
        previous.id,
      );
    }
    return failure(
      "awish",
      "Det här misslyckades redan. Gör en ny förhandsvisning för att försöka igen.",
      previous.id,
    );
  }

  // 5. Gränser.
  const limited = await rateLimited(ctx);
  if (limited)
    return failure("rate_limited", limited, await recordBlocked(ctx, "rate_limited", limited));

  // 6–8 behöver källan och läget.
  let context;
  try {
    context = await controlContextFor(db, orgId, deps);
  } catch (error) {
    if (error instanceof AwishNotConnectedError) return failure("not_connected", error.message);
    throw error;
  }
  if (context.state.signStatus === "failed" && spec.kind !== "sign_probe") {
    const message =
      "Awish godkänner inte vår signering ännu. Skrivningar via API är pausade; webbpanelen används.";
    return failure("sign_failed", message, await recordBlocked(ctx, "sign_failed", message));
  }
  if (requireAckedVersion) {
    if (versionNeedsAck(context.state)) {
      const message = VERSION_UNACKNOWLEDGED_MESSAGE;
      return failure(
        "version_unacknowledged",
        message,
        await recordBlocked(ctx, "version_unacknowledged", message),
      );
    }
  }
  if (context.endpoint === null) {
    return failure("awish", "Awish svarar inte just nu. Försök igen om en stund.");
  }

  let awishMachineId: string | null = null;
  if (spec.machineId) {
    awishMachineId = await awishMachineIdFor(db, orgId, spec.machineId);
    if (!awishMachineId) {
      return failure("not_connected", "Automaten är inte kopplad till Awish.");
    }
  }

  const api = apiFor(context);
  try {
    if (requireOnline && awishMachineId) {
      let online: boolean;
      try {
        online = (await api.machineDetail(awishMachineId)).isOnline;
      } catch (error) {
        return failure("awish", controlErrorMessage(error));
      }
      if (!online) {
        return failure(
          "offline",
          OFFLINE_MESSAGE,
          await recordBlocked(ctx, "offline", OFFLINE_MESSAGE),
        );
      }
    }

    // 9. Raden före anropet. Gränserna räknas en gång till under ett lås per organisation i
    // samma transaktion som raden sparas: två bekräftelser samtidigt (två flikar) kan annars
    // båda räkna 0 och båda skickas (t.ex. två utmatningar trots "1 per 2 minuter").
    const reserved = await db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`binderlab:awish-ctl:${orgId}`}, 0))`,
      );
      const again = await rateLimited({ ...ctx, db: tx });
      if (again) return { limited: again, pending: null };
      const [row] = await query<{ id: string }>(
        tx,
        sql`insert into public.awish_actions
              (organization_id, actor_id, actor_role, kind, machine_id, awish_machine_id,
               target_id, request, reason, idempotency_key, status)
            values (${orgId}::uuid, ${viewer.user.userId}::uuid, ${actorRole}, ${spec.kind},
                    ${spec.machineId ?? null}::uuid, ${awishMachineId},
                    ${clip(spec.targetId, 100)}, ${JSON.stringify(ctx.request)}::jsonb,
                    ${clip(spec.reason, 500)}, ${spec.idempotencyKey}, 'pending')
            on conflict (organization_id, idempotency_key) do nothing
            returning id`,
      );
      return { limited: null, pending: row ?? null };
    });
    if (reserved.limited !== null) {
      return failure(
        "rate_limited",
        reserved.limited,
        await recordBlocked(ctx, "rate_limited", reserved.limited),
      );
    }
    const pending = reserved.pending;
    if (!pending) {
      return failure(
        "unknown_outcome",
        "Det här skickas redan. Vänta en stund och titta i loggen.",
      );
    }

    // 10–11. Anropet och utfallet.
    const finish = async (patch: {
      status: "ok" | "failed" | "unknown";
      code?: number | null;
      message?: string | null;
      errorKind?: string | null;
      requestId?: string | null;
    }) => {
      await db.execute(
        sql`update public.awish_actions
            set status = ${patch.status}, awish_code = ${patch.code ?? null},
                awish_message = ${clip(patch.message)}, error_kind = ${patch.errorKind ?? null},
                request_id = ${clip(patch.requestId, 200)}, finished_at = now()
            where organization_id = ${orgId}::uuid and id = ${pending.id}::uuid`,
      );
    };
    try {
      const value = await fn(api, { awishMachineId, db });
      const result = isWriteResult(value) ? value : null;
      await finish({
        status: "ok",
        code: result?.code ?? null,
        message: result?.message ?? null,
        requestId: result?.requestId ?? null,
      });
      return {
        ok: true,
        message: spec.successMessage ?? "Klart. Awish tog emot det.",
        value,
        actionId: pending.id,
        replayed: false,
      };
    } catch (error) {
      if (error instanceof AwishUnknownOutcomeError) {
        await finish({ status: "unknown", message: error.technical, errorKind: "unknown_outcome" });
        return failure("unknown_outcome", error.message, pending.id);
      }
      if (error instanceof AwishControlInputError) {
        await finish({ status: "failed", message: error.message, errorKind: "invalid" });
        return failure("invalid", error.message, pending.id);
      }
      const kind = error instanceof AwishApiError ? error.kind : "unexpected";
      await finish({
        status: "failed",
        code: error instanceof AwishApiError ? error.grpcCode : null,
        message: error instanceof AwishApiError ? (error.technical ?? error.message) : null,
        errorKind: kind,
      });
      if (isSignError(error)) {
        // Signeringen nekades: pausa API-skrivningarna tills någon testar under Datakällor.
        // "Fel signatur" eller "ingen signatur" (fältnumren): texten säger vilket.
        const message = error instanceof AwishApiError ? error.message : SIGN_FAILED_MESSAGE;
        await updateApiState(db, orgId, context.sourceId, {
          signStatus: "failed",
          signCheckedAt: now,
          signError: message,
        }).catch(() => undefined);
        return failure("sign_failed", message, pending.id);
      }
      if (error instanceof AwishApiError) return failure("awish", error.message, pending.id);
      console.error("[awish] styrning", error instanceof Error ? error.name : "fel");
      return failure("awish", "Något gick fel mot Awish. Försök igen.", pending.id);
    }
  } finally {
    api.close();
  }
}

/** De senaste åtgärderna (ägare och admin). */
export async function recentActionsFor(
  viewer: Viewer,
  filter: { machineId?: string; kinds?: AwishActionKind[]; limit?: number },
  deps: Pick<ControlDeps, "db"> = {},
): Promise<AuditRow[]> {
  await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  const db = deps.db ?? getServiceDb();
  const limit = Math.min(Math.max(1, Math.floor(filter.limit ?? 20)), 200);
  const rows = await query<Row>(
    db,
    sql`select a.id, a.kind, a.machine_id, a.target_id, a.status, a.actor_id, p.display_name,
               a.reason, a.awish_message, a.created_at, a.finished_at
        from public.awish_actions a
        left join public.profiles p
          on p.organization_id = a.organization_id and p.user_id = a.actor_id
        where a.organization_id = ${viewer.organization.id}::uuid
          ${filter.machineId ? sql`and a.machine_id = ${filter.machineId}::uuid` : sql``}
          ${
            filter.kinds && filter.kinds.length > 0
              ? sql`and a.kind in (select jsonb_array_elements_text(${JSON.stringify(filter.kinds)}::jsonb))`
              : sql``
          }
        order by a.created_at desc
        limit ${limit}`,
  );
  return rows.map((r) => ({
    id: String(r.id),
    kind: r.kind as AwishActionKind,
    machineId: (r.machine_id as string | null) ?? null,
    targetId: (r.target_id as string | null) ?? null,
    status: r.status as AuditRow["status"],
    actorId: (r.actor_id as string | null) ?? null,
    actorName: (r.display_name as string | null) ?? null,
    reason: (r.reason as string | null) ?? null,
    awishMessage: (r.awish_message as string | null) ?? null,
    createdAt: new Date(String(r.created_at)),
    finishedAt: r.finished_at ? new Date(String(r.finished_at)) : null,
  }));
}
