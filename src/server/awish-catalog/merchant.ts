/**
 * Awish-kontot (Inställningar → Awish): namn, giltig till, tidszon, valutor och IP-lista.
 * Läses mest. Det enda som skrivs är tidszonen (UpdateMerchant med BARA timezone; config
 * skickas aldrig, där ligger appid och nycklarna). Strömschemat räknar i kontots tidszon,
 * därför ska den vara organisationens.
 *
 * Ordrarnas tider från Awish läses i källans tidszon (data_sources.source_timezone). Räknar
 * källan i kontots gamla tidszon byts den i samma åtgärd, efter att Awish sagt ja, så att
 * nya ordrar inte hamnar timmar fel. Räknar källan i en tredje tidszon spärras bytet.
 */

import "server-only";

import { sql } from "drizzle-orm";

import type { Db } from "@/db/client";
import { runControlAction } from "@/server/awish/control/guard";
import { awishSourceOf } from "@/server/awish/marketing";
import type { AwishCurrencyInfo, AwishMerchantDetail } from "@/server/awish/control/types";
import type { Viewer } from "@/server/data/core/loaders";
import { DEMO_MESSAGES, isDemoOrganization } from "@/server/demo/guard";

import {
  catalogPreview,
  CatalogError,
  dbOf,
  keyOf,
  outcomeOf,
  readErrorMessage,
  requireOperator,
  STALE_MESSAGE,
  withReadClient,
  type CatalogDeps,
  type CatalogOutcome,
  type CatalogPreview,
} from "./common";

export type AwishAccountPage =
  | { status: "demo"; message: string }
  | { status: "error"; message: string }
  | {
      status: "ok";
      merchant: AwishMerchantDetail;
      currencies: AwishCurrencyInfo[];
      /** Organisationens tidszon (det Awish-kontot borde ha). */
      wantedTimezone: string;
      timezoneMatches: boolean;
    };

function wantedOf(viewer: Viewer): string {
  return viewer.organization.timezone || "Europe/Stockholm";
}

export async function loadAwishAccountFor(
  viewer: Viewer,
  deps: CatalogDeps = {},
): Promise<AwishAccountPage> {
  await requireOperator(viewer);
  if (await isDemoOrganization(dbOf(deps), viewer.organization.id)) {
    return { status: "demo", message: DEMO_MESSAGES.integrations };
  }
  try {
    return await withReadClient(viewer, deps, async ({ api }) => {
      const merchant = await api.merchantDetail();
      const currencies = await api.currencies();
      const wantedTimezone = wantedOf(viewer);
      return {
        status: "ok" as const,
        merchant,
        currencies,
        wantedTimezone,
        timezoneMatches: merchant.timezone === wantedTimezone,
      };
    });
  } catch (error) {
    return { status: "error", message: readErrorMessage(error) };
  }
}

export function planTimezone(args: {
  current: string | null;
  wanted: string;
  /** Tidszonen som ordrarna från Awish läses i (källan), eller null om ingen källa. */
  sourceTimezone?: string | null;
}): {
  lines: string[];
  warnings: string[];
  blocking: string | null;
  confirm: string | null;
  /** Byt källans tidszon till `wanted` i samma åtgärd. */
  moveSource: boolean;
} {
  if (args.current === args.wanted) {
    return {
      lines: [],
      warnings: [],
      blocking: `Awish-kontot räknar redan i ${args.wanted}.`,
      confirm: null,
      moveSource: false,
    };
  }
  const source = args.sourceTimezone ?? null;
  const same = (a: string | null, b: string | null) =>
    a !== null && b !== null && a.trim().toLowerCase() === b.trim().toLowerCase();
  if (source !== null && !same(source, args.current) && !same(source, args.wanted)) {
    return {
      lines: [],
      warnings: [],
      blocking: `Ordrarna från Awish läses i ${source}, men kontot räknar i ${args.current ?? "okänd tidszon"}. Kontrollera tidszonen under Datakällor först.`,
      confirm: null,
      moveSource: false,
    };
  }
  const moveSource = source !== null && !same(source, args.wanted);
  return {
    lines: [
      `Tidszon: ${args.current ?? "okänd"} → ${args.wanted}.`,
      ...(moveSource ? [`Nya ordrar från Awish läses i ${args.wanted} från och med nu.`] : []),
    ],
    warnings: ["Awishs rapporter och strömscheman räknar i den nya tidszonen efteråt."],
    blocking: null,
    confirm: `Byta Awish-kontots tidszon till ${args.wanted}?`,
    moveSource,
  };
}

async function sourceTimezoneOf(
  db: Db,
  orgId: string,
): Promise<{ id: string; timezone: string } | null> {
  const source = await awishSourceOf(db, orgId);
  if (!source) return null;
  const [row] = Array.from(
    await db.execute(
      sql`select source_timezone from public.data_sources
          where organization_id = ${orgId}::uuid and id = ${source.id}::uuid`,
    ),
  ) as { source_timezone: string }[];
  return row ? { id: source.id, timezone: row.source_timezone } : null;
}

async function computeTimezone(viewer: Viewer, deps: CatalogDeps) {
  const wanted = wantedOf(viewer);
  const merchant = await withReadClient(viewer, deps, ({ api }) => api.merchantDetail());
  const source = await sourceTimezoneOf(dbOf(deps), viewer.organization.id);
  const plan = planTimezone({
    current: merchant.timezone,
    wanted,
    sourceTimezone: source?.timezone ?? null,
  });
  const extra = { wanted, current: merchant.timezone, source: source?.timezone ?? null };
  return { wanted, plan, extra, source, fingerprint: catalogPreview(plan, extra).fingerprint };
}

export async function previewTimezoneFor(
  viewer: Viewer,
  deps: CatalogDeps = {},
): Promise<CatalogPreview> {
  const { plan, extra } = await computeTimezone(viewer, deps);
  return catalogPreview(plan, extra);
}

/** Byter Awish-kontots tidszon till organisationens. Skickar BARA {timezone}. */
export async function applyTimezoneFor(
  viewer: Viewer,
  raw: unknown,
  deps: CatalogDeps = {},
): Promise<CatalogOutcome> {
  const r = (raw ?? {}) as { fingerprint?: unknown; idempotencyKey?: unknown };
  const key = keyOf(r.idempotencyKey);
  const { wanted, plan, fingerprint, source } = await computeTimezone(viewer, deps);
  if (plan.blocking) throw new CatalogError(plan.blocking);
  if (fingerprint !== r.fingerprint) throw new CatalogError(STALE_MESSAGE);
  const db = dbOf(deps);
  const orgId = viewer.organization.id;
  const result = await (deps.run ?? runControlAction)(
    viewer,
    {
      kind: "merchant_update",
      idempotencyKey: key,
      auditRequest: {
        timezone: wanted,
        ...(plan.moveSource && source
          ? { sourceTimezone: { from: source.timezone, to: wanted } }
          : {}),
      },
    },
    async (api) => {
      const written = await api.updateMerchantTimezone(wanted);
      // Awish sa ja: nya ordrar har tider i den nya tidszonen, så källan byter samtidigt.
      if (plan.moveSource && source) {
        await db.execute(
          sql`update public.data_sources set source_timezone = ${wanted}
              where organization_id = ${orgId}::uuid and id = ${source.id}::uuid`,
        );
      }
      return written;
    },
    deps,
  );
  return outcomeOf(
    result,
    plan.moveSource
      ? `Klart! Awish-kontot och ordrarna räknar nu i ${wanted}.`
      : `Klart! Awish-kontot räknar nu i ${wanted}.`,
  );
}
