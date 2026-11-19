/**
 * Kan appen skicka riktiga mejl härifrån? En fråga, ett svar, för både larm och rapporter.
 *
 *   resend, inställt                        → ja
 *   resend, nyckel eller avsändare saknas   → nej
 *   utkorg lokalt (utveckling och tester)   → ja (skrivs till disk, lämnar inte maskinen)
 *   utkorg på Vercel                        → nej: filsystemet går inte att skriva till,
 *                                             så utskicket misslyckas varje gång
 *
 * Utan ett ja får e-post aldrig visas som en kanal som fungerar, och inget får stå som
 * skickat med e-post. Ren modul.
 */

import { mailerStatus } from "@/server/mail/report-mailer";

type Env = Readonly<Record<string, string | undefined>>;

/** Texten som visas överallt där e-post erbjuds men inte kan skickas. */
export const MAIL_OFF_TEXT = "E-post är inte påslagen";

export function mailCanSend(env: Env = process.env): boolean {
  const status = mailerStatus(env);
  if (!status.configured) return false;
  if (status.kind === "resend") return true;
  return !env.VERCEL;
}
