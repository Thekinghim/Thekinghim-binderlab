/**
 * Vilken av Awishs två adresser styrningen använder:
 *
 *   tls   grpc.awish.vip:443 (HTTP/2 med TLS; appid och token krypteras)
 *   plain 49.51.72.74:50051 (okrypterad, reserv; samma som synken använder i dag)
 *
 * AWISH_CONTROL_ENDPOINT = auto (standard) | tls | plain. I auto används den anslutning
 * som sparats (awish_api_state.endpoint). Finns ingen provas bara TLS (Version). Den
 * okrypterade väljs aldrig av sig själv: appid är både inloggning och signeringsnyckel, och
 * någon på vägen kan blockera TLS för att tvinga fram klartext. En ägare eller admin väljer
 * den själv under Datakällor (Använd okrypterad), eller så låses den i miljön (plain).
 * En skrivning byter aldrig adress mitt i ett anrop. Inloggningen är densamma.
 *
 * Synken och kampanjerna använder fortfarande awishClientConfigFromEnv (AWISH_GRPC_ADDRESS,
 * AWISH_GRPC_TLS); se docs/awish-api.md för när de byts till TLS.
 */

import { AwishApiError, DEFAULT_AWISH_GRPC_ADDRESS, type AwishCredentials } from "../grpc-client";
import type { AwishSignFields } from "../proto-doc-fields";
import type { AwishSignMode } from "../sign";
import { controlErrorMessage } from "./errors";
import type { AwishControlApi } from "./types";

export type ControlEndpointMode = "auto" | "tls" | "plain";
export type ControlEndpointKind = "tls" | "plain";

export const DEFAULT_AWISH_GRPC_TLS_ADDRESS = "grpc.awish.vip:443";

export interface ControlEndpointConfig {
  mode: ControlEndpointMode;
  tlsAddress: string;
  plainAddress: string;
}

export function controlEndpointConfig(
  env: Record<string, string | undefined> = process.env,
): ControlEndpointConfig {
  const raw = (env.AWISH_CONTROL_ENDPOINT ?? "auto").trim().toLowerCase();
  const mode: ControlEndpointMode = raw === "tls" || raw === "plain" ? raw : "auto";
  return {
    mode,
    tlsAddress: env.AWISH_GRPC_TLS_ADDRESS?.trim() || DEFAULT_AWISH_GRPC_TLS_ADDRESS,
    plainAddress: env.AWISH_GRPC_ADDRESS?.trim() || DEFAULT_AWISH_GRPC_ADDRESS,
  };
}

export function endpointAddress(
  kind: ControlEndpointKind,
  cfg: ControlEndpointConfig,
): { address: string; tls: boolean } {
  return kind === "tls"
    ? { address: cfg.tlsAddress, tls: true }
    : { address: cfg.plainAddress, tls: false };
}

/**
 * Adressen att använda nu: tvingad av miljön, annars den som sparats. null = auto utan
 * sparat resultat (provas med probeEndpoint).
 */
export function chosenEndpoint(
  cfg: ControlEndpointConfig,
  recorded: ControlEndpointKind | null,
): ControlEndpointKind | null {
  if (cfg.mode !== "auto") return cfg.mode;
  return recorded;
}

export type ControlConnect = (
  creds: AwishCredentials,
  cfg: { address: string; tls: boolean; signMode: AwishSignMode; signFields?: AwishSignFields },
) => AwishControlApi;

export interface EndpointProbe {
  endpoint: ControlEndpointKind | null;
  version: string | null;
  /** Svenskt fel när adressen inte fungerade. */
  error: string | null;
}

/** Fel som betyder att adressen inte går att nå (inte att Awish sa nej). */
function unreachable(error: unknown): boolean {
  return (
    error instanceof AwishApiError && (error.kind === "unavailable" || error.kind === "timeout")
  );
}

/** Awish svarade men skickade ingen version vi känner igen: adressen fungerar ändå. */
function answeredWithoutVersion(error: unknown): boolean {
  return error instanceof AwishApiError && error.kind === "changed" && error.grpcCode === null;
}

export const TLS_LOST_MESSAGE =
  "TLS har fungerat förut men svarar inte nu. Vi byter inte till okrypterad av oss själva.";

export const TLS_UNREACHABLE_MESSAGE =
  "TLS svarar inte. Vi byter inte till okrypterad av oss själva (appid, som också signerar, går då i klartext).";

/** Felen som betyder att TLS inte svarar och att ägaren kan välja okrypterad. */
export function isTlsLostError(error: string | null): boolean {
  return error === TLS_LOST_MESSAGE || error === TLS_UNREACHABLE_MESSAGE;
}

/**
 * Provar adressen med Version (en osignerad läsning). I auto provas bara TLS: den okrypterade
 * väljs aldrig av sig själv (se filens kommentar). Ett inloggningsfel på TLS betyder att TLS
 * fungerar (Awish svarade) men uppgifterna är fel. Ett svar utan igenkänd version räknas som
 * att adressen fungerar (version null).
 *
 * `tlsWorkedBefore`: bara för texten när TLS inte svarar.
 */
export async function probeEndpoint(
  creds: AwishCredentials,
  cfg: ControlEndpointConfig,
  connect: ControlConnect,
  signMode: AwishSignMode,
  opts: { tlsWorkedBefore?: boolean } = {},
): Promise<EndpointProbe> {
  const kind: ControlEndpointKind = cfg.mode === "auto" ? "tls" : cfg.mode;
  const api = connect(creds, { ...endpointAddress(kind, cfg), signMode });
  try {
    const version = await api.version();
    return { endpoint: kind, version, error: null };
  } catch (error) {
    if (answeredWithoutVersion(error)) return { endpoint: kind, version: null, error: null };
    if (cfg.mode === "auto" && unreachable(error)) {
      return {
        endpoint: null,
        version: null,
        error: opts.tlsWorkedBefore ? TLS_LOST_MESSAGE : TLS_UNREACHABLE_MESSAGE,
      };
    }
    return { endpoint: null, version: null, error: controlErrorMessage(error) };
  } finally {
    api.close();
  }
}
