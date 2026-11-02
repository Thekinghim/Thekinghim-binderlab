/**
 * Genererade hemligheter. Inget här skrivs ut; anroparen registrerar
 * värdena i loggerns maskning (`log.secret`).
 */

import { createHash, createHmac, pbkdf2Sync, randomBytes } from "node:crypto";

/** Starkt lösenord, bara URL-säkra tecken (A–Z a–z 0–9 - _), 43 tecken. */
export function generatePassword(): string {
  return randomBytes(32).toString("base64url");
}

/** CRON_SECRET: 48 slumpbytes, base64url (64 tecken). */
export function generateCronSecret(): string {
  return randomBytes(48).toString("base64url");
}

/** Kort, icke reversibel fingeravtryck av ett värde (för idempotenskontroll). */
export function fingerprint(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex").slice(0, 16);
}

/**
 * SCRAM-SHA-256-verifierare i Postgres format (RFC 5802/7677):
 * `SCRAM-SHA-256$<iter>:<salt>$<StoredKey>:<ServerKey>`. Med den kan
 * lösenordet bytas med `alter role … password '<verifierare>'` utan att
 * klartexten finns i SQL:en eller i databasens loggar.
 *
 * Lösenordet måste vara ASCII utan kontrolltecken (SASLprep blir då en
 * identitet); `generatePassword()` uppfyller det.
 */
export function scramSha256Verifier(
  password: string,
  salt: Buffer = randomBytes(16),
  iterations = 4096,
): string {
  if (!/^[\x21-\x7e]+$/.test(password)) {
    throw new Error("Lösenordet måste vara synliga ASCII-tecken (SASLprep stöds inte här).");
  }
  const salted = pbkdf2Sync(password, salt, iterations, 32, "sha256");
  const clientKey = createHmac("sha256", salted).update("Client Key").digest();
  const storedKey = createHash("sha256").update(clientKey).digest();
  const serverKey = createHmac("sha256", salted).update("Server Key").digest();
  return `SCRAM-SHA-256$${iterations}:${salt.toString("base64")}$${storedKey.toString("base64")}:${serverKey.toString("base64")}`;
}

export interface VapidKeys {
  publicKey: string;
  privateKey: string;
}

/** VAPID-nycklar för Web Push (samma som `npx web-push generate-vapid-keys`). */
export async function generateVapidKeys(): Promise<VapidKeys> {
  const mod = (await import("web-push")) as unknown as {
    generateVAPIDKeys?: () => VapidKeys;
    default?: { generateVAPIDKeys: () => VapidKeys };
  };
  const generate = mod.generateVAPIDKeys ?? mod.default?.generateVAPIDKeys;
  if (!generate) throw new Error("web-push saknar generateVAPIDKeys.");
  return generate();
}
