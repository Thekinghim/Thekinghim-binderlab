/**
 * Vilken av Awishs två adresser styrningen använder:
 *
 *   tls   grpc.awish.vip:443 (HTTP/2 med TLS; appid och token krypteras)
 *   plain 49.51.72.74:50051 (okrypterad, reserv; samma som synken använder i dag)
 *
 * AWISH_CONTROL_ENDPOINT = auto (standard) | tls | plain. I auto används den anslutning
 * som senast fungerade (awish_api_state.endpoint). Finns ingen provas TLS först med Version;
 * svarar TLS inte provas den okrypterade, och resultatet sparas. En skrivning byter aldrig
 * adress mitt i ett anrop. Inloggningen är densamma (appid och token i metadata).
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
  /** Svenskt fel när ingen fungerade (eller TLS:s fel när den okrypterade fick ta över). */
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

/**
 * Provar adresserna med Version (en osignerad läsning). I auto: TLS först, sedan den
 * okrypterade om TLS inte går att nå. Ett inloggningsfel på TLS betyder att TLS fungerar
 * (Awish svarade) men uppgifterna är fel; då provas inte den okrypterade. Ett svar utan
 * igenkänd version räknas som att adressen fungerar (version null).
 *
 * `noDowngrade`: TLS har fungerat för organisationen. Då provas den okrypterade inte när
 * TLS slutar svara (någon på vägen kan blockera TLS för att tvinga fram okrypterat, och
 * appid, som också är signeringsnyckeln, går då i klartext). En ägare eller admin får välja
 * okrypterad själv under Datakällor.
 */
export async function probeEndpoint(
  creds: AwishCredentials,
  cfg: ControlEndpointConfig,
  connect: ControlConnect,
  signMode: AwishSignMode,
  opts: { noDowngrade?: boolean } = {},
): Promise<EndpointProbe> {
  const order: ControlEndpointKind[] =
    cfg.mode === "auto"
      ? opts.noDowngrade
        ? ["tls"]
        : ["tls", "plain"]
      : [cfg.mode as ControlEndpointKind];
  let firstError: string | null = null;
  for (const kind of order) {
    const api = connect(creds, { ...endpointAddress(kind, cfg), signMode });
    try {
      const version = await api.version();
      return { endpoint: kind, version, error: firstError };
    } catch (error) {
      if (answeredWithoutVersion(error))
        return { endpoint: kind, version: null, error: firstError };
      const message = controlErrorMessage(error);
      firstError ??= kind === "tls" ? `TLS: ${message}` : message;
      if (!unreachable(error)) return { endpoint: null, version: null, error: message };
    } finally {
      api.close();
    }
  }
  if (cfg.mode === "auto" && opts.noDowngrade) {
    return { endpoint: null, version: null, error: TLS_LOST_MESSAGE };
  }
  return { endpoint: null, version: null, error: firstError };
}
