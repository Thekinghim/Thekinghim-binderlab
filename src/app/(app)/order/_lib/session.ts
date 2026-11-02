/**
 * Den inloggade användaren som Viewer och listans argument ur URL:en, för orderlistans
 * sida, server actions och export. Rollen kontrolleras igen i varje laddare i ./service.
 */

import "server-only";

import { cache } from "react";

import type { SearchParamsInput } from "@/components/shell/period-state";
import type { Viewer } from "@/server/data/core/loaders";
import { loadPeriod, type AppPeriod } from "@/server/data/core";
import { AuthorizationError, getActiveOrganization, requireUser } from "@/server/session";

import { parseOrderParams, type OrderParams } from "./params";
import type { OrderListArgs } from "./service";

export const currentViewer = cache(async (): Promise<Viewer> => {
  const user = await requireUser();
  const organization = await getActiveOrganization();
  if (!organization) {
    throw new AuthorizationError("forbidden", "Du är inte medlem i någon organisation.");
  }
  return { user, organization };
});

/** Period, filter, sökning och sortering ur search params (skalets och listans egna). */
export async function listArgsFrom(
  sp: SearchParamsInput,
): Promise<{ args: OrderListArgs; period: AppPeriod; params: OrderParams }> {
  const period = await loadPeriod(sp);
  const params = parseOrderParams(sp);
  return {
    args: { period: period.period, compare: period.compare, scope: period.scope, params },
    period,
    params,
  };
}
