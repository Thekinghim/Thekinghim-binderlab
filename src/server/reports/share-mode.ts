/**
 * Dela-läget på Rapporter: när appen inte kan skicka riktiga mejl delar ägaren rapporten
 * själv (iPhones dela-meny) och markerar den som skickad. Ren modul.
 *
 *   resend, inställt                  → mejl (false)
 *   resend, nyckel eller avsändare
 *   saknas                            → dela (true)
 *   utkorg, uttryckligen vald
 *   (MAIL_PROVIDER=outbox) lokalt     → mejl till utkorgen (false): utveckling och tester
 *   utkorg annars (inget valt, eller
 *   på Vercel där utkorgen försvinner) → dela (true)
 */

import { mailerStatus } from "@/server/mail/report-mailer";

type Env = Readonly<Record<string, string | undefined>>;

export function reportShareMode(env: Env = process.env): boolean {
  const status = mailerStatus(env);
  if (status.kind === "resend") return !status.configured;
  if (!status.configured) return true;
  const chosen = env.MAIL_PROVIDER?.trim().toLowerCase() === "outbox";
  return !chosen || Boolean(env.VERCEL);
}

export type ShareReportType = "butik" | "bokforing" | "delagare";

/**
 * Rubriken i dela-läget: "Oktober-rapporten till Sega gubben är klar." `label` är månaden
 * ("oktober") eller ett eget datum ("15–31 okt. 2026"), `custom` säger vilket.
 */
export function shareHeadline(input: {
  readonly type: ShareReportType;
  readonly label: string;
  readonly custom: boolean;
  readonly storeName: string | null;
  readonly shared: boolean;
}): string {
  const end = input.shared ? "skickad" : "klar";
  if (input.type === "bokforing") {
    return `Bokföringsunderlaget för ${input.label} är ${input.shared ? "skickat" : "klart"}.`;
  }
  if (input.type === "delagare") return `Delägarrapporten för ${input.label} är ${end}.`;
  const to = input.storeName ? ` till ${input.storeName}` : "";
  if (input.custom) return `Rapporten för ${input.label}${to} är ${end}.`;
  const month = input.label.charAt(0).toLocaleUpperCase("sv-SE") + input.label.slice(1);
  return `${month}-rapporten${to} är ${end}.`;
}
