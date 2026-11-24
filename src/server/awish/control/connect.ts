/** Klient för organisationens Awish-konto med rätt adress, TLS och signeringsläge. */

import "server-only";

import type { Db } from "@/db/client";

import type { AwishCredentials } from "../grpc-client";
import type { AwishSignMode } from "../sign";
import type { AwishControlApi } from "./types";

export interface AwishApiState {
  id: string;
  dataSourceId: string;
  version: string | null;
  versionSeenAt: Date | null;
  previousVersion: string | null;
  versionChangedAt: Date | null;
  versionAcknowledgedAt: Date | null;
  endpoint: "tls" | "plain" | null;
  endpointCheckedAt: Date | null;
  endpointError: string | null;
  signMode: AwishSignMode | null;
  signStatus: "unverified" | "ok" | "failed";
  signCheckedAt: Date | null;
  signError: string | null;
  slotWritesVia: "web" | "api" | "api_then_web";
  goodsWritesVia: "web" | "api" | "api_then_web";
}

export interface ControlDeps {
  db?: Db;
  connect?: (
    creds: AwishCredentials,
    cfg: { address: string; tls: boolean; signMode: AwishSignMode },
  ) => AwishControlApi;
  now?: () => Date;
  env?: Record<string, string | undefined>;
}

export async function controlClientFor(
  db: Db,
  orgId: string,
  deps?: ControlDeps,
): Promise<{ api: AwishControlApi; sourceId: string; state: AwishApiState }> {
  void db;
  void orgId;
  void deps;
  throw new Error("inte klart");
}

export async function awishMachineIdFor(
  db: Db,
  orgId: string,
  machineId: string,
): Promise<string | null> {
  void db;
  void orgId;
  void machineId;
  throw new Error("inte klart");
}
