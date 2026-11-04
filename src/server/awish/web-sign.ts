/**
 * Signering för Awish webbpanel (dash.awish.vip). Panelen skickar varje anrop som en
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

import { createHash } from "node:crypto";

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
