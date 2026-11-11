/**
 * Utskick av larm i tre kanaler: push (Web Push), e-post (samma adapter som rapporterna,
 * src/server/mail/report-mailer.ts) och sms (adapter utan vald leverantör).
 *
 * `channelStatus()` säger vilka kanaler som är konfigurerade (för UI:t: ett ärligt läge när
 * en kanal saknas). `dispatchDelivery()` skickar ett utskick till en mottagare i de kanaler
 * hon valt och ger utfallet per kanal; en kanal som inte är konfigurerad hoppas över med en
 * notering, aldrig tyst.
 */

import "server-only";

import type { AlertDelivery } from "@/analytics/alerts";
import { getMailer, mailerStatus, type MailerStatus } from "@/server/mail/report-mailer";

import { alertEmail, pushPayloads, smsText, type PushContext } from "./content";
import { getPushSender, pushStatus, type PushStatus, type PushTarget } from "./push";
import { getSmsSender, smsStatus, type SmsStatus } from "./sms";

export type Channel = "push" | "email" | "sms";
export const CHANNELS: readonly Channel[] = ["push", "email", "sms"];
export const CHANNEL_LABEL: Record<Channel, string> = {
  push: "Push",
  email: "E-post",
  sms: "Sms",
};

export interface ChannelStatus {
  readonly push: PushStatus;
  readonly email: MailerStatus;
  readonly sms: SmsStatus;
}

export async function channelStatus(): Promise<ChannelStatus> {
  return { push: await pushStatus(), email: mailerStatus(), sms: smsStatus() };
}

/** En push-enhet med id (för att kunna stänga av den när push-tjänsten svarar 404/410). */
export interface PushDevice extends PushTarget {
  readonly id: string;
}

export interface Recipient {
  readonly userId: string;
  readonly email: string | null;
  readonly phone: string | null;
  readonly channels: readonly Channel[];
  readonly pushDevices: readonly PushDevice[];
}

export interface ChannelResult {
  readonly channel: Channel;
  readonly status: "sent" | "failed" | "skipped";
  readonly detail: string;
}

export interface DispatchResult {
  readonly results: ChannelResult[];
  /** Push-enheter som inte finns längre (stängs av av anroparen). */
  readonly goneDevices: string[];
  /** Push-enheter som tog emot. */
  readonly okDevices: string[];
  readonly status: "sent" | "partial" | "failed" | "skipped";
}

export interface DispatchOptions {
  readonly baseUrl: string;
  readonly timeZone: string;
  readonly organizationName: string;
  /** Idempotensnyckel för e-post (t.ex. utskickets id). */
  readonly idempotencyKey?: string;
  /** Automaternas namn, butik och läge: push om påfyllning blir en notis per automat. */
  readonly push?: PushContext;
}

export function overallStatus(results: readonly ChannelResult[]): DispatchResult["status"] {
  const sent = results.filter((r) => r.status === "sent").length;
  const failed = results.filter((r) => r.status === "failed").length;
  if (sent > 0 && failed === 0) return "sent";
  if (sent > 0) return "partial";
  if (failed > 0) return "failed";
  return "skipped";
}

/** Skickar utskicket till mottagaren i hennes kanaler. Kastar aldrig; fel blir utfall. */
export async function dispatchDelivery(
  delivery: AlertDelivery,
  recipient: Recipient,
  options: DispatchOptions,
): Promise<DispatchResult> {
  const results: ChannelResult[] = [];
  const goneDevices: string[] = [];
  const okDevices: string[] = [];

  if (recipient.channels.includes("push")) {
    const sender = await getPushSender();
    if (!sender) {
      results.push({ channel: "push", status: "skipped", detail: "Push är inte konfigurerad" });
    } else if (recipient.pushDevices.length === 0) {
      results.push({ channel: "push", status: "skipped", detail: "Ingen enhet har push påslaget" });
    } else {
      // En notis om påfyllning (per automat) och en för övriga larm: högst två.
      const payloads = pushPayloads(delivery, options.push);
      let ok = 0;
      // Notiser som inte gick fram till en enhet som fick en annan notis ur samma utskick.
      let lost = 0;
      const errors: string[] = [];
      for (const device of recipient.pushDevices) {
        let delivered = false;
        let missed = 0;
        let gone = false;
        for (const payload of payloads) {
          const out = await sender.send(device, payload);
          if (out.ok) delivered = true;
          else {
            missed += 1;
            errors.push(out.detail);
            if (out.gone) gone = true;
          }
          // Enheten finns inte längre: nästa notis går inte heller fram.
          if (gone) break;
        }
        if (delivered) {
          ok += 1;
          lost += missed;
          okDevices.push(device.id);
        } else if (gone) goneDevices.push(device.id);
      }
      results.push({
        channel: "push",
        status: ok > 0 ? "sent" : "failed",
        detail:
          ok > 0
            ? // En av två notiser kan ha fallit bort (timeout, 5xx): det ska synas i utfallet.
              `${ok} av ${recipient.pushDevices.length} enheter${sender.kind === "outbox" ? " (lokalt, .data/outbox/push)" : ""}${
                lost > 0
                  ? `. ${lost} ${lost === 1 ? "notis" : "notiser"} gick inte fram: ${errors.join(", ")}`
                  : ""
              }`
            : `Push misslyckades: ${errors.join(", ")}`,
      });
    }
  }

  if (recipient.channels.includes("email")) {
    if (!recipient.email) {
      results.push({ channel: "email", status: "skipped", detail: "E-postadress saknas" });
    } else {
      try {
        const mailer = getMailer();
        const mail = alertEmail(delivery, options);
        const sent = await mailer.send({
          to: recipient.email,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          ...(options.idempotencyKey ? { idempotencyKey: `larm-${options.idempotencyKey}` } : {}),
          tags: { kind: "alert" },
        });
        results.push({
          channel: "email",
          status: "sent",
          detail:
            mailer.kind === "outbox" ? `Lokalt: ${sent.providerMessageId}` : sent.providerMessageId,
        });
      } catch (error) {
        const status = mailerStatus();
        results.push({
          channel: "email",
          status: status.configured ? "failed" : "skipped",
          detail: error instanceof Error ? error.message : "E-post kunde inte skickas",
        });
      }
    }
  }

  if (recipient.channels.includes("sms")) {
    const sender = getSmsSender();
    if (!sender) {
      results.push({ channel: "sms", status: "skipped", detail: "Ingen sms-leverantör vald" });
    } else if (!recipient.phone) {
      results.push({ channel: "sms", status: "skipped", detail: "Telefonnummer saknas" });
    } else {
      const out = await sender.send(recipient.phone, smsText(delivery, options.baseUrl));
      results.push({
        channel: "sms",
        status: out.ok ? "sent" : "failed",
        detail: out.ok ? `Lokalt: ${out.detail}` : out.detail,
      });
    }
  }

  return { results, goneDevices, okDevices, status: overallStatus(results) };
}
