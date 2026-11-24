/**
 * Awishs version, anslutningen och signeringen (Datakällor → Awish API).
 *
 * - checkAwishVersion: Version (osignerad läsning) sparas i awish_api_state. Byts versionen
 *   (eller är den nyare än proto-filen vi har inbäddad första gången) skapas ett systemlarm
 *   och Mata ut och Stäng av pausas tills ägaren eller admin har kvitterat. Bakgrund: ett
 *   oannonserat byte av fältnumren (1.2.41) gjorde att facken lästes fel.
 * - probeSigning: provar signeringslägena med en ofarlig signerad skrivning (UpdateMerchant
 *   med samma tidszon som redan gäller, annars UpdateCategory med samma titel) och sparar
 *   det som fungerar. Fungerar inget pausas alla skrivningar via API:t.
 * - probeEndpointFor: provar TLS och den okrypterade adressen och sparar resultatet.
 */

import "server-only";

import { sql } from "drizzle-orm";

import { getServiceDb, type Db } from "@/db/client";
import { requireRoleFor } from "@/server/access";
import { OPERATOR_ROLES } from "@/server/data/core/types";
import type { Viewer } from "@/server/data/core/loaders";
import { DEMO_MESSAGES, isDemoOrganization } from "@/server/demo/guard";
import { raiseSystemAlert, resolveSystemAlert } from "@/server/monitoring/system-alerts";

import { AWISH_SIGN_MODES, type AwishSignMode } from "../sign";
import { apiFor, controlContextFor, type AwishApiState, type ControlDeps } from "./connect";
import { probeEndpoint } from "./endpoint";
import { AwishControlInputError, controlErrorMessage, isSignError } from "./errors";
import { newIdempotencyKey, runControlAction } from "./guard";
import { ensureApiState, loadApiState, updateApiState } from "./state";
import type { AwishControlApi } from "./types";

/** Proto-filen som är inbäddad i provider-proto.ts. */
export const EMBEDDED_PROTO_VERSION = "1.2.41";

/** Jämför versioner som "1.2.41" (numeriskt per del). */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map((x) => Number.parseInt(x, 10) || 0);
  const pb = b.split(".").map((x) => Number.parseInt(x, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i += 1) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

export interface VersionCheck {
  version: string;
  previous: string | null;
  changed: boolean;
}

export function versionAlertKey(version: string): string {
  return `awish_version:${version}`;
}

/**
 * Läser Awishs version och sparar den. Larmar vid byte (och första gången om den är
 * nyare än den inbäddade proto-filen). Systemjobb eller efter rollkontroll.
 */
export async function checkAwishVersion(
  db: Db,
  orgId: string,
  deps: ControlDeps = {},
): Promise<VersionCheck> {
  const ctx = await controlContextFor(db, orgId, deps);
  const api = apiFor(ctx);
  let version: string;
  try {
    version = await api.version();
  } finally {
    api.close();
  }
  const now = deps.now?.() ?? new Date();
  const previous = ctx.state.version;
  const changed =
    previous !== null ? previous !== version : compareVersions(version, EMBEDDED_PROTO_VERSION) > 0;
  const from = previous ?? EMBEDDED_PROTO_VERSION;
  await updateApiState(db, orgId, ctx.sourceId, {
    version,
    versionSeenAt: now,
    ...(changed
      ? {
          previousVersion: from,
          versionChangedAt: now,
          versionAcknowledgedAt: null,
          versionAcknowledgedBy: null,
        }
      : {}),
  });
  if (changed) {
    await raiseSystemAlert(db, {
      organizationId: orgId,
      kind: "job_failed",
      key: versionAlertKey(version),
      severity: "warning",
      title: `Awish bytte API-version: ${from} → ${version}`,
      detail:
        "Kontrollera att facken och antalen ser rätt ut. Mata ut och Stäng av är pausade tills någon bekräftat under Datakällor.",
      rule: "Awishs Version-svar skiljer sig från förra kontrollen.",
      link: "/datakallor",
      now,
    });
  }
  return { version, previous, changed };
}

async function requireOperatorNotDemo(viewer: Viewer, db: Db): Promise<string | null> {
  await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  return (await isDemoOrganization(db, viewer.organization.id)) ? DEMO_MESSAGES.integrations : null;
}

export type SimpleResult = { ok: true; message: string } | { ok: false; message: string };

/** "Jag har kontrollerat": Mata ut och Stäng av fungerar igen. Ägare och admin. */
export async function acknowledgeAwishVersion(
  viewer: Viewer,
  deps: ControlDeps = {},
): Promise<SimpleResult> {
  const db = deps.db ?? getServiceDb();
  const demo = await requireOperatorNotDemo(viewer, db);
  if (demo) return { ok: false, message: demo };
  const orgId = viewer.organization.id;
  const [source] = Array.from(
    await db.execute(
      sql`select s.data_source_id, s.version from public.awish_api_state s
          join public.data_sources ds
            on ds.organization_id = s.organization_id and ds.id = s.data_source_id
          where s.organization_id = ${orgId}::uuid and ds.archived_at is null
          order by ds.created_at limit 1`,
    ),
  ) as Array<{ data_source_id: string; version: string | null }>;
  if (!source) return { ok: false, message: "Det finns ingen version att kvittera." };
  await updateApiState(db, orgId, source.data_source_id, {
    versionAcknowledgedAt: deps.now?.() ?? new Date(),
    versionAcknowledgedBy: viewer.user.userId,
  });
  if (source.version) {
    await resolveSystemAlert(db, orgId, versionAlertKey(source.version)).catch(() => 0);
  }
  return { ok: true, message: "Tack. Mata ut och Stäng av fungerar igen." };
}

/** "Testa anslutning": Version över TLS och den okrypterade. Ägare och admin. */
export async function probeEndpointFor(
  viewer: Viewer,
  deps: ControlDeps = {},
): Promise<SimpleResult> {
  const db = deps.db ?? getServiceDb();
  const demo = await requireOperatorNotDemo(viewer, db);
  if (demo) return { ok: false, message: demo };
  const orgId = viewer.organization.id;
  try {
    const ctx = await controlContextFor(db, orgId, deps);
    const probe = await probeEndpoint(ctx.creds, ctx.endpointConfig, ctx.connect, ctx.signMode);
    await updateApiState(db, orgId, ctx.sourceId, {
      endpoint: probe.endpoint,
      endpointCheckedAt: deps.now?.() ?? new Date(),
      endpointError: probe.error,
    });
    if (probe.endpoint === "tls")
      return { ok: true, message: "Krypterad anslutning (TLS) fungerar." };
    if (probe.endpoint === "plain") {
      return { ok: true, message: "Okrypterad anslutning fungerar. TLS svarade inte." };
    }
    return { ok: false, message: probe.error ?? "Awish svarar inte." };
  } catch (error) {
    return { ok: false, message: controlErrorMessage(error) };
  }
}

/** En ofarlig signerad skrivning: samma tidszon igen, eller samma kategorititel igen. */
async function harmlessWrite(api: AwishControlApi): Promise<void> {
  const merchant = await api.merchantDetail();
  if (merchant.timezone) {
    await api.updateMerchantTimezone(merchant.timezone);
    return;
  }
  const [first] = await api.categories();
  if (first) {
    await api.updateCategory({ id: first.id, title: first.title });
    return;
  }
  throw new AwishControlInputError(
    "Hittar inget ofarligt att testa med (ingen tidszon och ingen kategori i Awish).",
  );
}

export interface SignProbeOutcome {
  mode: AwishSignMode | null;
  tried: AwishSignMode[];
}

/**
 * "Testa signering": provar lägena i tur och ordning. Det första som Awish godtar sparas.
 * Nekas alla pausas skrivningar via API:t (sign_status 'failed'). Högst 6 gånger i timmen.
 */
export async function probeSigning(
  viewer: Viewer,
  deps: ControlDeps = {},
): Promise<SimpleResult & { mode?: AwishSignMode | null }> {
  const db = deps.db ?? getServiceDb();
  const orgId = viewer.organization.id;
  const result = await runControlAction<SignProbeOutcome>(
    viewer,
    {
      kind: "sign_probe",
      idempotencyKey: newIdempotencyKey(),
      auditRequest: { modes: [...AWISH_SIGN_MODES] },
      successMessage: "Signeringen fungerar.",
    },
    async () => {
      const ctx = await controlContextFor(db, orgId, deps);
      const tried: AwishSignMode[] = [];
      let lastSignError: unknown = null;
      for (const mode of AWISH_SIGN_MODES) {
        tried.push(mode);
        const api = apiFor(ctx, mode);
        try {
          await harmlessWrite(api);
          await updateApiState(db, orgId, ctx.sourceId, {
            signMode: mode,
            signStatus: "ok",
            signCheckedAt: deps.now?.() ?? new Date(),
            signError: null,
          });
          return { mode, tried };
        } catch (error) {
          if (!isSignError(error)) throw error;
          lastSignError = error;
        } finally {
          api.close();
        }
      }
      await updateApiState(db, orgId, ctx.sourceId, {
        signStatus: "failed",
        signCheckedAt: deps.now?.() ?? new Date(),
        signError: controlErrorMessage(lastSignError),
      });
      return { mode: null, tried };
    },
    { ...deps, db },
  );
  if (!result.ok) return { ok: false, message: result.message };
  const mode = result.value?.mode ?? null;
  if (mode === null) {
    return {
      ok: false,
      mode: null,
      message:
        "Awish godkänner inte vår signering ännu. Skrivningar via API är pausade; webbpanelen används.",
    };
  }
  return { ok: true, mode, message: "Signeringen fungerar." };
}

/** Datakällor: läget för kortet "Awish API". Ägare och admin. */
export interface AwishApiCardData {
  demo: boolean;
  connected: boolean;
  state: AwishApiState | null;
  embeddedVersion: string;
  /** Versionen bytt men inte kvitterad. */
  versionNeedsAck: boolean;
}

export async function awishApiCardFor(
  viewer: Viewer,
  deps: Pick<ControlDeps, "db"> = {},
): Promise<AwishApiCardData> {
  const db = deps.db ?? getServiceDb();
  await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  const orgId = viewer.organization.id;
  const base = { embeddedVersion: EMBEDDED_PROTO_VERSION, versionNeedsAck: false };
  if (await isDemoOrganization(db, orgId)) {
    return { ...base, demo: true, connected: false, state: null };
  }
  const [source] = Array.from(
    await db.execute(
      sql`select ds.id from public.data_sources ds
          where ds.organization_id = ${orgId}::uuid and ds.provider = 'awish_grpc'
            and ds.archived_at is null
          order by ds.created_at limit 1`,
    ),
  ) as Array<{ id: string }>;
  if (!source) return { ...base, demo: false, connected: false, state: null };
  const state =
    (await loadApiState(db, orgId, source.id)) ?? (await ensureApiState(db, orgId, source.id));
  const versionNeedsAck =
    state.versionChangedAt !== null &&
    (state.versionAcknowledgedAt === null ||
      state.versionAcknowledgedAt.getTime() < state.versionChangedAt.getTime());
  return { ...base, demo: false, connected: true, state, versionNeedsAck };
}

/** Datakällor: påfyllning och varor via webbpanelen, API:t eller API:t med reserv. */
export async function setAwishWritesVia(
  viewer: Viewer,
  input: { slot?: AwishApiState["slotWritesVia"]; goods?: AwishApiState["goodsWritesVia"] },
  deps: Pick<ControlDeps, "db"> = {},
): Promise<SimpleResult> {
  const db = deps.db ?? getServiceDb();
  const demo = await requireOperatorNotDemo(viewer, db);
  if (demo) return { ok: false, message: demo };
  const valid = (v: unknown) =>
    v === undefined || v === "web" || v === "api" || v === "api_then_web";
  if (!valid(input.slot) || !valid(input.goods)) return { ok: false, message: "Ogiltigt val." };
  const card = await awishApiCardFor(viewer, { db });
  if (!card.state) return { ok: false, message: "Koppla Awish först (Mer → Datakällor)." };
  await updateApiState(db, viewer.organization.id, card.state.dataSourceId, {
    ...(input.slot ? { slotWritesVia: input.slot } : {}),
    ...(input.goods ? { goodsWritesVia: input.goods } : {}),
  });
  return { ok: true, message: "Sparat." };
}

/** Cron: aktiva Awish API-källor med inloggning i organisationer som inte är demo. */
export async function versionCheckTargets(db: Db): Promise<Array<{ orgId: string }>> {
  const rows = Array.from(
    await db.execute(
      sql`select distinct ds.organization_id::text as org_id
          from public.data_sources ds
          join public.organizations o on o.id = ds.organization_id
          where ds.provider = 'awish_grpc' and ds.archived_at is null
            and o.archived_at is null and not o.is_demo and ds.secret_ref is not null`,
    ),
  ) as Array<{ org_id: string }>;
  return rows.map((r) => ({ orgId: r.org_id }));
}

/**
 * Cron: Version för varje organisation, och en ny provning av anslutningen när den
 * sparade inte är TLS. Ett fel i en organisation stoppar inte de andra.
 */
export async function runAwishVersionChecks(deps: ControlDeps = {}): Promise<
  Array<{
    orgId: string;
    ok: boolean;
    version: string | null;
    changed: boolean;
    message: string | null;
  }>
> {
  const db = deps.db ?? getServiceDb();
  const out = [];
  for (const { orgId } of await versionCheckTargets(db)) {
    try {
      const ctx = await controlContextFor(db, orgId, deps);
      if (ctx.endpointConfig.mode === "auto" && ctx.state.endpoint !== "tls") {
        const probe = await probeEndpoint(ctx.creds, ctx.endpointConfig, ctx.connect, ctx.signMode);
        if (probe.endpoint !== null) {
          await updateApiState(db, orgId, ctx.sourceId, {
            endpoint: probe.endpoint,
            endpointCheckedAt: deps.now?.() ?? new Date(),
            endpointError: probe.error,
          });
        }
      }
      const check = await checkAwishVersion(db, orgId, deps);
      out.push({ orgId, ok: true, version: check.version, changed: check.changed, message: null });
    } catch (error) {
      out.push({
        orgId,
        ok: false,
        version: null,
        changed: false,
        message: controlErrorMessage(error),
      });
    }
  }
  return out;
}
