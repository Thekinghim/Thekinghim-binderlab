/**
 * Signering av Awish-skrivningar (HMAC-SHA256, v1.2.40+).
 *
 * STUBB: typerna följer designen (§1). Paket P1 skriver modulen; filen ersätts då.
 */

export type AwishSignMode = "present_sorted" | "full_sorted" | "present_proto_order";

export const AWISH_SIGN_TOLERANCE_S = 300;
