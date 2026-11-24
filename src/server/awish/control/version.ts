/**
 * Awishs version, anslutningen och signeringen (Datakällor → Awish API).
 *
 * - checkAwishVersion: Version (osignerad läsning) sparas i awish_api_state. Byts versionen
 *   (eller är den nyare än proto-filen vi har inbäddad första gången) skapas ett systemlarm
 *   och skrivningar som rör fack, påfyllning, schema, Mata ut och Stäng av pausas tills
 *   ägaren eller admin har kvitterat (VERSION_GATED_KINDS i guard.ts). Bakgrund: ett
 *   oannonserat byte av fältnumren (1.2.41) gjorde att facken lästes fel.
 * - probeSigning: provar signeringslägena med en ofarlig signerad skrivning (UpdateMerchant
 *   med samma tidszon som redan gäller, annars UpdateCategory med samma titel) och sparar
 *   det som fungerar. Fungerar inget pausas alla skrivningar via API:t.
 * - probeEndpointFor: provar TLS och sparar resultatet (den okrypterade väljs bara av
 *   ägaren eller admin, med chooseInsecureEndpointFor).
 */

import "server-only";

import { sql } from "drizzle-orm";

import { getServiceDb, type Db } from "@/db/client";
import { requireRoleFor } from "@/server/access";
import { OPERATOR_ROLES } from "@/server/data/core/types";
import type { Viewer } from "@/server/data/core/loaders";
import { DEMO_MESSAGES, isDemoOrganization } from "@/server/demo/guard";
import { resolveSystemAlert } from "@/server/monitoring/system-alerts";

import { AWISH_SIGN_MODES, type AwishSignMode } from "../sign";
import { apiFor, controlContextFor, type AwishApiState, type ControlDeps } from "./connect";
import { endpointAddress, isTlsLostError, probeEndpoint } from "./endpoint";
import { signFieldsFromEnv } from "../proto-doc-fields";
import {
  AwishControlInputError,
  controlErrorMessage,
  isSignError,
  isSignMissingError,
  SIGN_MISSING_MESSAGE,
} from "./errors";
import { newIdempotencyKey, runControlAction } from "./guard";
import { ensureApiState, loadApiState, updateApiState } from "./state";
import type { AwishControlApi } from "./types";

import {
  compareVersions,
  EMBEDDED_PROTO_VERSION,
  recordAwishVersion,
  versionAlertKey,
  type VersionCheck,
} from "./version-record";

export { compareVersions, EMBEDDED_PROTO_VERSION, versionAlertKey, type VersionCheck };

/**
 * Läser Awishs version och sparar den. Larmar vid byte (och första gången om den skiljer
 * sig från den inbäddade proto-filen). Systemjobb eller efter rollkontroll.
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
  return recordAwishVersion(db, orgId, ctx.sourceId, ctx.state.version, version, now);
}

async function requireOperatorNotDemo(viewer: Viewer, db: Db): Promise<string | null> {
  await requireRoleFor(viewer.user, viewer.organization.id, OPERATOR_ROLES);
  return (await isDemoOrganization(db, viewer.organization.id)) ? DEMO_MESSAGES.integrations : null;
}

export type SimpleResult = { ok: true; message: string } | { ok: false; message: string };

/** "Jag har kontrollerat": ändringarna via API fungerar igen. Ägare och admin. */
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
  return { ok: true, message: "Tack. Ändringar via API fungerar igen." };
}

/**
 * "Testa anslutning": Version över TLS (eller adressen som är låst i miljön). Den okrypterade
 * provas aldrig här: den väljs bara med "Använd okrypterad". Ägare och admin.
 */
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
    const auto = ctx.endpointConfig.mode === "auto";
    const tlsWorkedBefore = auto && ctx.state.endpoint === "tls";
    const plainChosen = auto && ctx.state.endpoint === "plain";
    const probe = await probeEndpoint(ctx.creds, ctx.endpointConfig, ctx.connect, ctx.signMode, {
      tlsWorkedBefore,
    });
    if (plainChosen && probe.endpoint === null) {
      // Ägaren valde okrypterad: den gäller tills TLS svarar.
      return {
        ok: false,
        message: "TLS svarar inte. Okrypterad (vald av er) används fortfarande.",
      };
    }
    await updateApiState(db, orgId, ctx.sourceId, {
      // TLS sparas kvar när den slutade svara: styrningen väntar hellre än går okrypterat.
      endpoint: probe.endpoint ?? (tlsWorkedBefore ? "tls" : null),
      endpointCheckedAt: deps.now?.() ?? new Date(),
      endpointError: probe.error,
    });
    if (probe.endpoint === "tls")
      return { ok: true, message: "Krypterad anslutning (TLS) fungerar." };
    if (probe.endpoint === "plain") {
      return { ok: true, message: "Okrypterad anslutning fungerar (låst i miljön)." };
    }
    if (isTlsLostError(probe.error)) {
      return {
        ok: false,
        message: `${probe.error} Tryck Använd okrypterad om du vill byta ändå.`,
      };
    }
    return { ok: false, message: probe.error ?? "Awish svarar inte." };
  } catch (error) {
    return { ok: false, message: controlErrorMessage(error) };
  }
}

/**
 * "Använd okrypterad": ägaren eller admin väljer den okrypterade adressen när TLS har slutat
 * svara. Görs bara om den okrypterade svarar på Version. Synken provar TLS igen varje timme
 * och byter tillbaka när den fungerar.
 */
export async function chooseInsecureEndpointFor(
  viewer: Viewer,
  deps: ControlDeps = {},
): Promise<SimpleResult> {
  const db = deps.db ?? getServiceDb();
  const demo = await requireOperatorNotDemo(viewer, db);
  if (demo) return { ok: false, message: demo };
  const orgId = viewer.organization.id;
  try {
    const ctx = await controlContextFor(db, orgId, deps);
    if (ctx.endpointConfig.mode !== "auto") {
      return { ok: false, message: "Adressen är låst i miljön (AWISH_CONTROL_ENDPOINT)." };
    }
    const api = ctx.connect(ctx.creds, {
      ...endpointAddress("plain", ctx.endpointConfig),
      signMode: ctx.signMode,
    });
    try {
      await api.version();
    } finally {
      api.close();
    }
    await updateApiState(db, orgId, ctx.sourceId, {
      endpoint: "plain",
      endpointCheckedAt: deps.now?.() ?? new Date(),
      endpointError: "Okrypterad vald av ägare eller admin. TLS provas igen varje timme.",
    });
    return { ok: true, message: "Okrypterad anslutning används nu. TLS provas igen varje timme." };
  } catch (error) {
    return { ok: false, message: controlErrorMessage(error) };
  }
}

/**
 * En ofarlig signerad skrivning: samma tidszon igen, eller samma kategorititel igen. Ger
 * "merchant" när UpdateMerchant användes (ett av meddelandena där fältnumren skiljer).
 */
async function harmlessWrite(api: AwishControlApi): Promise<"merchant" | "category"> {
  const merchant = await api.merchantDetail();
  if (merchant.timezone) {
    await api.updateMerchantTimezone(merchant.timezone);
    return "merchant";
  }
  const [first] = await api.categories();
  if (first) {
    await api.updateCategory({ id: first.id, title: first.title });
    return "category";
  }
  throw new AwishControlInputError(
    "Hittar inget ofarligt att testa med (ingen tidszon och ingen kategori i Awish).",
  );
}

export interface SignProbeOutcome {
  mode: AwishSignMode | null;
  tried: AwishSignMode[];
  /**
   * Vilka fältnummer för timestamp/sign Awish läser i meddelandena där dokumentationen och
   * proto-filen skiljer (proto-doc-fields.ts), eller null om det inte gick att avgöra.
   */
  fields: "proto" | "doc" | null;
  missing: boolean;
}

/** Med båda paren fungerande: skicka bara proto-filens par och se om Awish saknar signaturen. */
async function detectSignFields(
  ctx: Awaited<ReturnType<typeof controlContextFor>>,
  mode: AwishSignMode,
): Promise<"proto" | "doc" | null> {
  const api = apiFor(ctx, mode, "proto");
  try {
    await harmlessWrite(api);
    return "proto";
  } catch (error) {
    if (isSignMissingError(error)) return "doc";
    return null;
  } finally {
    api.close();
  }
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
          const used = await harmlessWrite(api);
          await updateApiState(db, orgId, ctx.sourceId, {
            signMode: mode,
            signStatus: "ok",
            signCheckedAt: deps.now?.() ?? new Date(),
            signError: null,
          });
          const fields =
            used === "merchant" && signFieldsFromEnv(ctx.env) === "both"
              ? await detectSignFields(ctx, mode)
              : null;
          return { mode, tried, fields, missing: false };
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
      return { mode: null, tried, fields: null, missing: isSignMissingError(lastSignError) };
    },
    { ...deps, db },
  );
  if (!result.ok) return { ok: false, message: result.message };
  const mode = result.value?.mode ?? null;
  if (mode === null) {
    return {
      ok: false,
      mode: null,
      message: result.value?.missing
        ? `${SIGN_MISSING_MESSAGE} Skrivningar via API är pausade; webbpanelen används.`
        : "Awish godkänner inte vår signering ännu. Skrivningar via API är pausade; webbpanelen används.",
    };
  }
  const fields = result.value?.fields ?? null;
  const fieldsText =
    fields === "proto"
      ? " Awish läser proto-filens fältnummer."
      : fields === "doc"
        ? " Awish läser dokumentationens fältnummer (10 och 11)."
        : "";
  return { ok: true, mode, message: `Signeringen fungerar.${fieldsText}` };
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
 * Cron: Version för varje organisation, och en ny provning av TLS när ägaren valt den
 * okrypterade. Ett fel i en organisation stoppar inte de andra.
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
      if (ctx.endpoint === null) {
        // TLS provades just nu (controlContextFor) och svarar inte; inget mer att läsa.
        out.push({
          orgId,
          ok: false,
          version: null,
          changed: false,
          message: ctx.state.endpointError ?? "Awish svarar inte.",
        });
        continue;
      }
      if (ctx.endpointConfig.mode === "auto" && ctx.state.endpoint === "plain") {
        // Okrypterad vald av ägaren: prova TLS igen och byt tillbaka när den svarar.
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
