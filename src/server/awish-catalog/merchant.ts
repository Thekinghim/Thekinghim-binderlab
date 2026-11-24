/**
 * Awish-kontot (Inställningar → Awish): namn, giltig till, tidszon, valutor och IP-lista.
 * Läses mest. Det enda som skrivs är tidszonen (UpdateMerchant med BARA timezone; config
 * skickas aldrig, där ligger appid och nycklarna). Strömschemat räknar i kontots tidszon,
 * därför ska den vara organisationens.
 */

import "server-only";

import { runControlAction } from "@/server/awish/control/guard";
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

export function planTimezone(args: { current: string | null; wanted: string }): {
  lines: string[];
  warnings: string[];
  blocking: string | null;
  confirm: string | null;
} {
  if (args.current === args.wanted) {
    return {
      lines: [],
      warnings: [],
      blocking: `Awish-kontot räknar redan i ${args.wanted}.`,
      confirm: null,
    };
  }
  return {
    lines: [`Tidszon: ${args.current ?? "okänd"} → ${args.wanted}.`],
    warnings: ["Awishs rapporter och strömscheman räknar i den nya tidszonen efteråt."],
    blocking: null,
    confirm: `Byta Awish-kontots tidszon till ${args.wanted}?`,
  };
}

async function computeTimezone(viewer: Viewer, deps: CatalogDeps) {
  const wanted = wantedOf(viewer);
  const merchant = await withReadClient(viewer, deps, ({ api }) => api.merchantDetail());
  const plan = planTimezone({ current: merchant.timezone, wanted });
  const extra = { wanted, current: merchant.timezone };
  return { wanted, plan, extra, fingerprint: catalogPreview(plan, extra).fingerprint };
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
  const { wanted, plan, fingerprint } = await computeTimezone(viewer, deps);
  if (plan.blocking) throw new CatalogError(plan.blocking);
  if (fingerprint !== r.fingerprint) throw new CatalogError(STALE_MESSAGE);
  const result = await (deps.run ?? runControlAction)(
    viewer,
    { kind: "merchant_update", idempotencyKey: key, auditRequest: { timezone: wanted } },
    (api) => api.updateMerchantTimezone(wanted),
    deps,
  );
  return outcomeOf(result, `Klart! Awish-kontot räknar nu i ${wanted}.`);
}
