/**
 * Jobbet som bokför i Fortnox. Körs av /api/cron/fortnox varje natt och av knappen
 * "Kör nu" (ägare/admin). Allt körs som systemrollen: organisationen kommer ur
 * fortnox_connections, aldrig ur en begäran.
 *
 * EXAKT EN GÅNG. Fortnox har ingen spärr mot dubbletter, så spärren är utkorgen
 * (public.fortnox_vouchers):
 *
 * 1. Varje verifikat har en stabil nyckel ("sales:2026-10:v1"), unik per organisation.
 *    Samma verifikat kan inte läggas i utkorgen två gånger.
 * 2. Innan ett verifikat skickas tas det i anspråk med en enda UPDATE (pending → sending).
 *    Två körningar samtidigt kan inte båda få raden.
 * 3. Svarar Fortnox med ett fel (4xx) gjordes inget: raden går tillbaka till väntande eller
 *    stoppas med orsaken. Kommer inget svar alls (nätverk, tidsgräns, 5xx) är det OVISST om
 *    verifikatet skapades: raden står kvar som "sending" och skickas aldrig igen förrän
 *    nästa körning har letat efter dess märke ([BL-…] i verifikatets text) bland dagens
 *    verifikat i Fortnox. Hittas det sparas numret; hittas det inte skickas det.
 * 4. Ett skickat verifikat ändras aldrig (triggern i databasen). En rättelse är ett nytt
 *    verifikat som vänder det gamla (public.fortnox_request_reversal).
 *
 * Inget skickas i torrkörning (fortnox_connections.live = false).
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Db, Tx } from "@/db/client";
import type { IsoDate } from "@/domain";
import { businessToday } from "@/server/data/core/loaders";
import { raiseAndNotify, safely } from "@/server/monitoring/failures";
import { resolveSystemAlert } from "@/server/monitoring/system-alerts";

import {
  FortnoxApiError,
  FortnoxAuthError,
  FortnoxClient,
  type FortnoxDeps,
  type FortnoxFinancialYear,
} from "./client";
import { fortnoxConfig, type FortnoxConfig } from "./config";
import type { FortnoxVoucherKind } from "./mapping";
import { computeDesired, readConnection, type DesiredPlan, type FortnoxConnection } from "./plan";
import { tokenSource } from "./tokens";
import {
  idemKey,
  voucherFingerprint,
  voucherMarker,
  type DesiredVoucher,
  type VoucherRow,
} from "./vouchers";

/** Ett anspråk äldre än så här räknas som ett tappat svar och letas upp i Fortnox. */
export const STALE_CLAIM_MS = 10 * 60_000;

export type BlockCode =
  | "locked_period"
  | "no_financial_year"
  | "unknown_account"
  | "unknown_series"
  | "forbidden"
  | "rejected"
  /** Källan försvann innan verifikatet hann skickas (t.ex. utbetalningen arkiverades). */
  | "withdrawn";

/** Stopp som en människa måste lösa (allt utom `withdrawn`). */
export const HUMAN_BLOCKS: readonly BlockCode[] = [
  "locked_period",
  "no_financial_year",
  "unknown_account",
  "unknown_series",
  "forbidden",
  "rejected",
];

export interface OutboxRow {
  readonly id: string;
  readonly idemKey: string;
  readonly kind: FortnoxVoucherKind;
  readonly sourceRef: string;
  readonly version: number;
  readonly date: IsoDate;
  readonly description: string;
  readonly rows: readonly VoucherRow[];
  readonly fingerprint: string;
  readonly state: "pending" | "sending" | "sent" | "blocked";
  readonly blockCode: BlockCode | null;
  readonly blockDetail: string | null;
  readonly attempts: number;
  readonly claimedAt: string | null;
  readonly attemptSeries: string | null;
  readonly attemptYear: number | null;
  readonly sentAt: string | null;
  readonly series: string | null;
  readonly number: number | null;
  readonly year: number | null;
  readonly reversesId: string | null;
}

interface RawRow extends Record<string, unknown> {
  id: string;
  idem_key: string;
  kind: FortnoxVoucherKind;
  source_ref: string;
  version: number;
  voucher_date: string;
  description: string;
  rows: unknown;
  fingerprint: string;
  state: OutboxRow["state"];
  block_code: string | null;
  block_detail: string | null;
  attempts: number;
  claimed_at: string | null;
  attempt_series: string | null;
  attempt_year: number | null;
  sent_at: string | null;
  fortnox_series: string | null;
  fortnox_number: number | null;
  fortnox_year: number | null;
  reverses_id: string | null;
}

const COLUMNS = sql`id::text as id, idem_key, kind, source_ref, version,
  voucher_date::text as voucher_date, description, rows, fingerprint, state, block_code,
  block_detail, attempts, claimed_at::text as claimed_at, attempt_series, attempt_year,
  sent_at::text as sent_at, fortnox_series, fortnox_number, fortnox_year,
  reverses_id::text as reverses_id`;

function toRow(r: RawRow): OutboxRow {
  const rows = (Array.isArray(r.rows) ? r.rows : []) as Record<string, unknown>[];
  return {
    id: r.id,
    idemKey: r.idem_key,
    kind: r.kind,
    sourceRef: r.source_ref,
    version: r.version,
    date: r.voucher_date,
    description: r.description,
    rows: rows.map((x) => ({
      account: String(x.account),
      amountOre: Number(x.amountOre),
      text: typeof x.text === "string" ? x.text : "",
    })),
    fingerprint: r.fingerprint,
    state: r.state,
    blockCode: r.block_code as BlockCode | null,
    blockDetail: r.block_detail,
    attempts: r.attempts,
    claimedAt: r.claimed_at ? new Date(r.claimed_at).toISOString() : null,
    attemptSeries: r.attempt_series,
    attemptYear: r.attempt_year,
    sentAt: r.sent_at ? new Date(r.sent_at).toISOString() : null,
    series: r.fortnox_series,
    number: r.fortnox_number,
    year: r.fortnox_year,
    reversesId: r.reverses_id,
  };
}

/** Utkorgen för organisationen, äldst verifikatdatum först. */
export async function readOutbox(tx: Db | Tx, orgId: string): Promise<OutboxRow[]> {
  const rows = Array.from(
    await tx.execute<RawRow>(sql`
      select ${COLUMNS} from public.fortnox_vouchers
      where organization_id = ${orgId}::uuid
      order by voucher_date, created_at, id`),
  );
  return rows.map(toRow);
}

// ---------------------------------------------------------------------------
// Jämförelsen mellan det som ska finnas och utkorgen
// ---------------------------------------------------------------------------

export interface OutboxDiff {
  /** Nya verifikat att lägga i utkorgen (nyckel och version klara). */
  readonly insert: readonly { key: string; version: number; voucher: DesiredVoucher }[];
  /** Väntande rader vars innehåll ändrats: uppdateras på plats (de är inte i Fortnox än). */
  readonly update: readonly { id: string; voucher: DesiredVoucher }[];
  /** Väntande rader vars källa försvunnit. */
  readonly withdraw: readonly string[];
  /** Skickade verifikat vars underlag ändrats sedan dess (rättas bara på ägarens begäran). */
  readonly changed: readonly { row: OutboxRow; voucher: DesiredVoucher }[];
  /** Skickade verifikat vars källa inte finns kvar. */
  readonly orphaned: readonly OutboxRow[];
  /** Verifikat som inte kan byggas än, med orsaken. */
  readonly held: readonly DesiredVoucher[];
}

/** Ren jämförelse (ingen databas): vad som ska göras med utkorgen. */
export function diffOutbox(plan: DesiredPlan, outbox: readonly OutboxRow[]): OutboxDiff {
  const reversedIds = new Map<string, OutboxRow>();
  for (const r of outbox) if (r.reversesId) reversedIds.set(r.reversesId, r);
  // Senaste versionen per källa (vändningar är egna rader och räknas inte).
  const latest = new Map<string, OutboxRow>();
  for (const r of outbox) {
    if (r.reversesId) continue;
    const k = `${r.kind}:${r.sourceRef}`;
    const cur = latest.get(k);
    if (!cur || r.version > cur.version) latest.set(k, r);
  }
  const insert: OutboxDiff["insert"][number][] = [];
  const update: OutboxDiff["update"][number][] = [];
  const changed: OutboxDiff["changed"][number][] = [];
  const held: DesiredVoucher[] = [];
  const wanted = new Set<string>();
  for (const v of plan.vouchers) {
    const k = `${v.kind}:${v.sourceRef}`;
    wanted.add(k);
    const row = latest.get(k) ?? null;
    if (v.hold) {
      // Inget att skicka än. Ett redan skickat verifikat står kvar som det är.
      if (plan.enabled[v.kind] && (!row || row.state !== "sent")) held.push(v);
      continue;
    }
    const fingerprint = voucherFingerprint(v);
    if (!row) {
      if (plan.enabled[v.kind])
        insert.push({ key: idemKey(v.kind, v.sourceRef, 1), version: 1, voucher: v });
      continue;
    }
    const reversal = reversedIds.get(row.id) ?? null;
    if (reversal) {
      // Vänt: en ny version läggs upp först när vändningen är bokförd i Fortnox.
      if (reversal.state === "sent" && plan.enabled[v.kind]) {
        const version = row.version + 1;
        insert.push({ key: idemKey(v.kind, v.sourceRef, version), version, voucher: v });
      }
      continue;
    }
    if (row.state === "sent") {
      if (row.fingerprint !== fingerprint) changed.push({ row, voucher: v });
      continue;
    }
    if (row.state === "sending") continue;
    if (row.fingerprint !== fingerprint || row.blockCode === "withdrawn") {
      update.push({ id: row.id, voucher: v });
    }
  }
  const withdraw: string[] = [];
  const orphaned: OutboxRow[] = [];
  for (const [k, row] of latest) {
    if (wanted.has(k) || reversedIds.has(row.id)) continue;
    if (row.state === "sent") orphaned.push(row);
    else if (row.state !== "sending" && row.blockCode !== "withdrawn") withdraw.push(row.id);
  }
  return { insert, update, withdraw, changed, orphaned, held };
}

async function applyDiff(tx: Tx, orgId: string, diff: OutboxDiff): Promise<void> {
  for (const { key, version, voucher } of diff.insert) {
    await tx.execute(sql`
      insert into public.fortnox_vouchers
        (organization_id, idem_key, kind, source_ref, version, voucher_date, description, rows,
         fingerprint)
      values (${orgId}::uuid, ${key}, ${voucher.kind}, ${voucher.sourceRef}, ${version},
              ${voucher.date}::date, ${voucher.description}, ${JSON.stringify(voucher.rows)}::jsonb,
              ${voucherFingerprint(voucher)})
      on conflict (organization_id, idem_key) do nothing`);
  }
  for (const { id, voucher } of diff.update) {
    await tx.execute(sql`
      update public.fortnox_vouchers
      set voucher_date = ${voucher.date}::date, description = ${voucher.description},
          rows = ${JSON.stringify(voucher.rows)}::jsonb, fingerprint = ${voucherFingerprint(voucher)},
          state = 'pending', block_code = null, block_detail = null
      where organization_id = ${orgId}::uuid and id = ${id}::uuid
        and state in ('pending', 'blocked')`);
  }
  for (const id of diff.withdraw) {
    await tx.execute(sql`
      update public.fortnox_vouchers
      set state = 'blocked', block_code = 'withdrawn',
          block_detail = 'Underlaget finns inte kvar. Verifikatet skickas inte.'
      where organization_id = ${orgId}::uuid and id = ${id}::uuid
        and state in ('pending', 'blocked')`);
  }
}

// ---------------------------------------------------------------------------
// Körningen
// ---------------------------------------------------------------------------

export interface FortnoxRunResult {
  readonly organizationId: string;
  readonly status:
    "not_connected" | "not_configured" | "needs_reconnect" | "dry_run" | "ran" | "error";
  readonly sent: number;
  /** Väntar till nästa körning (inkl. ovissa). */
  readonly waiting: number;
  /** Stoppade tills en människa gjort något. */
  readonly blocked: number;
  /** Hittade i Fortnox efter ett tappat svar. */
  readonly recovered: number;
  /** Skulle skickas (torrkörning). */
  readonly wouldSend: number;
  readonly error: string | null;
}

export interface FortnoxRunOptions {
  readonly now?: Date;
  readonly deps?: FortnoxDeps;
  readonly config?: FortnoxConfig | null;
  /** Hur gammalt ett anspråk ska vara innan det letas upp i Fortnox (test). */
  readonly staleClaimMs?: number;
}

const BLOCK_TEXT: Record<
  Exclude<BlockCode, "withdrawn" | "rejected">,
  (v: OutboxRow, x: string) => string
> = {
  locked_period: (v, until) =>
    `Perioden är låst i Fortnox till och med ${until}. Verifikatet är daterat ${v.date}. Lås upp perioden i Fortnox, eller bokför det för hand.`,
  no_financial_year: (v) =>
    `Fortnox har inget räkenskapsår för ${v.date}. Lägg upp året i Fortnox.`,
  unknown_account: (_v, account) =>
    `Konto ${account} finns inte (eller är inaktivt) i Fortnox. Lägg upp kontot i Fortnox, eller byt konto under Datakällor → Fortnox.`,
  unknown_series: (_v, series) =>
    `Verifikationsserien ${series} finns inte i Fortnox. Byt serie under Datakällor → Fortnox.`,
  forbidden: () =>
    "Fortnox släpper inte in appen: rättigheten eller licensen för bokföring saknas. Kontrollera i Fortnox att integrationen får bokföra.",
};

function clip(text: string, max = 480): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
}

class Run {
  private readonly years = new Map<string, FortnoxFinancialYear | null>();
  private readonly accounts = new Map<string, "ok" | "inactive" | "missing">();
  private readonly seriesByYear = new Map<number, Set<string>>();
  private locked: string | null | undefined;
  sent = 0;
  recovered = 0;

  constructor(
    private readonly db: Db,
    private readonly orgId: string,
    private readonly connection: FortnoxConnection,
    private readonly client: FortnoxClient,
    private readonly nowMs: number,
    private readonly staleMs: number,
  ) {}

  private async year(date: string): Promise<FortnoxFinancialYear | null> {
    for (const y of this.years.values()) if (y && y.from <= date && date <= y.to) return y;
    if (this.years.has(date)) return null;
    const y = await this.client.financialYearFor(date);
    this.years.set(date, y);
    return y;
  }

  private async lockedUntil(): Promise<string | null> {
    if (this.locked === undefined) this.locked = await this.client.lockedUntil();
    return this.locked;
  }

  private async block(row: OutboxRow, code: BlockCode, detail: string): Promise<void> {
    await this.db.execute(sql`
      update public.fortnox_vouchers
      set state = 'blocked', block_code = ${code}, block_detail = ${clip(detail)}
      where organization_id = ${this.orgId}::uuid and id = ${row.id}::uuid
        and state in ('pending', 'blocked', 'sending')`);
  }

  private async release(row: OutboxRow): Promise<void> {
    await this.db.execute(sql`
      update public.fortnox_vouchers set state = 'pending', block_code = null, block_detail = null
      where organization_id = ${this.orgId}::uuid and id = ${row.id}::uuid and state = 'sending'`);
  }

  private async markSent(
    row: OutboxRow,
    ref: { series: string; number: number; year: number },
  ): Promise<void> {
    await this.db.execute(sql`
      update public.fortnox_vouchers
      set state = 'sent', sent_at = now(), fortnox_series = ${ref.series},
          fortnox_number = ${ref.number}, fortnox_year = ${ref.year},
          block_code = null, block_detail = null
      where organization_id = ${this.orgId}::uuid and id = ${row.id}::uuid and state = 'sending'`);
  }

  /**
   * Ett anspråk utan svar: leta efter verifikatets märke i Fortnox. true = raden är klar
   * (hittad och sparad) eller ska lämnas; false = den fanns inte och får skickas.
   */
  private async recover(row: OutboxRow): Promise<boolean> {
    const age = row.claimedAt ? this.nowMs - new Date(row.claimedAt).getTime() : Infinity;
    // Ett färskt anspråk kan vara en annan körning som håller på just nu: rör det inte.
    if (age < this.staleMs) return true;
    if (!row.attemptSeries || !row.attemptYear) return true;
    const marker = voucherMarker(this.orgId, row.idemKey);
    const listed = await this.client.listVouchers(
      row.attemptSeries,
      row.attemptYear,
      row.date,
      row.date,
    );
    const hits = listed.filter((v) => v.description.includes(marker));
    if (hits.length > 0) {
      const first = hits.sort((a, b) => a.number - b.number)[0]!;
      await this.markSent(row, first);
      this.recovered += 1;
      return true;
    }
    await this.release(row);
    return false;
  }

  /** Skickar en rad. Ger false när körningen ska avbrytas (Fortnox nås inte just nu). */
  async send(row: OutboxRow): Promise<boolean> {
    if (row.state === "sending" && (await this.recover(row))) return true;

    const year = await this.year(row.date);
    if (!year) {
      await this.block(row, "no_financial_year", BLOCK_TEXT.no_financial_year(row, ""));
      return true;
    }
    const locked = await this.lockedUntil();
    if (locked && row.date <= locked) {
      await this.block(row, "locked_period", BLOCK_TEXT.locked_period(row, locked));
      return true;
    }
    const series = this.connection.series;
    let known = this.seriesByYear.get(year.id);
    if (!known) {
      known = new Set(await this.client.voucherSeries(year.id));
      this.seriesByYear.set(year.id, known);
    }
    if (!known.has(series)) {
      await this.block(row, "unknown_series", BLOCK_TEXT.unknown_series(row, series));
      return true;
    }
    for (const account of new Set(row.rows.map((r) => r.account))) {
      const key = `${year.id}:${account}`;
      let state = this.accounts.get(key);
      if (!state) {
        state = await this.client.accountState(account, year.id);
        this.accounts.set(key, state);
      }
      if (state !== "ok") {
        await this.block(row, "unknown_account", BLOCK_TEXT.unknown_account(row, account));
        return true;
      }
    }

    // Anspråket: bara en körning får raden. Innehållet låses till det vi just läste.
    const claimed = Array.from(
      await this.db.execute<{ id: string }>(sql`
        update public.fortnox_vouchers
        set state = 'sending', claimed_at = now(), attempts = attempts + 1,
            attempt_series = ${series}, attempt_year = ${year.id},
            block_code = null, block_detail = null
        where organization_id = ${this.orgId}::uuid and id = ${row.id}::uuid
          and state in ('pending', 'blocked')
          and fingerprint = ${row.fingerprint}
        returning id::text as id`),
    );
    if (claimed.length === 0) return true;

    const marker = voucherMarker(this.orgId, row.idemKey);
    try {
      const ref = await this.client.createVoucher(
        {
          series,
          date: row.date,
          description: `${row.description.slice(0, 200 - marker.length - 1)} ${marker}`,
          rows: row.rows,
        },
        year.id,
      );
      await this.markSent(row, ref);
      this.sent += 1;
      return true;
    } catch (error) {
      if (error instanceof FortnoxAuthError) {
        // Token gick inte att få: verifikatet lämnade aldrig servern.
        await this.release(row);
        throw error;
      }
      if (!(error instanceof FortnoxApiError)) {
        // Vårt eget fel innan anropet (t.ex. obalans): inget skickades.
        await this.block(row, "rejected", error instanceof Error ? error.message : "Okänt fel.");
        return true;
      }
      if (!error.definite) {
        // OVISST: raden står kvar som "sending" och letas upp vid nästa körning.
        return false;
      }
      switch (error.kind) {
        case "locked_period":
          this.locked = undefined;
          await this.block(
            row,
            "locked_period",
            BLOCK_TEXT.locked_period(row, (await this.lockedUntil().catch(() => null)) ?? row.date),
          );
          return true;
        case "no_financial_year":
          await this.block(row, "no_financial_year", BLOCK_TEXT.no_financial_year(row, ""));
          return true;
        case "unknown_account":
          await this.block(
            row,
            "unknown_account",
            `Fortnox tog inte emot ett av kontona (${[...new Set(row.rows.map((r) => r.account))].join(", ")}): ${error.message}`,
          );
          return true;
        case "unknown_series":
          await this.block(row, "unknown_series", BLOCK_TEXT.unknown_series(row, series));
          return true;
        case "forbidden":
          await this.block(row, "forbidden", BLOCK_TEXT.forbidden(row, ""));
          return false;
        case "rate_limited":
        case "unauthorized":
          await this.release(row);
          return false;
        default:
          await this.block(row, "rejected", `Fortnox tog inte emot verifikatet: ${error.message}`);
          return true;
      }
    }
  }
}

async function orgRef(db: Db | Tx, orgId: string) {
  const rows = Array.from(
    await db.execute<{ id: string; name: string; timezone: string; is_demo: boolean }>(sql`
      select id::text as id, name, timezone, is_demo from public.organizations
      where id = ${orgId}::uuid`),
  );
  return rows[0] ?? null;
}

const KIND_ALERT_KEY = "fortnox:atgard";
const RECONNECT_ALERT_KEY = "fortnox:koppling";

async function syncAlerts(
  db: Db,
  orgId: string,
  outbox: readonly OutboxRow[],
  needsReconnect: boolean,
  now: Date,
): Promise<void> {
  if (needsReconnect) {
    await safely(
      "Fortnox-larm (koppling)",
      () =>
        raiseAndNotify(db, {
          organizationId: orgId,
          kind: "job_failed",
          key: RECONNECT_ALERT_KEY,
          severity: "critical",
          title: "Fortnox behöver kopplas igen",
          detail:
            "Fortnox godtar inte längre kopplingen, så inget bokförs. Öppna Datakällor → Fortnox och tryck Koppla Fortnox. Inget bokförs dubbelt när du kopplar igen.",
          rule: "Fortnox svarade att kopplingen inte gäller längre.",
          link: "/datakallor/fortnox",
          now,
        }),
      null,
    );
  } else {
    await safely(
      "stänga Fortnox-larm (koppling)",
      () => resolveSystemAlert(db, orgId, RECONNECT_ALERT_KEY, now),
      0,
    );
  }
  const blocked = outbox.filter(
    (r) => r.state === "blocked" && r.blockCode && HUMAN_BLOCKS.includes(r.blockCode),
  );
  if (blocked.length > 0) {
    const first = blocked[0]!;
    await safely(
      "Fortnox-larm (stoppat)",
      () =>
        raiseAndNotify(db, {
          organizationId: orgId,
          kind: "job_failed",
          key: KIND_ALERT_KEY,
          severity: "warning",
          title:
            blocked.length === 1
              ? "Fortnox: 1 verifikat är stoppat"
              : `Fortnox: ${blocked.length} verifikat är stoppade`,
          detail: first.blockDetail ?? "Öppna Ekonomi → Bokföring för att se varför.",
          rule: "Ett verifikat kunde inte bokföras i Fortnox och kräver en åtgärd.",
          link: "/datakallor/fortnox",
          figures: [{ key: "blocked", label: "Stoppade verifikat", value: blocked.length }],
          now,
        }),
      null,
    );
  } else {
    await safely(
      "stänga Fortnox-larm (stoppat)",
      () => resolveSystemAlert(db, orgId, KIND_ALERT_KEY, now),
      0,
    );
  }
}

async function saveState(db: Db, orgId: string, now: Date, error: string | null): Promise<void> {
  const at = now.toISOString();
  await db.execute(sql`
    insert into public.fortnox_sync_state (organization_id, last_run_at, last_ok_at, last_error, updated_at)
    values (${orgId}::uuid, ${at}::timestamptz, ${error === null ? at : null}::timestamptz,
            ${error === null ? null : clip(error)}, ${at}::timestamptz)
    on conflict (organization_id) do update set
      last_run_at = excluded.last_run_at,
      last_ok_at = coalesce(excluded.last_ok_at, fortnox_sync_state.last_ok_at),
      last_error = excluded.last_error,
      updated_at = excluded.updated_at`);
}

const EMPTY = { sent: 0, waiting: 0, blocked: 0, recovered: 0, wouldSend: 0, error: null };

/** En körning för en organisation. Kastar aldrig för fel hos Fortnox: de står i resultatet. */
export async function runFortnoxFor(
  db: Db,
  orgId: string,
  options: FortnoxRunOptions = {},
): Promise<FortnoxRunResult> {
  const now = options.now ?? new Date();
  const base = { organizationId: orgId, ...EMPTY };
  const [org, connection] = await Promise.all([orgRef(db, orgId), readConnection(db, orgId)]);
  if (!org || !connection || org.is_demo) return { ...base, status: "not_connected" };
  const today = businessToday(now, org.timezone);

  // 1. Vad ska finnas, och vad säger utkorgen? Under ett lås, så att två körningar inte
  //    planerar samtidigt (nyckeln skyddar ändå mot dubbletter).
  const diff = await db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`fortnox-plan:${orgId}`}))`);
    const desired = await computeDesired(tx, org, today, connection);
    const d = diffOutbox(desired, await readOutbox(tx, orgId));
    if (connection.live) await applyDiff(tx, orgId, d);
    return d;
  });
  if (!connection.live) {
    return { ...base, status: "dry_run", wouldSend: diff.insert.length };
  }
  if (connection.status === "needs_reconnect") {
    await syncAlerts(db, orgId, await readOutbox(db, orgId), true, now);
    await saveState(db, orgId, now, "Fortnox behöver kopplas igen.");
    return { ...base, status: "needs_reconnect", error: "Fortnox behöver kopplas igen." };
  }
  const config = options.config === undefined ? fortnoxConfig() : options.config;
  if (!config) {
    await saveState(db, orgId, now, "Fortnox är inte inställt på servern.");
    return { ...base, status: "not_configured", error: "Fortnox är inte inställt på servern." };
  }

  // 2. Skicka, äldst först. Vändningar och deras nya versioner följer datumordningen.
  const client = new FortnoxClient(
    config,
    tokenSource(db, orgId, config, options.deps),
    options.deps,
    orgId,
  );
  const run = new Run(
    db,
    orgId,
    connection,
    client,
    // Anspråkets ålder mäts mot den riktiga klockan (claimed_at sätts av databasen).
    Date.now(),
    options.staleClaimMs ?? STALE_CLAIM_MS,
  );
  let error: string | null = null;
  let needsReconnect = false;
  const queue = (await readOutbox(db, orgId)).filter(
    (r) =>
      r.state === "pending" ||
      r.state === "sending" ||
      (r.state === "blocked" && r.blockCode !== "withdrawn"),
  );
  try {
    for (const row of queue) {
      if (!(await run.send(row))) {
        error = "Fortnox svarade inte som väntat. Försöker igen i natt.";
        break;
      }
    }
  } catch (e) {
    if (e instanceof FortnoxAuthError && e.kind === "invalid_grant") {
      needsReconnect = true;
      error = "Fortnox behöver kopplas igen.";
    } else if (e instanceof FortnoxAuthError || e instanceof FortnoxApiError) {
      error =
        e instanceof FortnoxApiError && e.kind === "forbidden"
          ? BLOCK_TEXT.forbidden(queue[0]!, "")
          : `Fortnox nåddes inte: ${e.message} Försöker igen i natt.`;
    } else {
      throw e;
    }
  }

  const after = await readOutbox(db, orgId);
  await syncAlerts(db, orgId, after, needsReconnect, now);
  await saveState(db, orgId, now, error);
  const blocked = after.filter(
    (r) => r.state === "blocked" && r.blockCode && HUMAN_BLOCKS.includes(r.blockCode),
  ).length;
  return {
    organizationId: orgId,
    status: needsReconnect ? "needs_reconnect" : "ran",
    sent: run.sent,
    recovered: run.recovered,
    waiting: after.filter((r) => r.state === "pending" || r.state === "sending").length,
    blocked,
    wouldSend: 0,
    error,
  };
}

/** Alla kopplade organisationer (det schemalagda jobbet). Ett fel i en stoppar inte nästa. */
export async function runFortnoxForAll(
  db: Db,
  options: FortnoxRunOptions = {},
): Promise<{ ranAt: string; organizations: FortnoxRunResult[] }> {
  const now = options.now ?? new Date();
  const orgs = Array.from(
    await db.execute<{ id: string }>(sql`
      select c.organization_id::text as id
      from public.fortnox_connections c
      join public.organizations o on o.id = c.organization_id
      where not o.is_demo and o.archived_at is null
      order by c.connected_at`),
  );
  const organizations: FortnoxRunResult[] = [];
  for (const { id } of orgs) {
    try {
      organizations.push(await runFortnoxFor(db, id, { ...options, now }));
    } catch (e) {
      // Aldrig token eller svar i loggen: bara felets namn och text.
      const message = e instanceof Error ? `${e.name}: ${e.message}` : "Okänt fel";
      console.error("[fortnox] körningen misslyckades", { organizationId: id, message });
      await safely("spara Fortnox-läget", () => saveState(db, id, now, clip(message)), undefined);
      organizations.push({
        organizationId: id,
        status: "error",
        ...EMPTY,
        error: clip(message, 300),
      });
    }
  }
  return { ranAt: now.toISOString(), organizations };
}
