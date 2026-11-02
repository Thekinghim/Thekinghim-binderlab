/**
 * Sms för larm. Ingen leverantör är vald, så det finns bara gränssnittet, en lokal
 * implementation och avstängt läge. Valet görs med `SMS_PROVIDER`:
 *
 * - `outbox` (standard i development): skriver varje sms som JSON till `.data/outbox/sms/`.
 * - `off` (standard annars): sms är inte konfigurerat; UI:t visar det och larmjobbet hoppar
 *   över kanalen med en notering i utskicksloggen.
 *
 * En riktig leverantör (t.ex. 46elks, Twilio eller Sinch) läggs till som en ny klass som
 * implementerar `SmsSender`, med sin nyckel i miljön, och väljs här.
 */

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

type Env = Readonly<Record<string, string | undefined>>;

export interface SmsOutcome {
  readonly ok: boolean;
  readonly detail: string;
}

export interface SmsSender {
  readonly kind: "outbox";
  send(to: string, text: string): Promise<SmsOutcome>;
}

export interface SmsStatus {
  readonly kind: "outbox" | "off";
  readonly configured: boolean;
  readonly missing: readonly string[];
}

/** E.164: +46701234567. */
export const E164 = /^\+[1-9][0-9]{6,14}$/;

/** Längsta sms-text (ett sms med GSM-tecken är 160; vi tillåter tre delar). */
export const SMS_MAX_LENGTH = 459;

export function smsStatus(env: Env = process.env): SmsStatus {
  const v = (env.SMS_PROVIDER ?? "").trim().toLowerCase();
  const dev = (env.APP_ENV ?? "development") === "development" && env.NODE_ENV !== "production";
  if (v === "outbox" || (v === "" && dev)) return { kind: "outbox", configured: true, missing: [] };
  if (v === "" || v === "off") {
    return {
      kind: "off",
      configured: false,
      missing: ["Ingen sms-leverantör vald (SMS_PROVIDER)"],
    };
  }
  return { kind: "off", configured: false, missing: [`SMS_PROVIDER har ett okänt värde: ${v}`] };
}

export class OutboxSmsSender implements SmsSender {
  readonly kind = "outbox" as const;
  constructor(private readonly dir: string) {}

  async send(to: string, text: string): Promise<SmsOutcome> {
    if (!E164.test(to)) return { ok: false, detail: "Ogiltigt telefonnummer" };
    const now = new Date();
    const id = `${now.toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
    await mkdir(this.dir, { recursive: true });
    await writeFile(
      path.join(this.dir, `${id}.json`),
      JSON.stringify(
        { sentAt: now.toISOString(), to, text: text.slice(0, SMS_MAX_LENGTH) },
        null,
        2,
      ),
      { flag: "wx" },
    );
    return { ok: true, detail: `outbox:${id}` };
  }
}

export function getSmsSender(env: Env = process.env): SmsSender | null {
  const status = smsStatus(env);
  if (!status.configured) return null;
  return new OutboxSmsSender(
    path.resolve(env.SMS_OUTBOX_DIR?.trim() || path.join(process.cwd(), ".data", "outbox"), "sms"),
  );
}
