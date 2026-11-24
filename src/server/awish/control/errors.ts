/**
 * Fel från styrningen via Awishs API som klar svenska. Signeringsfel och tidsfel avgörs
 * före mapGrpcError: där blir "invalid signature" annars ett inloggningsfel ("AppSecret
 * eller AppKey stämmer inte"), vilket är fel för en signerad skrivning.
 *
 * En skrivning som skickats men inte fått svar (tidsgränsen, eller förbindelsen bröts) har
 * ett okänt utfall: Awish kan ha gjort det. Den provas aldrig igen automatiskt.
 */

import * as grpc from "@grpc/grpc-js";

import { AwishApiError, mapGrpcError } from "../grpc-client";
import { AwishNotConnectedError } from "../marketing";

export const SIGN_FAILED_MESSAGE =
  "Awish godkände inte signaturen. Testa under Datakällor → Awish API.";
export const CLOCK_MESSAGE = "Awish tyckte att klockan var fel. Försök igen om en minut.";
export const OFFLINE_MESSAGE = "Automaten är offline. Det går bara när den är online.";
export const UNSUPPORTED_MESSAGE = "Automaten stöder inte det här.";
export const UNKNOWN_OUTCOME_MESSAGE =
  "Vi vet inte om Awish fick det. Titta på automaten innan du försöker igen.";
export const UNAVAILABLE_MESSAGE = "Awish svarar inte just nu. Försök igen om en stund.";

/** Indata som inte går att skicka (fel id, fel tid). Inget anrop gjordes. */
export class AwishControlInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AwishControlInputError";
  }
}

/** Skrivningen skickades men svaret uteblev: Awish kan ha gjort det. */
export class AwishUnknownOutcomeError extends AwishApiError {
  constructor(grpcCode: number | null, technical: string | null) {
    super("timeout", UNKNOWN_OUTCOME_MESSAGE, grpcCode, technical);
    this.name = "AwishUnknownOutcomeError";
  }
}

/** Signeringen nekades (fel nyckel, fel request_body eller fel format). */
export function isSignError(error: unknown): boolean {
  return error instanceof AwishApiError && error.message === SIGN_FAILED_MESSAGE;
}

const SIGN = /sign(ature)?( verify)? failed|invalid sign|expected hexadecimal|hmac/i;
const WINDOW = /time window|timestamp/i;
const OFFLINE = /offline|not online/i;
const UNSUPPORTED = /not support/i;
/** Förbindelsen kom aldrig upp: anropet skickades inte. */
const NOT_SENT =
  /no connection established|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|name resolution|failed to connect/i;

function clean(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

/**
 * Gör ett fel från ett styranrop till AwishApiError (svenska, inga hemligheter). `write`:
 * skrivningar får "okänt utfall" vid tidsgräns eller bruten förbindelse.
 */
export function mapControlError(
  error: unknown,
  address: string,
  opts: { write?: boolean } = {},
): AwishApiError {
  if (error instanceof AwishApiError) return error;
  const e = (error && typeof error === "object" ? error : {}) as Record<string, unknown>;
  const code = typeof e.code === "number" ? e.code : null;
  const details = typeof e.details === "string" ? e.details : String(e.message ?? "");
  const technical = clean(details) || null;

  if (code === grpc.status.DEADLINE_EXCEEDED) {
    return opts.write
      ? new AwishUnknownOutcomeError(code, technical)
      : new AwishApiError("timeout", "Awish svarade inte i tid. Försök igen.", code, technical);
  }
  if (code === grpc.status.UNAVAILABLE || code === grpc.status.CANCELLED) {
    if (opts.write && !NOT_SENT.test(details)) return new AwishUnknownOutcomeError(code, technical);
    return new AwishApiError("unavailable", UNAVAILABLE_MESSAGE, code, technical);
  }
  // Tidsfönstret först: Awishs text är "signature verify failed, timestamp is out of time window".
  if (WINDOW.test(details) && /window|expired|out of/i.test(details)) {
    return new AwishApiError("server", CLOCK_MESSAGE, code, technical);
  }
  if (SIGN.test(details)) return new AwishApiError("changed", SIGN_FAILED_MESSAGE, code, technical);
  if (WINDOW.test(details)) return new AwishApiError("server", CLOCK_MESSAGE, code, technical);
  if (OFFLINE.test(details)) return new AwishApiError("server", OFFLINE_MESSAGE, code, technical);
  if (UNSUPPORTED.test(details)) {
    return new AwishApiError("server", UNSUPPORTED_MESSAGE, code, technical);
  }
  const mapped = mapGrpcError(error, address);
  return new AwishApiError(mapped.kind, mapped.message, mapped.grpcCode, technical);
}

/** Ett svenskt meddelande för vilket fel som helst (aldrig rå feltext eller hemligheter). */
export function controlErrorMessage(error: unknown): string {
  if (error instanceof AwishApiError) return error.message;
  if (error instanceof AwishNotConnectedError) return error.message;
  if (error instanceof AwishControlInputError) return error.message;
  return "Något gick fel mot Awish. Försök igen.";
}
