/**
 * Lokal "brevlåda" för dev-inloggningen: mejl skrivs som .eml-filer i
 * .data/mail (gitignorerad) och sökvägen loggas. Öppna filen i valfri
 * e-postklient eller läs den som text.
 */

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

export function defaultMailDir(): string {
  return path.resolve(process.cwd(), ".data", "mail");
}

export interface DevMail {
  to: string;
  subject: string;
  text: string;
}

/** RFC 2047-kodning av rubriker med icke-ASCII-tecken (å, ä, ö). */
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function assertHeaderSafe(value: string, label: string): void {
  if (/[\r\n]/.test(value)) {
    throw new TypeError(`${label} får inte innehålla radbrytningar.`);
  }
}

/** Skriver mejlet och returnerar sökvägen till .eml-filen. */
export async function writeDevMail(mail: DevMail, dir = defaultMailDir()): Promise<string> {
  assertHeaderSafe(mail.to, "Mottagaren");
  assertHeaderSafe(mail.subject, "Ämnesraden");
  const now = new Date();
  const id = `${now.toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
  const body = [
    `From: Binderlab <noreply@binderlab.local>`,
    `To: ${mail.to}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Date: ${now.toUTCString()}`,
    `Message-ID: <${id}@binderlab.local>`,
    "MIME-Version: 1.0",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: 8bit",
    "",
    mail.text.replace(/\r?\n/g, "\r\n"),
    "",
  ].join("\r\n");
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.eml`);
  await writeFile(file, body, { encoding: "utf8", flag: "wx" });
  return file;
}
