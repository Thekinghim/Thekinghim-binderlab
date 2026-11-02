/**
 * Data och ändringar för Inställningar, utan beroende på Next (användaren skickas in).
 * Testas mot testdatabasen i test/db/installningar-settings.test.ts; ../_actions/ kopplar
 * ihop dem med sessionen.
 *
 * Allt körs som användaren under RLS efter en rollkontroll mot databasen. Sidan är för
 * ägare och admin; ägarandelar skrivs bara av ägaren (RLS: owner_shares_insert). Summan
 * 10 000 bp kontrolleras av databasen vid commit (BL018) och varje ändring loggas i
 * audit_log av triggern private.audit().
 */

import "server-only";

import { sql } from "drizzle-orm";
import { z } from "zod";

import type { Tx } from "@/db/client";
import type { MemberRole } from "@/db/schema";
import { isIsoDate, type IsoDate } from "@/domain";
import {
  AuthorizationError,
  requireRoleFor,
  withUserDbFor,
  type SessionUser,
} from "@/server/access";
import type { ActionResult } from "@/server/auth/flows";
import { dbErrorMessage, pgErrorOf } from "@/server/errors";

import {
  AUDITED_TABLES,
  MAX_FEE_BP,
  MAX_VAT_BP,
  SETTINGS_MESSAGES,
  type LedgerAccountRow,
  type OwnerShareRow,
  type SettingsAuditEvent,
  type SettingsRow,
} from "./model";

const PAGE_ROLES = ["owner", "admin"] as const satisfies readonly MemberRole[];

export interface SettingsPageData {
  readonly role: MemberRole;
  /** null om organisationen ännu inte har någon rad (standardvärdena gäller då). */
  readonly settings: SettingsRow | null;
  readonly shares: OwnerShareRow[];
  readonly accounts: LedgerAccountRow[];
  readonly events: SettingsAuditEvent[];
  readonly actorNames: Record<string, string>;
  /** Medlemmar med visningsnamn (för att koppla en ägarandel till en användare). */
  readonly members: Array<{ userId: string; name: string }>;
}

function iso(value: unknown): string {
  return value instanceof Date ? value.toISOString() : new Date(String(value)).toISOString();
}

function json(value: unknown): Record<string, unknown> | null {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  if (typeof value === "string") {
    try {
      return json(JSON.parse(value));
    } catch {
      return null;
    }
  }
  return null;
}

async function querySettingsRow(tx: Tx, orgId: string): Promise<SettingsRow | null> {
  const r = Array.from(
    await tx.execute(
      sql`select id, vat_rate_bp, card_fee_bp, fiscal_year_start_month, updated_at
          from public.organization_settings where organization_id = ${orgId}::uuid`,
    ),
  )[0] as Record<string, unknown> | undefined;
  return r
    ? {
        id: String(r.id),
        vatRateBp: Number(r.vat_rate_bp),
        cardFeeBp: Number(r.card_fee_bp),
        fiscalYearStartMonth: Number(r.fiscal_year_start_month),
        updatedAt: iso(r.updated_at),
      }
    : null;
}

async function queryShares(tx: Tx, orgId: string): Promise<OwnerShareRow[]> {
  const result = await tx.execute(
    sql`select id, member_user_id, holder_name, share_bp, valid_from::text as valid_from
        from public.owner_shares where organization_id = ${orgId}::uuid
        order by valid_from desc, share_bp desc, holder_name`,
  );
  return (Array.from(result) as Record<string, unknown>[]).map((r) => ({
    id: String(r.id),
    memberUserId: typeof r.member_user_id === "string" ? r.member_user_id : null,
    holderName: String(r.holder_name),
    shareBp: Number(r.share_bp),
    validFrom: String(r.valid_from).slice(0, 10),
  }));
}

/** Allt sidan Inställningar visar. Ägare och admin; kastar AuthorizationError annars. */
export async function loadSettingsPageFor(
  user: SessionUser,
  organizationId: string,
): Promise<SettingsPageData> {
  const role = await requireRoleFor(user, organizationId, PAGE_ROLES);
  return withUserDbFor(user, async (tx) => {
    const [settings, shares, accountResult, auditResult, profileResult] = await Promise.all([
      querySettingsRow(tx, organizationId),
      queryShares(tx, organizationId),
      tx.execute(
        sql`select id, key, bas_account, name from public.ledger_accounts
            where organization_id = ${organizationId}::uuid order by bas_account, key`,
      ),
      tx.execute(
        sql`select a.id, a.table_name, a.row_id, a.action::text as action, a.actor_id,
                   a.occurred_at, a.before, a.after
            from public.audit_log a
            where a.organization_id = ${organizationId}::uuid
              and a.table_name in (${sql.join(
                AUDITED_TABLES.map((t) => sql`${t}`),
                sql`, `,
              )})
            order by a.occurred_at desc, a.id desc
            limit 200`,
      ),
      tx.execute(
        sql`select p.user_id, p.display_name,
                   exists (select 1 from public.memberships m
                           where m.organization_id = p.organization_id
                             and m.user_id = p.user_id) as is_member
            from public.profiles p
            where p.organization_id = ${organizationId}::uuid and p.anonymized_at is null
              and p.user_id is not null
            order by p.display_name`,
      ),
    ]);
    const actorNames: Record<string, string> = {};
    const members: Array<{ userId: string; name: string }> = [];
    for (const r of Array.from(profileResult) as Record<string, unknown>[]) {
      if (typeof r.user_id === "string" && typeof r.display_name === "string") {
        actorNames[r.user_id] = r.display_name;
        if (r.is_member === true) members.push({ userId: r.user_id, name: r.display_name });
      }
    }
    const events = (Array.from(auditResult) as Record<string, unknown>[]).flatMap(
      (r): SettingsAuditEvent[] => {
        const action = String(r.action);
        const table = String(r.table_name);
        if (action !== "insert" && action !== "update" && action !== "delete") return [];
        if (!(AUDITED_TABLES as readonly string[]).includes(table)) return [];
        return [
          {
            id: String(r.id),
            table: table as SettingsAuditEvent["table"],
            rowId: String(r.row_id),
            action,
            actorId: typeof r.actor_id === "string" ? r.actor_id : null,
            occurredAt: iso(r.occurred_at),
            before: json(r.before),
            after: json(r.after),
          },
        ];
      },
    );
    return {
      role,
      settings,
      shares,
      accounts: (Array.from(accountResult) as Record<string, unknown>[]).map((r) => ({
        id: String(r.id),
        key: String(r.key),
        basAccount: String(r.bas_account),
        name: String(r.name),
      })),
      events,
      actorNames,
      members,
    };
  });
}

async function authorize(
  user: SessionUser | null,
  organizationId: string,
  roles: readonly MemberRole[],
  forbidden: string,
): Promise<ActionResult | null> {
  if (!user) return { ok: false, error: "Du är inte inloggad." };
  try {
    await requireRoleFor(user, organizationId, roles);
    return null;
  } catch (error) {
    if (error instanceof AuthorizationError) return { ok: false, error: forbidden };
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Avgifter, moms och räkenskapsår
// ---------------------------------------------------------------------------

const settingsInput = z.object({
  organizationId: z.uuid(),
  cardFeeBp: z.number().int().min(0).max(MAX_FEE_BP),
  vatRateBp: z.number().int().min(0).max(MAX_VAT_BP),
  fiscalYearStartMonth: z.number().int().min(1).max(12),
});

export type SettingsInput = z.input<typeof settingsInput>;

/** Sparar kortavgift, momssats och räkenskapsårets första månad. Ägare och admin. */
export async function updateSettingsFor(
  user: SessionUser | null,
  raw: SettingsInput,
): Promise<ActionResult<{ changed: boolean }>> {
  const parsed = settingsInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: SETTINGS_MESSAGES.invalid };
  const input = parsed.data;
  const denied = await authorize(
    user,
    input.organizationId,
    PAGE_ROLES,
    SETTINGS_MESSAGES.forbidden,
  );
  if (denied) return denied;
  try {
    return await withUserDbFor(user as SessionUser, async (tx) => {
      const current = await querySettingsRow(tx, input.organizationId);
      if (
        current &&
        current.cardFeeBp === input.cardFeeBp &&
        current.vatRateBp === input.vatRateBp &&
        current.fiscalYearStartMonth === input.fiscalYearStartMonth
      ) {
        return { ok: true, data: { changed: false } };
      }
      if (current) {
        await tx.execute(
          sql`update public.organization_settings
              set card_fee_bp = ${input.cardFeeBp}, vat_rate_bp = ${input.vatRateBp},
                  fiscal_year_start_month = ${input.fiscalYearStartMonth}
              where organization_id = ${input.organizationId}::uuid`,
        );
      } else {
        await tx.execute(
          sql`insert into public.organization_settings
                (organization_id, card_fee_bp, vat_rate_bp, fiscal_year_start_month)
              values (${input.organizationId}::uuid, ${input.cardFeeBp}, ${input.vatRateBp},
                      ${input.fiscalYearStartMonth})`,
        );
      }
      return { ok: true, data: { changed: true } };
    });
  } catch (error) {
    if (pgErrorOf(error)?.code === "42501")
      return { ok: false, error: SETTINGS_MESSAGES.forbidden };
    return { ok: false, error: dbErrorMessage(error) };
  }
}

// ---------------------------------------------------------------------------
// Ägarandelar
// ---------------------------------------------------------------------------

const sharesInput = z.object({
  organizationId: z.uuid(),
  validFrom: z.string().refine(isIsoDate),
  shares: z
    .array(
      z.object({
        holderName: z.string().trim().min(1).max(200),
        shareBp: z.number().int().min(1).max(10_000),
        memberUserId: z.uuid().nullable().optional(),
      }),
    )
    .min(1)
    .max(20),
});

export type OwnerSharesInput = z.input<typeof sharesInput>;

/**
 * Lägger in en ny uppsättning ägarandelar som gäller från `validFrom`. Andelarna ska
 * summera till 100 % och namnen vara unika. Bara ägaren (RLS gör samma kontroll).
 */
export async function saveOwnerSharesFor(
  user: SessionUser | null,
  raw: OwnerSharesInput,
): Promise<ActionResult<{ validFrom: IsoDate }>> {
  const parsed = sharesInput.safeParse(raw);
  if (!parsed.success) return { ok: false, error: SETTINGS_MESSAGES.sharesInvalid };
  const input = parsed.data;
  const denied = await authorize(
    user,
    input.organizationId,
    ["owner"],
    SETTINGS_MESSAGES.ownerOnly,
  );
  if (denied) return denied;

  const sum = input.shares.reduce((n, s) => n + s.shareBp, 0);
  if (sum !== 10_000) return { ok: false, error: SETTINGS_MESSAGES.sharesSum(sum) };
  const names = input.shares.map((s) => s.holderName.toLocaleLowerCase("sv"));
  if (new Set(names).size !== names.length) {
    return { ok: false, error: SETTINGS_MESSAGES.sharesDuplicate };
  }

  try {
    return await withUserDbFor(user as SessionUser, async (tx) => {
      const existing = await queryShares(tx, input.organizationId);
      if (existing.some((s) => s.validFrom === input.validFrom)) {
        return { ok: false, error: SETTINGS_MESSAGES.sharesDateTaken };
      }
      const members = new Set(
        (
          Array.from(
            await tx.execute(
              sql`select user_id from public.memberships where organization_id = ${input.organizationId}::uuid`,
            ),
          ) as Record<string, unknown>[]
        ).map((r) => String(r.user_id)),
      );
      for (const s of input.shares) {
        const member = s.memberUserId && members.has(s.memberUserId) ? s.memberUserId : null;
        await tx.execute(
          sql`insert into public.owner_shares
                (organization_id, member_user_id, holder_name, share_bp, valid_from)
              values (${input.organizationId}::uuid, ${member}::uuid, ${s.holderName},
                      ${s.shareBp}, ${input.validFrom}::date)`,
        );
      }
      return { ok: true, data: { validFrom: input.validFrom } };
    });
  } catch (error) {
    const pg = pgErrorOf(error);
    if (pg?.code === "42501") return { ok: false, error: SETTINGS_MESSAGES.ownerOnly };
    if (pg?.code === "23505") return { ok: false, error: SETTINGS_MESSAGES.sharesDuplicate };
    return { ok: false, error: dbErrorMessage(error) };
  }
}
