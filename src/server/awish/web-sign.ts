/**
 * Signering för Awish webbpanel (dash.awish.vip). Två sorter, båda panelens egna:
 *
 *  A. Base64 + MD5 (den här första delen): inloggningen (Signin) och läsningen av fack
 *     (Products) skickar en base64-kodad JSON-sträng med ett `sign`-fält.
 *  B. HMAC-SHA256 på indata-objektet (längre ner, sedan panelen 1.30.5): alla skrivningar
 *     (CreateGood, UpdateGood, UpdateProduct) får fälten `timestamp` och `sign`.
 *
 * Del A: panelen skickar anropet som en
 * base64-kodad JSON-sträng med ett `sign`-fält, och servern räknar fram samma `sign` och
 * jämför. Det här är samma uträkning som panelens egen kod (klassen som konstrueras med
 * appKey), återskapad så att Binderlab kan skicka påfyllningar till Awish utan att gå in
 * på deras sida. Ren funktion: ingen nätverk, ingen klocka (tiden skickas in), så den går
 * att testa exakt.
 *
 * Reglerna, i ordning:
 *  - Platta ut objektet: nycklar blir `nyckel`, objekt blir `nyckel[undernyckel]`, listor
 *    blir `nyckel[index]`, rekursivt.
 *  - Hoppa över värden som är "" eller "NULL" (fältet `sign` tas alltid bort först).
 *  - Varje kvarvarande värde blir `nyckel=encodeURI(värde)`.
 *  - Sortera raderna (vanlig JS-strängsortering), slå ihop med "&", och encodeURI:a hela.
 *  - Lägg till `&key=<appKey>` och ta MD5 som versaler hex.
 */

import { createHash, createHmac, timingSafeEqual } from "node:crypto";

type Json = string | number | boolean | null | Json[] | { [k: string]: Json };

/** Awishs standard-appKey/appid för webbpanelen (publikt i panelens egen kod). */
export const AWISH_WEB_APP_KEY = "dsc6805f597d8c411e";

function flatten(prefix: string, value: Json, out: string[]): void {
  if (typeof value === "object" && value !== null) {
    if (Array.isArray(value)) {
      value.forEach((v, i) => flatten(`${prefix}[${i}]`, v, out));
    } else {
      // Panelen använder Object.keys-ordningen; sorteringen sker ändå efteråt.
      for (const key of Object.keys(value)) flatten(`${prefix}[${key}]`, value[key]!, out);
    }
    return;
  }
  const str = value === null ? "null" : String(value);
  if (str === "" || str === "NULL") return;
  out.push(`${prefix}=${encodeURI(str)}`);
}

/** MD5-signaturen (versaler hex) för ett objekt, utan fältet `sign`. */
export function awishSignature(payload: Record<string, Json>, appKey: string): string {
  const copy: Record<string, Json> = { ...payload };
  delete copy.sign;
  const parts: string[] = [];
  for (const key of Object.keys(copy)) flatten(key, copy[key]!, parts);
  parts.sort();
  const joined = encodeURI(parts.join("&"));
  const withKey = `${joined}&key=${appKey}`;
  return createHash("md5").update(withKey, "utf8").digest("hex").toUpperCase();
}

/**
 * Kodar ett objekt som panelen gör: lägg till `timestamp` (sekunder) om det saknas, lägg
 * till `sign`, JSON-koda och base64:a. `nowMs` skickas in för testbarhetens skull.
 */
export function awishEncode(payload: Record<string, Json>, appKey: string, nowMs: number): string {
  const withTs: Record<string, Json> =
    "timestamp" in payload
      ? { ...payload }
      : { ...payload, timestamp: Math.ceil(nowMs / 1000).toString() };
  const signed: Record<string, Json> =
    "sign" in withTs ? withTs : { ...withTs, sign: awishSignature(withTs, appKey) };
  return Buffer.from(JSON.stringify(signed), "utf8").toString("base64");
}

/** Avkodar en base64-sträng från panelen tillbaka till objekt (för tester och svar). */
export function awishDecode(encoded: string): Record<string, Json> {
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Record<string, Json>;
}

/** Sant om `sign` i objektet stämmer med uträkningen. Används av låtsas-servern i tester. */
export function awishCheckSignature(payload: Record<string, Json>, appKey: string): boolean {
  const given = typeof payload.sign === "string" ? payload.sign : "";
  return given.length > 0 && awishSignature(payload, appKey) === given;
}

/* ------------------------------------------------------------------------------------------
 * Ny signering (panelen 1.30.5): HMAC-SHA256 på skrivningarnas indata.
 *
 * Sedan panelen 1.30.5 signerar panelen själva indata-objektet i mutationerna (CreateGood,
 * UpdateGood, UpdateProduct med flera) och lägger till två fält i samma objekt: `timestamp`
 * (Int!, sekunder) och `sign` (String, 64 hex-tecken, gemener). Utan dem svarar Awish
 * `field "timestamp" of type "Int!" is required but not provided`.
 *
 * Uträkningen är panelens egen (wasm-modulen hmac_signer, klassen HmacSha256Signer som
 * konstrueras med appKey), läst ur modulens kod instruktion för instruktion:
 *
 *   1. JSON.stringify(indata) och tolka tillbaka (undefined-fält försvinner, NaN blir null).
 *   2. Ta bort fälten `timestamp` och `sign` på översta nivån (bara där).
 *   3. Skriv objektet som kanonisk JSON enligt RFC 8785 (JCS): nycklarna sorterade på alla
 *      nivåer, listor i sin ordning, inga mellanslag, tal som JavaScript skriver dem (79.5,
 *      79, 0), strängar som JSON.stringify skriver dem (å, ä, ö och emoji som de är i UTF-8).
 *   4. sign = hex(HMAC-SHA256(nyckel = appKey, text = "<timestamp>.<kanonisk JSON>")).
 *   5. timestamp = Math.trunc(Date.now() / 1000) om ingen tid skickas in.
 *
 * Rena funktioner: klockan skickas in, så att de går att prova exakt.
 * ---------------------------------------------------------------------------------------- */

/** Fälten som signeringen lägger till i indata-objektet. */
export interface AwishInputSignature {
  /** Sekunder sedan 1970 (GraphQL Int!). */
  timestamp: number;
  /** HMAC-SHA256 som 64 hex-tecken, gemener. */
  sign: string;
}

/** Hur gammal eller ny en tidsstämpel får vara (sekunder) i låtsas-panelens kontroll. */
export const AWISH_SIGN_WINDOW_SECONDS = 300;

function canonical(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") {
    // Panelens signerare nekar ensamma surrogat-tecken (trasig text); gör likadant.
    if (!value.isWellFormed()) throw new Error("Texten innehåller ett ogiltigt tecken.");
    return JSON.stringify(value);
  }
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    // Vanlig JS-sortering jämför UTF-16-kodenheter, som RFC 8785 föreskriver.
    const parts = Object.keys(obj)
      .sort()
      .map((k) => `${canonical(k)}:${canonical(obj[k])}`);
    return `{${parts.join(",")}}`;
  }
  throw new Error("Värdet går inte att signera.");
}

/**
 * Kanonisk JSON (RFC 8785) av ett värde, efter en vända genom JSON.stringify som i panelen.
 * `timestamp` och `sign` på översta nivån tas INTE bort här; se awishSignedBody.
 */
export function awishCanonicalJson(value: unknown): string {
  const text = JSON.stringify(value);
  if (text === undefined) throw new Error("Värdet går inte att signera.");
  return canonical(JSON.parse(text));
}

/** Texten som signeras för ett indata-objekt: kanonisk JSON utan `timestamp` och `sign`. */
export function awishSignedBody(input: Record<string, unknown>): string {
  const text = JSON.stringify(input);
  const parsed: unknown = text === undefined ? undefined : JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    return canonical(parsed ?? null);
  }
  const rest: Record<string, unknown> = { ...(parsed as Record<string, unknown>) };
  delete rest.timestamp;
  delete rest.sign;
  return canonical(rest);
}

/** HMAC-signaturen för ett indata-objekt vid en given tid (sekunder). */
export function awishHmacSignature(
  input: Record<string, unknown>,
  appKey: string,
  timestampSeconds: number,
): string {
  if (!Number.isSafeInteger(timestampSeconds)) throw new Error("Ogiltig tid för signeringen.");
  return createHmac("sha256", appKey)
    .update(`${timestampSeconds}.${awishSignedBody(input)}`, "utf8")
    .digest("hex");
}

/** Det panelens `sign(obj)` svarar med: `{ timestamp, sign }` för klockan `nowMs`. */
export function awishSignFields(
  input: Record<string, unknown>,
  appKey: string,
  nowMs: number,
): AwishInputSignature {
  const timestamp = Math.trunc(nowMs / 1000);
  return { timestamp, sign: awishHmacSignature(input, appKey, timestamp) };
}

/** Indata som panelen skickar det: `{ ...input, timestamp, sign }`. */
export function awishSignInput<T extends object>(
  input: T,
  appKey: string,
  nowMs: number,
): T & AwishInputSignature {
  return { ...input, ...awishSignFields(input as Record<string, unknown>, appKey, nowMs) };
}

/**
 * Kontrollerar ett signerat indata-objekt som en server skulle göra. Används av
 * låtsas-panelen i testerna. Svarar med felet som text, eller null när allt stämmer.
 */
export function awishVerifyInput(
  signed: object,
  appKey: string,
  nowMs: number,
  windowSeconds: number = AWISH_SIGN_WINDOW_SECONDS,
): string | null {
  const input = signed as Record<string, unknown>;
  const { timestamp, sign } = input;
  if (typeof timestamp !== "number" || !Number.isSafeInteger(timestamp)) {
    return "timestamp is required";
  }
  if (typeof sign !== "string" || !/^[0-9a-f]{64}$/.test(sign)) {
    return "invalid signature format: expected hexadecimal";
  }
  if (Math.abs(Math.trunc(nowMs / 1000) - timestamp) > windowSeconds) {
    return "signature verify failed, timestamp is out of time window";
  }
  const expected = Buffer.from(awishHmacSignature(input, appKey, timestamp), "hex");
  const given = Buffer.from(sign, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) {
    return "signature verification failed: signature mismatch";
  }
  return null;
}
