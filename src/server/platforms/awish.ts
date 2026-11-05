/**
 * Awish (DingShang) som plattform: ett tunt omslag runt den befintliga integrationen.
 * Inget beteende ändras här; varje metod anropar samma kod som synken, uppladdningen
 * och påfyllningen redan använder:
 *
 *   parseFile     → awishCsvAdapter (orderlistan som CSV, src/import/adapters/awish-csv.ts)
 *   connect       → createAwishClient (gRPC, src/server/awish/grpc-client.ts)
 *     listMachines → fetchMachines (src/server/awish/sync.ts)
 *     readOrders   → AwishApi.orders + mapAwishOrders (src/import/adapters/awish-grpc.ts)
 *     readSlots    → AwishApi.products
 *   refill        → pushMachinesToAwish (webbpanelens API, src/server/awish/web-service.ts)
 *
 * Det schemalagda jobbet (src/server/awish/sync.ts) använder klienten direkt, eftersom
 * det också sköter sidläge, tidsbudget och saldo; gränssnittet beskriver samma förmågor.
 */

import "server-only";

import { awishCsvAdapter } from "@/import/adapters/awish-csv";
import { mapAwishOrders, type AwishGrpcMachine } from "@/import/adapters/awish-grpc";
import { ImportValidationError } from "@/import/errors";

import {
  awishClientConfigFromEnv,
  createAwishClient,
  type AwishApi,
  type AwishClientOptions,
  type AwishCredentials,
} from "../awish/grpc-client";
import { fetchMachines } from "../awish/sync";
import { pushMachinesToAwish } from "../awish/web-service";

import { PLATFORM_INFO } from "./catalog";
import type { MachinePlatform, PlatformConnection, PlatformRefillWriter } from "./types";

export interface AwishPlatformCredentials {
  credentials: AwishCredentials;
  /** Adress, TLS och tidsgränser. Standard: ur miljön (AWISH_GRPC_ADDRESS, AWISH_GRPC_TLS). */
  options?: AwishClientOptions;
}

export interface AwishPlatformDeps {
  /** Klienten mot Awish (tester skickar en mot låtsas-Awish eller en fejk). */
  createClient?: (credentials: AwishCredentials, options: AwishClientOptions) => AwishApi;
  pushRefill?: typeof pushMachinesToAwish;
}

/** En anslutning till Awish gRPC-API som PlatformConnection. */
export function awishConnection(api: AwishApi): PlatformConnection {
  // Automaternas namn behövs för orderna (samma som synken); läses en gång per anslutning.
  let machines: Promise<AwishGrpcMachine[]> | null = null;
  const machineList = () =>
    (machines ??= fetchMachines(api).then((list) =>
      list.map((m) => ({ id: m.id, name: m.name, machineNo: m.machineNo })),
    ));

  return {
    async listMachines() {
      const list = await fetchMachines(api);
      return list.map((m) => ({
        externalId: m.id,
        name: m.name,
        deviceNo: m.machineNo === "" ? null : m.machineNo,
        online: m.isOnline,
      }));
    },
    async readOrders({ page, perPage, sourceTimezone, machineIds }) {
      const res = await api.orders({
        currentPage: page,
        perPage,
        ...(machineIds && machineIds.length > 0 ? { machineIds: [...machineIds] } : {}),
      });
      const result = mapAwishOrders({
        orders: res.items,
        machines: await machineList(),
        sourceTimezone,
      });
      const last = res.lastPage !== null && res.lastPage > 0 ? res.lastPage : null;
      const hasMore =
        last !== null
          ? page < last
          : res.hasMore !== null
            ? res.hasMore
            : res.items.length >= perPage && res.items.length > 0;
      return { result, hasMore };
    },
    async readSlots(machineExternalId) {
      const products = await api.products(machineExternalId);
      return products.map((p) => ({
        channel: p.channel,
        productName: p.goodName,
        units: p.currentInventory,
        capacity: p.capacity,
      }));
    },
    close() {
      api.close();
    },
  };
}

export function createAwishPlatform(
  deps: AwishPlatformDeps = {},
): MachinePlatform<AwishPlatformCredentials> {
  const create = deps.createClient ?? createAwishClient;
  const push = deps.pushRefill ?? pushMachinesToAwish;
  const refill: PlatformRefillWriter = {
    async pushRefill(organizationId, machineIds) {
      const result = await push(organizationId, machineIds);
      return {
        status: result.status,
        machines: result.machines.map((m) => ({
          machineId: m.machineId,
          ok: m.status !== "error",
          message: m.error ?? null,
        })),
      };
    },
  };
  return {
    ...PLATFORM_INFO.awish,
    async parseFile(input) {
      if (input.provider !== "awish_csv") {
        throw new ImportValidationError(
          `Datakällan (${input.provider}) tar inte emot filer. Välj en CSV-datakälla.`,
        );
      }
      return awishCsvAdapter.fetch({
        context: input.context,
        file: input.file,
        mapping: input.mapping,
      });
    },
    connect({ credentials, options }) {
      return awishConnection(create(credentials, options ?? { ...awishClientConfigFromEnv() }));
    },
    refill,
  };
}

export const awishPlatform = createAwishPlatform();
