/**
 * Klient för organisationens Awish-konto för styrning (signerade skrivningar).
 *
 * STUBB: signaturerna följer designen (§2.3). Kropparna skrivs i paket P1; den här filen
 * ersätts av P1:s version vid sammanslagningen.
 */

import "server-only";

import type { Db } from "@/db/client";

import type { AwishCredentials } from "../grpc-client";
import type { AwishSignMode } from "../sign";
import type { AwishControlApi } from "./types";

/** Raden i awish_api_state (version, anslutning, signering och skrivvägar). */
export interface AwishApiState {
  version: string | null;
  versionSeenAt: Date | null;
  previousVersion: string | null;
  versionChangedAt: Date | null;
  versionAcknowledgedAt: Date | null;
  endpoint: "tls" | "plain" | null;
  signMode: AwishSignMode | null;
  signStatus: "unverified" | "ok" | "failed";
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
  _db: Db,
  _orgId: string,
  _deps?: ControlDeps,
): Promise<{ api: AwishControlApi; sourceId: string; state: AwishApiState }> {
  throw new Error("inte klart");
}

export async function awishMachineIdFor(
  _db: Db,
  _orgId: string,
  _machineId: string,
): Promise<string | null> {
  throw new Error("inte klart");
}
