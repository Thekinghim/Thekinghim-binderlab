/**
 * Hälsan per Awish-väg (public.awish_path_health, 20261229000000_awish_halsa.sql).
 *
 * Varje del av Binderlab som pratar med Awish (orderna, automaterna, facken, kontots slutdag,
 * påfyllningarna till webbpanelen, varor, fack, kampanjer och gratis-pack) sparar efter varje
 * försök vilken väg som fungerade: Open API (gRPC), webbpanelen (reservvägen), senast kända
 * data, manuellt eller ingen. Vakten, Datakällor och Kontroll läser raderna
 * (loadAwishHealth), så att ett fel aldrig går tyst.
 *
 * Brytaren: en väg som felar (Awish internt fel, nere, tidsgräns) öppnas i 15 minuter, för
 * många anrop (429) i 5 minuter, ett inloggningsfel eller ett ändrat API i 6 timmar. Medan den är öppen hoppas vägen över och
 * reserven används direkt. När tiden har gått provas vägen en gång (halvöppen): lyckas den
 * stängs brytaren, annars öppnas den igen lika länge.
 *
 * Inget här kastar: ett databasfel loggas bara, och synken eller åtgärden fortsätter.
 * Feltexterna kortas till 200 tecken och rensas från långa kodade värden och adresser med
 * frågesträng; inloggningsuppgifter finns aldrig i dem.
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Db, Tx } from "@/db/client";
import { clip } from "@/server/monitoring/system-alerts";

import { AwishApiError, type AwishErrorKind } from "./grpc-client";

export type AwishPath =
  | "orders"
  | "machines"
  | "stock"
  | "merchant"
  | "push"
  | "goods"
  | "slots"
  | "campaigns"
  | "free_packs";

export type AwishRoute = "open_api" | "webbpanelen" | "senast_kanda" | "manuell" | "ingen";

export const AWISH_PATHS: readonly AwishPath[] = [
  "orders",
  "machines",
  "stock",
  "merchant",
  "push",
  "goods",
  "slots",
  "campaigns",
  "free_packs",
];

/** Brytarens tid i minuter per felart. null = felet öppnar ingen brytare. */
export function breakerMinutes(kind: AwishErrorKind | null | undefined): number | null {
  switch (kind) {
    case "server":
    case "unavailable":
    case "timeout":
    case "invalid_response":
      return 15;
    case "rate_limited":
      return 5;
    case "auth":
    case "changed":
      return 360;
    default:
      return null;
  }
}

export interface AwishPathHealth {
  readonly dataSourceId: string;
  readonly path: AwishPath;
  readonly activeRoute: AwishRoute;
  readonly lastSuccessAt: string | null;
  readonly lastSuccessRoute: AwishRoute | null;
  readonly lastAttemptAt: string | null;
  readonly lastErrorAt: string | null;
  readonly lastErrorKind: string | null;
  readonly lastErrorCode: number | null;
  readonly lastErrorText: string | null;
  readonly failingSince: string | null;
  readonly consecutiveFailures: number;
  readonly breakerRoute: AwishRoute | null;
  readonly breakerOpenUntil: string | null;
  readonly alertedAt: string | null;
  readonly recoveredAt: string | null;
  readonly webIdsVerifiedAt: string | null;
}

type Executor = Db | Tx;

/** Felets art, gRPC-kod och en kort text utan hemligheter. */
export function describeError(error: unknown): {
  kind: string;
  code: number | null;
  text: string;
} {
  const kind =
    error instanceof AwishApiError
      ? error.kind
      : error instanceof Error && error.name === "AbortError"
        ? "timeout"
        : "internal";
  const code = error instanceof AwishApiError ? error.grpcCode : null;
  const raw =
    error instanceof Error ? error.message || error.name : typeof error === "string" ? error : "";
  return { kind, code, text: safeErrorText(raw) };
}

/**
 * Text som går att spara: långa kodade värden (token, signerad indata) döljs, frågesträngar
 * i adresser tas bort, och texten kortas till 200 tecken.
 */
export function safeErrorText(raw: string): string {
  const cleaned = raw
    .replace(/(https?:\/\/[^\s?#]+)[?#]\S*/gi, "$1")
    .replace(/\b(bearer|token|password|secret|appkey|appsecret)\b\s*[:=]?\s*\S+/gi, "$1 [dolt]")
    .replace(/[A-Za-z0-9+/=_-]{32,}/g, "[dolt]");
  return clip(cleaned, 200) || "Okänt fel";
}

function iso(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  return Number.isFinite(d.getTime()) ? d.toISOString() : null;
}

/**
 * Sparar ett försök. `ok` = vägen `route` fungerade (även om en annan väg först felade; då
 * skickas det felet med som `error` och sparas som senaste fel). `ok` = false: ingen väg
 * fungerade, `route` är det som används i stället (senast_kanda eller ingen).
 * Lyckas den väg som brytaren gäller stängs brytaren. Kastar aldrig.
 */
export async function recordPathResult(
  db: Executor,
  input: {
    organizationId: string;
    dataSourceId: string;
    path: AwishPath;
    route: AwishRoute;
    ok: boolean;
    error?: unknown;
    now?: Date;
  },
): Promise<void> {
  const at = (input.now ?? new Date()).toISOString();
  const err = input.error === undefined || input.error === null ? null : describeError(input.error);
  const successRoute = input.ok && input.route !== "ingen" ? input.route : null;
  try {
    await db.execute(
      sql`insert into public.awish_path_health as h
            (organization_id, data_source_id, path, active_route, last_success_at,
             last_success_route, last_attempt_at, last_error_at, last_error_kind,
             last_error_code, last_error_text, failing_since, consecutive_failures)
          values (${input.organizationId}::uuid, ${input.dataSourceId}::uuid, ${input.path},
                  ${input.route},
                  ${input.ok ? at : null}::timestamptz, ${successRoute},
                  ${at}::timestamptz,
                  ${err ? at : null}::timestamptz, ${err?.kind ?? null},
                  ${err?.code ?? null}::integer, ${err?.text ?? null},
                  ${input.ok ? null : at}::timestamptz, ${input.ok ? 0 : 1})
          on conflict (organization_id, data_source_id, path) do update set
            active_route = excluded.active_route,
            last_attempt_at = excluded.last_attempt_at,
            last_success_at = coalesce(excluded.last_success_at, h.last_success_at),
            last_success_route = coalesce(excluded.last_success_route, h.last_success_route),
            last_error_at = coalesce(excluded.last_error_at, h.last_error_at),
            last_error_kind = case when excluded.last_error_at is null then h.last_error_kind
                                   else excluded.last_error_kind end,
            last_error_code = case when excluded.last_error_at is null then h.last_error_code
                                   else excluded.last_error_code end,
            last_error_text = case when excluded.last_error_at is null then h.last_error_text
                                   else excluded.last_error_text end,
            failing_since = case when ${input.ok}::boolean then null
                                 else coalesce(h.failing_since, excluded.failing_since) end,
            consecutive_failures = case when ${input.ok}::boolean then 0
                                        else h.consecutive_failures + 1 end,
            recovered_at = case when ${input.ok}::boolean and h.failing_since is not null
                                then excluded.last_attempt_at else h.recovered_at end,
            breaker_route = case when ${input.ok}::boolean
                                  and h.breaker_route = excluded.active_route
                                 then null else h.breaker_route end,
            breaker_open_until = case when ${input.ok}::boolean
                                       and h.breaker_route = excluded.active_route
                                      then null else h.breaker_open_until end`,
    );
  } catch (error) {
    console.error(`[awish] hälsan för ${input.path} kunde inte sparas`, safeLog(error));
  }
}

function safeLog(error: unknown): string {
  return describeError(error).text;
}

/** Är brytaren öppen för vägen nu? (Halvöppen efter tiden: false, så att vägen provas.) */
export async function breakerOpen(
  db: Executor,
  dataSourceId: string,
  path: AwishPath,
  route: AwishRoute,
  now: Date = new Date(),
): Promise<boolean> {
  try {
    const [row] = Array.from(
      await db.execute(
        sql`select 1 as open from public.awish_path_health
            where data_source_id = ${dataSourceId}::uuid and path = ${path}
              and breaker_route = ${route}
              and breaker_open_until > ${now.toISOString()}::timestamptz
            limit 1`,
      ),
    );
    return row !== undefined;
  } catch (error) {
    console.error(`[awish] brytaren för ${path} kunde inte läsas`, safeLog(error));
    return false;
  }
}

/**
 * Öppnar brytaren för vägen (tiden efter felets art, breakerMinutes). Ett fel som inte
 * öppnar någon brytare (t.ex. tidsbudgeten) ändrar inget. Kastar aldrig.
 */
export async function openBreaker(
  db: Executor,
  dataSourceId: string,
  path: AwishPath,
  route: AwishRoute,
  kind: AwishErrorKind | string | null | undefined,
  now: Date = new Date(),
): Promise<string | null> {
  const minutes = breakerMinutes(kind as AwishErrorKind);
  if (minutes === null || (route !== "open_api" && route !== "webbpanelen")) return null;
  const until = new Date(now.getTime() + minutes * 60_000).toISOString();
  try {
    // Organisationen ur datakällan (aldrig ur indata).
    await db.execute(
      sql`insert into public.awish_path_health as h
            (organization_id, data_source_id, path, breaker_route, breaker_open_until)
          select ds.organization_id, ds.id, ${path}, ${route}, ${until}::timestamptz
          from public.data_sources ds where ds.id = ${dataSourceId}::uuid
          on conflict (organization_id, data_source_id, path) do update set
            breaker_route = excluded.breaker_route,
            breaker_open_until = excluded.breaker_open_until`,
    );
    return until;
  } catch (error) {
    console.error(`[awish] brytaren för ${path} kunde inte sparas`, safeLog(error));
    return null;
  }
}

/**
 * Stänger brytaren för vägen i alla stigar (t.ex. webbpanelen efter ett nytt lösenord eller en
 * lyckad "Testa reservvägen"). Kastar aldrig.
 */
export async function closeBreakers(
  db: Executor,
  dataSourceId: string,
  route: AwishRoute,
): Promise<void> {
  try {
    await db.execute(
      sql`update public.awish_path_health
          set breaker_route = null, breaker_open_until = null
          where data_source_id = ${dataSourceId}::uuid and breaker_route = ${route}`,
    );
  } catch (error) {
    console.error("[awish] brytaren kunde inte stängas", safeLog(error));
  }
}

/** Gratis-pack: webbpanelens fack-id är samma som Open API:s (jämfört nu). */
export async function markWebIdsVerified(
  db: Executor,
  input: { organizationId: string; dataSourceId: string; now?: Date },
): Promise<void> {
  const at = (input.now ?? new Date()).toISOString();
  try {
    await db.execute(
      sql`insert into public.awish_path_health as h
            (organization_id, data_source_id, path, web_ids_verified_at)
          values (${input.organizationId}::uuid, ${input.dataSourceId}::uuid, 'free_packs',
                  ${at}::timestamptz)
          on conflict (organization_id, data_source_id, path) do update set
            web_ids_verified_at = excluded.web_ids_verified_at`,
    );
  } catch (error) {
    console.error("[awish] id-kontrollen kunde inte sparas", safeLog(error));
  }
}

/** Tar bort id-kontrollen (id:na skilde sig): inga koder via webbpanelen förrän nästa. */
export async function clearWebIdsVerified(
  db: Executor,
  input: { organizationId: string; dataSourceId: string },
): Promise<void> {
  try {
    await db.execute(
      sql`update public.awish_path_health set web_ids_verified_at = null
          where organization_id = ${input.organizationId}::uuid
            and data_source_id = ${input.dataSourceId}::uuid and path = 'free_packs'`,
    );
  } catch (error) {
    console.error("[awish] id-kontrollen kunde inte sparas", safeLog(error));
  }
}

/** När webbpanelens fack-id senast visades vara samma som Open API:s, eller null. */
export async function webIdsVerifiedAt(db: Executor, dataSourceId: string): Promise<Date | null> {
  try {
    const [row] = Array.from(
      await db.execute(
        sql`select web_ids_verified_at as at from public.awish_path_health
            where data_source_id = ${dataSourceId}::uuid and path = 'free_packs'`,
      ),
    ) as { at: Date | string | null }[];
    const at = iso(row?.at ?? null);
    return at ? new Date(at) : null;
  } catch (error) {
    console.error("[awish] id-kontrollen kunde inte läsas", safeLog(error));
    return null;
  }
}

/** Alla vägar för organisationens Awish-källor (systemrollen; organisationen ur sessionen). */
export async function loadAwishHealth(
  db: Executor,
  organizationId: string,
): Promise<AwishPathHealth[]> {
  const rows = Array.from(
    await db.execute(
      sql`select data_source_id::text as data_source_id, path, active_route, last_success_at,
                 last_success_route, last_attempt_at, last_error_at, last_error_kind,
                 last_error_code, last_error_text, failing_since, consecutive_failures,
                 breaker_route, breaker_open_until, alerted_at, recovered_at,
                 web_ids_verified_at
          from public.awish_path_health
          where organization_id = ${organizationId}::uuid
          order by path, data_source_id`,
    ),
  ) as Record<string, unknown>[];
  return rows.map((r) => ({
    dataSourceId: String(r.data_source_id),
    path: r.path as AwishPath,
    activeRoute: r.active_route as AwishRoute,
    lastSuccessAt: iso(r.last_success_at),
    lastSuccessRoute: (r.last_success_route as AwishRoute | null) ?? null,
    lastAttemptAt: iso(r.last_attempt_at),
    lastErrorAt: iso(r.last_error_at),
    lastErrorKind: (r.last_error_kind as string | null) ?? null,
    lastErrorCode: r.last_error_code === null ? null : Number(r.last_error_code),
    lastErrorText: (r.last_error_text as string | null) ?? null,
    failingSince: iso(r.failing_since),
    consecutiveFailures: Number(r.consecutive_failures ?? 0),
    breakerRoute: (r.breaker_route as AwishRoute | null) ?? null,
    breakerOpenUntil: iso(r.breaker_open_until),
    alertedAt: iso(r.alerted_at),
    recoveredAt: iso(r.recovered_at),
    webIdsVerifiedAt: iso(r.web_ids_verified_at),
  }));
}
