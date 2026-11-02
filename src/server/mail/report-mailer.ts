/**
 * Utskick av rapporter med e-post. Två implementationer, valda med `MAIL_PROVIDER`:
 *
 * - `outbox` (standard lokalt): skriver mejlet till `.data/outbox/<id>/` som
 *   `message.eml` (multipart med HTML, text och bilagor), `message.html`, `message.txt`
 *   och bilagorna. Inget lämnar maskinen. Används i utveckling och tester.
 * - `resend`: Resend (resend.com) via deras SDK. Kräver `RESEND_API_KEY` och en
 *   verifierad avsändardomän i `MAIL_FROM`. Kan inte provas i byggmiljön (nätet är
 *   stängt och nyckel saknas).
 *
 * `MAIL_FROM` är avsändaren ("Binderlab <rapporter@binderlab.se>"), `MAIL_REPLY_TO`
 * valfri svarsadress. Se .env.example och docs/miljoer.md (Rapporter).
 */

import { randomBytes } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { Resend } from "resend";

export interface MailAttachment {
  readonly filename: string;
  readonly contentType: string;
  readonly content: Uint8Array;
}

export interface OutgoingMail {
  readonly to: string;
  readonly subject: string;
  readonly html: string;
  readonly text: string;
  readonly attachments?: readonly MailAttachment[];
  /** Samma nyckel skickar inte samma mejl två gånger (Resend: Idempotency-Key). */
  readonly idempotencyKey?: string;
  /** Taggar för leverantörens loggar och webhooks (t.ex. report_id). */
  readonly tags?: Readonly<Record<string, string>>;
}

export interface SentMail {
  /** Leverantörens id (Resend) eller "outbox:<mapp>". */
  readonly providerMessageId: string;
  /** Sökvägen till mejlet på disk (bara outbox). */
  readonly file?: string;
}

export interface Mailer {
  readonly kind: "outbox" | "resend";
  send(mail: OutgoingMail): Promise<SentMail>;
}

export type MailProviderKind = "outbox" | "resend";

/** Status för UI:t: vilken leverantör som används och vad som saknas. */
export interface MailerStatus {
  readonly kind: MailProviderKind;
  readonly configured: boolean;
  /** Vad som saknas, t.ex. "RESEND_API_KEY saknas". */
  readonly missing: readonly string[];
  readonly from: string;
}

export const DEFAULT_FROM = "Binderlab <rapporter@binderlab.local>";

export class MailError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MailError";
  }
}

function assertHeaderSafe(value: string, label: string): void {
  if (/[\r\n]/.test(value)) throw new MailError(`${label} får inte innehålla radbrytningar.`);
}

function assertAddress(value: string): void {
  assertHeaderSafe(value, "Mottagaren");
  if (!/^[^@\s<>,;]+@[^@\s<>,;]+$/.test(value)) {
    throw new MailError(`Ogiltig e-postadress: ${value}`);
  }
}

/** RFC 2047-kodning av rubriker med icke-ASCII-tecken. */
function encodeHeader(value: string): string {
  return /^[\x20-\x7e]*$/.test(value)
    ? value
    : `=?UTF-8?B?${Buffer.from(value, "utf8").toString("base64")}?=`;
}

function base64Lines(content: Uint8Array): string {
  return (
    Buffer.from(content)
      .toString("base64")
      .match(/.{1,76}/g)
      ?.join("\r\n") ?? ""
  );
}

function safeFilename(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_");
  return clean.slice(0, 120) || "bilaga";
}

/** Bygger ett komplett MIME-meddelande (multipart/mixed med alternative och bilagor). */
export function buildMime(mail: OutgoingMail, from: string, messageId: string, date: Date): string {
  const mixed = `mixed-${messageId}`;
  const alt = `alt-${messageId}`;
  const lines = [
    `From: ${from}`,
    `To: ${mail.to}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Date: ${date.toUTCString()}`,
    `Message-ID: <${messageId}@binderlab.local>`,
    "MIME-Version: 1.0",
    `Content-Type: multipart/mixed; boundary="${mixed}"`,
    "",
    `--${mixed}`,
    `Content-Type: multipart/alternative; boundary="${alt}"`,
    "",
    `--${alt}`,
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(mail.text, "utf8")),
    `--${alt}`,
    "Content-Type: text/html; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    base64Lines(Buffer.from(mail.html, "utf8")),
    `--${alt}--`,
  ];
  for (const a of mail.attachments ?? []) {
    const name = safeFilename(a.filename);
    lines.push(
      `--${mixed}`,
      `Content-Type: ${a.contentType}; name="${name}"`,
      `Content-Disposition: attachment; filename="${name}"`,
      "Content-Transfer-Encoding: base64",
      "",
      base64Lines(a.content),
    );
  }
  lines.push(`--${mixed}--`, "");
  return lines.join("\r\n");
}

export function defaultOutboxDir(): string {
  return path.resolve(process.cwd(), ".data", "outbox");
}

/** Lokal brevlåda: inget skickas, allt skrivs till disk. */
export class OutboxMailer implements Mailer {
  readonly kind = "outbox" as const;

  constructor(
    private readonly dir = defaultOutboxDir(),
    private readonly from = DEFAULT_FROM,
  ) {}

  async send(mail: OutgoingMail): Promise<SentMail> {
    assertAddress(mail.to);
    assertHeaderSafe(mail.subject, "Ämnesraden");
    const now = new Date();
    const id = `${now.toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
    const folder = path.join(this.dir, id);
    await mkdir(folder, { recursive: true });
    await writeFile(path.join(folder, "message.eml"), buildMime(mail, this.from, id, now), {
      flag: "wx",
    });
    await writeFile(path.join(folder, "message.html"), mail.html, { flag: "wx" });
    await writeFile(path.join(folder, "message.txt"), mail.text, { flag: "wx" });
    for (const a of mail.attachments ?? []) {
      await writeFile(path.join(folder, safeFilename(a.filename)), a.content, { flag: "wx" });
    }
    await writeFile(
      path.join(folder, "meta.json"),
      JSON.stringify(
        {
          to: mail.to,
          from: this.from,
          subject: mail.subject,
          sentAt: now.toISOString(),
          tags: mail.tags ?? {},
          attachments: (mail.attachments ?? []).map((a) => ({
            filename: safeFilename(a.filename),
            contentType: a.contentType,
            size: a.content.byteLength,
          })),
        },
        null,
        2,
      ),
      { flag: "wx" },
    );
    return { providerMessageId: `outbox:${id}`, file: path.join(folder, "message.eml") };
  }
}

/** Resend. Skickar via deras API; kastar `MailError` med leverantörens meddelande. */
export class ResendMailer implements Mailer {
  readonly kind = "resend" as const;
  private readonly client: Resend;

  constructor(
    apiKey: string,
    private readonly from: string,
    private readonly replyTo?: string,
  ) {
    this.client = new Resend(apiKey);
  }

  async send(mail: OutgoingMail): Promise<SentMail> {
    assertAddress(mail.to);
    assertHeaderSafe(mail.subject, "Ämnesraden");
    const { data, error } = await this.client.emails.send(
      {
        from: this.from,
        to: mail.to,
        subject: mail.subject,
        html: mail.html,
        text: mail.text,
        ...(this.replyTo ? { replyTo: this.replyTo } : {}),
        attachments: (mail.attachments ?? []).map((a) => ({
          filename: safeFilename(a.filename),
          content: Buffer.from(a.content),
          contentType: a.contentType,
        })),
        tags: Object.entries(mail.tags ?? {}).map(([name, value]) => ({
          name: name.replace(/[^A-Za-z0-9_-]/g, "_"),
          value: value.replace(/[^A-Za-z0-9_-]/g, "_"),
        })),
      },
      mail.idempotencyKey ? { idempotencyKey: mail.idempotencyKey } : undefined,
    );
    if (error || !data) {
      throw new MailError(`Resend svarade med fel: ${error?.message ?? "inget id"}`, {
        cause: error,
      });
    }
    return { providerMessageId: data.id };
  }
}

type Env = Readonly<Record<string, string | undefined>>;

function providerOf(env: Env): MailProviderKind {
  const v = (env.MAIL_PROVIDER ?? "").trim().toLowerCase();
  if (v === "resend") return "resend";
  if (v === "outbox" || v === "") return "outbox";
  throw new MailError(`MAIL_PROVIDER måste vara outbox eller resend, fick "${v}".`);
}

/** Vilken leverantör som gäller och om den är konfigurerad. Kastar aldrig. */
export function mailerStatus(env: Env = process.env): MailerStatus {
  let kind: MailProviderKind;
  try {
    kind = providerOf(env);
  } catch {
    return {
      kind: "outbox",
      configured: false,
      missing: ["MAIL_PROVIDER har ett okänt värde"],
      from: env.MAIL_FROM?.trim() || DEFAULT_FROM,
    };
  }
  const from = env.MAIL_FROM?.trim() || DEFAULT_FROM;
  if (kind === "outbox") return { kind, configured: true, missing: [], from };
  const missing: string[] = [];
  if (!env.RESEND_API_KEY?.trim()) missing.push("RESEND_API_KEY saknas");
  if (!env.MAIL_FROM?.trim()) missing.push("MAIL_FROM saknas");
  return { kind, configured: missing.length === 0, missing, from };
}

/** Utskicksadaptern enligt miljön. Kastar `MailError` om Resend valts men inte är konfigurerat. */
export function getMailer(env: Env = process.env): Mailer {
  const status = mailerStatus(env);
  if (!status.configured) {
    throw new MailError(`E-post är inte konfigurerad: ${status.missing.join(", ")}.`);
  }
  if (status.kind === "resend") {
    return new ResendMailer(env.RESEND_API_KEY!.trim(), status.from, env.MAIL_REPLY_TO?.trim());
  }
  return new OutboxMailer(env.MAIL_OUTBOX_DIR?.trim() || defaultOutboxDir(), status.from);
}
