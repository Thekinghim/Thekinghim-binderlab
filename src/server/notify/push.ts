/**
 * Web Push för larm. Två implementationer, valda med `PUSH_PROVIDER`:
 *
 * - `webpush`: skickar via webbläsarens push-tjänst med paketet web-push (VAPID).
 *   Kräver `VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY` och `VAPID_SUBJECT`
 *   (mailto:-adress eller https-adress till den som driver tjänsten).
 * - `outbox` (standard i development): inget lämnar maskinen; varje push skrivs som JSON
 *   till `.data/outbox/push/`. Saknas VAPID-nycklar lokalt skapas ett par för utveckling i
 *   `.data/vapid-dev.json`, så att webbläsaren kan prenumerera och flödet kan provas.
 *
 * Utanför development finns ingen standard: utan nycklar är push inte konfigurerad, och
 * UI:t visar det.
 */

import "server-only";

import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

import webpush from "web-push";

type Env = Readonly<Record<string, string | undefined>>;

export interface PushTarget {
  readonly endpoint: string;
  readonly p256dh: string;
  readonly auth: string;
}

/** Innehållet som service workern (public/sw.js) visar. */
export interface PushPayload {
  readonly title: string;
  readonly body: string;
  /** Sökväg i appen som öppnas vid klick. */
  readonly url: string;
  /** Samma tagg ersätter en tidigare notis i stället för att lägga en till. */
  readonly tag: string;
  readonly severity: "info" | "warning" | "critical";
}

export type PushOutcome =
  | { readonly ok: true; readonly detail: string }
  /** `gone`: prenumerationen finns inte längre (404/410) och ska stängas av. */
  | { readonly ok: false; readonly gone: boolean; readonly detail: string };

export interface PushSender {
  readonly kind: "webpush" | "outbox";
  send(target: PushTarget, payload: PushPayload): Promise<PushOutcome>;
}

export interface PushStatus {
  readonly kind: "webpush" | "outbox" | "off";
  readonly configured: boolean;
  /** Publik VAPID-nyckel för webbläsarens prenumeration (base64url), om den finns. */
  readonly publicKey: string | null;
  readonly missing: readonly string[];
}

function isDevelopment(env: Env): boolean {
  return (env.APP_ENV ?? "development") === "development" && env.NODE_ENV !== "production";
}

function providerOf(env: Env): "webpush" | "outbox" | null {
  const v = (env.PUSH_PROVIDER ?? "").trim().toLowerCase();
  if (v === "webpush" || v === "outbox") return v;
  if (v === "") {
    if (env.VAPID_PUBLIC_KEY?.trim() && env.VAPID_PRIVATE_KEY?.trim()) return "webpush";
    return isDevelopment(env) ? "outbox" : null;
  }
  return null;
}

function devKeyFile(env: Env): string {
  return path.resolve(
    env.PUSH_OUTBOX_DIR?.trim() || path.join(process.cwd(), ".data"),
    "vapid-dev.json",
  );
}

let devKeys: { publicKey: string; privateKey: string } | null = null;

/** Lokalt nyckelpar för utveckling (skapas en gång, sparas i .data). */
async function developmentKeys(env: Env): Promise<{ publicKey: string; privateKey: string }> {
  if (devKeys) return devKeys;
  const file = devKeyFile(env);
  try {
    const parsed = JSON.parse(await readFile(file, "utf8")) as {
      publicKey: string;
      privateKey: string;
    };
    if (parsed.publicKey && parsed.privateKey) {
      devKeys = parsed;
      return parsed;
    }
  } catch {
    // Saknas: skapas nedan.
  }
  const keys = webpush.generateVAPIDKeys();
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  devKeys = keys;
  return keys;
}

/** Vilken push-leverantör som gäller och om den är konfigurerad. Kastar aldrig. */
export async function pushStatus(env: Env = process.env): Promise<PushStatus> {
  const kind = providerOf(env);
  if (kind === null) {
    const missing = [
      ...(env.VAPID_PUBLIC_KEY?.trim() ? [] : ["VAPID_PUBLIC_KEY saknas"]),
      ...(env.VAPID_PRIVATE_KEY?.trim() ? [] : ["VAPID_PRIVATE_KEY saknas"]),
      ...(env.PUSH_PROVIDER?.trim() &&
      !["webpush", "outbox"].includes(env.PUSH_PROVIDER.trim().toLowerCase())
        ? ["PUSH_PROVIDER har ett okänt värde"]
        : []),
    ];
    return { kind: "off", configured: false, publicKey: null, missing };
  }
  if (kind === "webpush") {
    const missing = [
      ...(env.VAPID_PUBLIC_KEY?.trim() ? [] : ["VAPID_PUBLIC_KEY saknas"]),
      ...(env.VAPID_PRIVATE_KEY?.trim() ? [] : ["VAPID_PRIVATE_KEY saknas"]),
      ...(env.VAPID_SUBJECT?.trim() ? [] : ["VAPID_SUBJECT saknas"]),
    ];
    return {
      kind,
      configured: missing.length === 0,
      publicKey: env.VAPID_PUBLIC_KEY?.trim() || null,
      missing,
    };
  }
  // outbox: nycklar från miljön eller lokala utvecklingsnycklar.
  let publicKey = env.VAPID_PUBLIC_KEY?.trim() || null;
  if (!publicKey && isDevelopment(env)) {
    try {
      publicKey = (await developmentKeys(env)).publicKey;
    } catch {
      publicKey = null;
    }
  }
  return { kind, configured: true, publicKey, missing: [] };
}

function outboxDir(env: Env): string {
  return path.resolve(
    env.PUSH_OUTBOX_DIR?.trim() || path.join(process.cwd(), ".data", "outbox"),
    "push",
  );
}

/** Lokal: skriver push-meddelandet till disk. */
export class OutboxPushSender implements PushSender {
  readonly kind = "outbox" as const;
  constructor(private readonly dir: string) {}

  async send(target: PushTarget, payload: PushPayload): Promise<PushOutcome> {
    const now = new Date();
    const id = `${now.toISOString().replace(/[:.]/g, "-")}-${randomBytes(4).toString("hex")}`;
    await mkdir(this.dir, { recursive: true });
    const file = path.join(this.dir, `${id}.json`);
    await writeFile(
      file,
      JSON.stringify({ sentAt: now.toISOString(), endpoint: target.endpoint, payload }, null, 2),
      { flag: "wx" },
    );
    return { ok: true, detail: `outbox:${id}` };
  }
}

/** Riktig Web Push med VAPID (web-push). */
export class WebPushSender implements PushSender {
  readonly kind = "webpush" as const;
  constructor(private readonly vapid: { subject: string; publicKey: string; privateKey: string }) {}

  async send(target: PushTarget, payload: PushPayload): Promise<PushOutcome> {
    try {
      const res = await webpush.sendNotification(
        { endpoint: target.endpoint, keys: { p256dh: target.p256dh, auth: target.auth } },
        JSON.stringify(payload),
        {
          vapidDetails: this.vapid,
          TTL: payload.severity === "critical" ? 24 * 3600 : 6 * 3600,
          urgency: payload.severity === "critical" ? "high" : "normal",
          topic: payload.tag.replace(/[^A-Za-z0-9_-]/g, "").slice(0, 32) || undefined,
        },
      );
      return { ok: true, detail: `HTTP ${res.statusCode}` };
    } catch (error) {
      const status =
        typeof error === "object" && error !== null && "statusCode" in error
          ? Number((error as { statusCode: unknown }).statusCode)
          : null;
      return {
        ok: false,
        gone: status === 404 || status === 410,
        detail: status ? `HTTP ${status}` : error instanceof Error ? error.message : "okänt fel",
      };
    }
  }
}

/** Push-adaptern enligt miljön, eller null när push inte är konfigurerad. */
export async function getPushSender(env: Env = process.env): Promise<PushSender | null> {
  const status = await pushStatus(env);
  if (!status.configured) return null;
  if (status.kind === "webpush") {
    return new WebPushSender({
      subject: env.VAPID_SUBJECT!.trim(),
      publicKey: env.VAPID_PUBLIC_KEY!.trim(),
      privateKey: env.VAPID_PRIVATE_KEY!.trim(),
    });
  }
  return new OutboxPushSender(outboxDir(env));
}
