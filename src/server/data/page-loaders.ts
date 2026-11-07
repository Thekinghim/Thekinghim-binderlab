/**
 * Laddarna som sidornas listor (Hem, Automater, Butiker) bygger på, som ett utbytbart
 * paket. Sidorna använder förfrågans memoiserade laddare (requestPageLoaders: inloggad
 * användare, vyknappen ur headern); Daglig kontroll (src/server/self-check) använder
 * samma sidladdare med en given användare och ett givet läge för vyknappen
 * (viewerPageLoaders), så att kontrollen räknar exakt som sidorna.
 */

import "server-only";

import type { MachineHealth } from "@/analytics/health";
import type { SearchParamsInput } from "@/components/shell/period-state";
import type { IsoDate } from "@/domain";
import {
  loadContext,
  loadDomainInput,
  loadMasterData,
  loadPeriod,
  loadStock,
  requireViewer,
  type DomainInputArgs,
} from "@/server/data/core";
import {
  loadContextFor,
  loadDataStartFor,
  loadDomainInputFor,
  loadMasterDataFor,
  loadStockFor,
  type Viewer,
} from "@/server/data/core/loaders";
import { resolveAppPeriod } from "@/server/data/core/period";
import type {
  AppContext,
  AppPeriod,
  DomainInput,
  MasterData,
  StockSnapshot,
} from "@/server/data/core/types";
import { loadMachineHealth, loadMachineHealthFor } from "@/server/data/health";

export interface PageLoaders {
  viewer(): Promise<Viewer>;
  context(): Promise<AppContext>;
  period(sp: SearchParamsInput): Promise<AppPeriod>;
  domainInput(args: DomainInputArgs): Promise<DomainInput>;
  masterData(): Promise<MasterData>;
  stock(): Promise<StockSnapshot>;
  machineHealth(): Promise<MachineHealth[]>;
}

/** Den inloggades laddare i förfrågan (React cache), vyknapparna ur headern. */
export function requestPageLoaders(): PageLoaders {
  return {
    viewer: requireViewer,
    context: loadContext,
    period: loadPeriod,
    domainInput: loadDomainInput,
    masterData: loadMasterData,
    stock: loadStock,
    machineHealth: loadMachineHealth,
  };
}

function once<T>(fn: () => Promise<T>): () => Promise<T> {
  let p: Promise<T> | null = null;
  return () => (p ??= fn());
}

/**
 * Samma laddare för en given användare (rollen kontrolleras mot databasen och allt läses
 * under RLS som hen), vid tiden `now` och med vyknappen "Visa butikernas andel" i läget
 * `storeShare` (VMB av, som standard på sidorna). Allt memoiseras i paketet: två sidor
 * som läser samma period läser den en gång.
 */
export function viewerPageLoaders(
  viewer: Viewer,
  options: {
    readonly now: Date;
    readonly storeShare: boolean;
    /** Första dagen med data (delas mellan två paket för samma användare). */
    readonly dataStart?: () => Promise<IsoDate | null>;
  },
): PageLoaders {
  const { now, storeShare } = options;
  const inputs = new Map<string, Promise<DomainInput>>();
  const dataStart = options.dataStart ?? once(() => loadDataStartFor(viewer));
  const context = once(() => loadContextFor(viewer, [viewer.organization], now));
  return {
    viewer: async () => viewer,
    context,
    period: async (sp) =>
      resolveAppPeriod(sp, {
        timeZone: viewer.organization.timezone,
        dataStart: await dataStart(),
        now,
      }),
    domainInput: (args) => {
      const full: DomainInputArgs = {
        period: args.period,
        compare: args.compare ?? null,
        storeId: args.storeId ?? null,
        machineId: args.machineId ?? null,
        vmb: args.vmb ?? false,
        storeShare: args.storeShare ?? storeShare,
      };
      const key = JSON.stringify(full);
      let p = inputs.get(key);
      if (!p) {
        p = loadDomainInputFor(viewer, full, now);
        inputs.set(key, p);
      }
      return p;
    },
    masterData: once(() => loadMasterDataFor(viewer, now)),
    stock: once(() => loadStockFor(viewer)),
    machineHealth: once(() => loadMachineHealthFor(viewer, now)),
  };
}
