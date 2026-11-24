/**
 * Klient för organisationens Awish-konto med rätt adress (TLS eller okrypterad),
 * signeringsläge och API-läget (awish_api_state). Körs som systemrollen EFTER
 * rollkontrollen hos anroparen; organisationen kommer alltid från den inloggades aktiva
 * organisation eller ett systemjobb. Inloggningsuppgifterna läses ur Vault och lämnar
 * aldrig servern.
 *
 * Signeringsläget: AWISH_SIGN_MODE i miljön, annars det som "Testa signering" sparade,
 * annars present_sorted.
 */

import "server-only";

import type { Db } from "@/db/client";

import type { AwishCredentials } from "../grpc-client";
import { AwishNotConnectedError, awishSourceOf, linkedMachines } from "../marketing";
import { DEFAULT_AWISH_SIGN_MODE, isAwishSignMode, type AwishSignMode } from "../sign";
import { readCredentials } from "../sync";
import type { AwishWebApi, AwishWebClientOptions } from "../web-client";
import { createAwishControlClient } from "./client";
import {
  chosenEndpoint,
  controlEndpointConfig,
  endpointAddress,
  probeEndpoint,
  type ControlConnect,
  type ControlEndpointConfig,
  type ControlEndpointKind,
} from "./endpoint";
import { ensureApiState, updateApiState } from "./state";
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
  /** Webbpanelens klient (fackskrivaren och reserven för påfyllning). */
  makeWebClient?: (options: AwishWebClientOptions) => AwishWebApi;
  webClientOptions?: AwishWebClientOptions;
}

export const defaultControlConnect: ControlConnect = (creds, cfg) =>
  createAwishControlClient(creds, cfg);

/** Signeringsläget: miljön, sedan det sparade, sedan standard. */
export function signModeFor(
  state: Pick<AwishApiState, "signMode"> | null,
  env: Record<string, string | undefined> = process.env,
): AwishSignMode {
  const fromEnv = env.AWISH_SIGN_MODE?.trim();
  if (isAwishSignMode(fromEnv)) return fromEnv;
  return state?.signMode ?? DEFAULT_AWISH_SIGN_MODE;
}

export interface ControlContext {
  db: Db;
  orgId: string;
  sourceId: string;
  creds: AwishCredentials;
  state: AwishApiState;
  endpointConfig: ControlEndpointConfig;
  connect: ControlConnect;
  signMode: AwishSignMode;
  /** Adressen nu (null = ingen fungerar). */
  endpoint: ControlEndpointKind | null;
  env: Record<string, string | undefined>;
}

/**
 * Källa, inloggning och läge för organisationen. I auto utan sparad anslutning provas
 * TLS och sedan den okrypterade (Version) och resultatet sparas.
 */
export async function controlContextFor(
  db: Db,
  orgId: string,
  deps: ControlDeps = {},
): Promise<ControlContext> {
  const source = await awishSourceOf(db, orgId);
  if (!source) throw new AwishNotConnectedError();
  const creds = await readCredentials(db, source);
  if (!creds) {
    throw new AwishNotConnectedError("Spara AppId, AppSecret och AppKey under Datakällor.");
  }
  const env = deps.env ?? process.env;
  let state = await ensureApiState(db, orgId, source.id);
  const endpointConfig = controlEndpointConfig(env);
  const connect = deps.connect ?? defaultControlConnect;
  const signMode = signModeFor(state, env);
  let endpoint = chosenEndpoint(endpointConfig, state.endpoint);
  if (endpoint === null) {
    const probe = await probeEndpoint(creds, endpointConfig, connect, signMode);
    const now = deps.now?.() ?? new Date();
    await updateApiState(db, orgId, source.id, {
      endpoint: probe.endpoint,
      endpointCheckedAt: now,
      endpointError: probe.error,
    });
    endpoint = probe.endpoint;
    state = { ...state, endpoint: probe.endpoint, endpointCheckedAt: now };
  }
  return {
    db,
    orgId,
    sourceId: source.id,
    creds,
    state,
    endpointConfig,
    connect,
    signMode,
    endpoint,
    env,
  };
}

/** En klient i kontextens läge (eller ett annat signeringsläge, för "Testa signering"). */
export function apiFor(
  ctx: ControlContext,
  signMode: AwishSignMode = ctx.signMode,
): AwishControlApi {
  // Nås ingen adress används den okrypterade: anropet ger då ett tydligt fel.
  const { address, tls } = endpointAddress(ctx.endpoint ?? "plain", ctx.endpointConfig);
  return ctx.connect(ctx.creds, { address, tls, signMode });
}

export async function controlClientFor(
  db: Db,
  orgId: string,
  deps: ControlDeps = {},
): Promise<{ api: AwishControlApi; sourceId: string; state: AwishApiState }> {
  const ctx = await controlContextFor(db, orgId, deps);
  return { api: apiFor(ctx), sourceId: ctx.sourceId, state: ctx.state };
}

/** Awishs id för en Binderlab-automat (kopplad i källan), eller null. */
export async function awishMachineIdFor(
  db: Db,
  orgId: string,
  machineId: string,
): Promise<string | null> {
  const linked = await linkedMachines(db, orgId);
  return linked.find((m) => m.machineId === machineId)?.awishMachineId ?? null;
}
