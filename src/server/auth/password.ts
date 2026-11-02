/**
 * Lösenordshashar för dev-inloggningen (auth.users.encrypted_password i den
 * lokala auth-shimmen). Supabase hashar själv i preview och production.
 *
 * Format: "scrypt$N$r$p$saltBase64$hashBase64" med node:crypto scrypt,
 * N=16384, r=8, p=1, 64 byte nyckel och 16 byte salt. Jämförelsen är
 * timingsäker.
 */

import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

export const SCRYPT_PARAMS = { N: 16384, r: 8, p: 1, keyLength: 64, saltLength: 16 } as const;

/** Övre gränser när en lagrad hash tolkas, så att en manipulerad rad inte kan låsa servern. */
const MAX_N = 1 << 20;
const MAX_R = 32;
const MAX_P = 16;
const MAX_PASSWORD_LENGTH = 1024;

export const MIN_PASSWORD_LENGTH = 12;

function scryptAsync(
  password: string,
  salt: Buffer,
  keyLength: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keyLength, options, (error, key) => {
      if (error) {
        reject(error);
      } else {
        resolve(key);
      }
    });
  });
}

function memoryFor(N: number, r: number, p: number): number {
  // scrypt behöver ungefär 128 · N · r · p byte; dubbelt för marginal.
  return 256 * N * r * p + 1024 * 1024;
}

/** Svenskt felmeddelande om lösenordet inte duger, annars null. */
export function validateNewPassword(password: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) {
    return `Lösenordet måste ha minst ${MIN_PASSWORD_LENGTH} tecken.`;
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    return "Lösenordet är för långt.";
  }
  if (password.trim() === "") {
    return "Lösenordet får inte bara bestå av mellanslag.";
  }
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  if (password.length === 0 || password.length > MAX_PASSWORD_LENGTH) {
    throw new RangeError("Ogiltig lösenordslängd.");
  }
  const { N, r, p, keyLength, saltLength } = SCRYPT_PARAMS;
  const salt = randomBytes(saltLength);
  const hash = await scryptAsync(password, salt, keyLength, { N, r, p, maxmem: memoryFor(N, r, p) });
  return ["scrypt", N, r, p, salt.toString("base64"), hash.toString("base64")].join("$");
}

interface ParsedHash {
  N: number;
  r: number;
  p: number;
  salt: Buffer;
  hash: Buffer;
}

const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

function parsePositiveInt(value: string | undefined, max: number): number | null {
  if (value === undefined || !/^[1-9][0-9]{0,7}$/.test(value)) {
    return null;
  }
  const n = Number.parseInt(value, 10);
  return Number.isSafeInteger(n) && n <= max ? n : null;
}

export function parsePasswordHash(stored: string): ParsedHash | null {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") {
    return null;
  }
  const N = parsePositiveInt(parts[1], MAX_N);
  const r = parsePositiveInt(parts[2], MAX_R);
  const p = parsePositiveInt(parts[3], MAX_P);
  const saltText = parts[4] ?? "";
  const hashText = parts[5] ?? "";
  if (N === null || r === null || p === null || N < 2 || (N & (N - 1)) !== 0) {
    return null;
  }
  if (!BASE64.test(saltText) || !BASE64.test(hashText)) {
    return null;
  }
  const salt = Buffer.from(saltText, "base64");
  const hash = Buffer.from(hashText, "base64");
  if (salt.length < 8 || hash.length !== SCRYPT_PARAMS.keyLength) {
    return null;
  }
  return { N, r, p, salt, hash };
}

/** En giltig hash för ett slumpat lösenord, så att okända användare tar lika lång tid. */
let dummyHash: Promise<string> | undefined;

function getDummyHash(): Promise<string> {
  dummyHash ??= hashPassword(randomBytes(32).toString("base64"));
  return dummyHash;
}

/**
 * Jämför ett lösenord med en lagrad hash. `stored = null` (okänd användare
 * eller konto utan lösenord) räknas mot en dummyhash så att svarstiden inte
 * avslöjar om kontot finns. Returnerar aldrig true för en ogiltig hash.
 */
export async function verifyPassword(password: string, stored: string | null): Promise<boolean> {
  const parsed = stored === null ? null : parsePasswordHash(stored);
  const target = parsed ?? parsePasswordHash(await getDummyHash());
  if (!target) {
    return false;
  }
  const candidatePassword = password.length > MAX_PASSWORD_LENGTH ? "" : password;
  const candidate = await scryptAsync(candidatePassword, target.salt, target.hash.length, {
    N: target.N,
    r: target.r,
    p: target.p,
    maxmem: memoryFor(target.N, target.r, target.p),
  });
  const equal = timingSafeEqual(candidate, target.hash);
  return equal && parsed !== null && password.length > 0 && password.length <= MAX_PASSWORD_LENGTH;
}
