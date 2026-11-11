/**
 * Den här telefonens push: vad webbläsaren kan och prenumerationen hos push-tjänsten.
 * Klientkod (anropas från knappar). Samma steg som "Notiser i mobilen" (drift/larm).
 */

import { readyRegistration } from "./service-worker";

export interface PushDeviceInfo {
  /** Push finns (service worker, PushManager, Notification). */
  readonly push: boolean;
  /** Notiser blockerade för sidan. */
  readonly denied: boolean;
  /** iPhone eller iPad. */
  readonly ios: boolean;
  /** Öppnad från hemskärmen (installerad webbapp). */
  readonly installed: boolean;
}

export function detectPushDevice(): PushDeviceInfo {
  if (typeof navigator === "undefined" || typeof window === "undefined") {
    return { push: false, denied: false, ios: false, installed: false };
  }
  const nav = navigator as Navigator & { standalone?: boolean };
  const ios =
    /iPhone|iPad|iPod/.test(nav.userAgent) ||
    (nav.platform === "MacIntel" && (nav.maxTouchPoints ?? 0) > 1);
  const push = "serviceWorker" in nav && "PushManager" in window && "Notification" in window;
  return {
    push,
    denied: push && Notification.permission === "denied",
    ios,
    installed: nav.standalone === true || window.matchMedia("(display-mode: standalone)").matches,
  };
}

/** Varför push inte går att slå på i den här telefonen, eller null när det går. */
export type PushBlock = "ios-install" | "ios-update" | "unsupported" | "denied";

export function pushBlock(d: PushDeviceInfo): PushBlock | null {
  if (d.ios && !d.installed) return "ios-install";
  if (!d.push) return d.ios ? "ios-update" : "unsupported";
  if (d.denied) return "denied";
  return null;
}

function base64UrlToBytes(value: string): Uint8Array<ArrayBuffer> {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const raw = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

/** Den här telefonens push-adress, eller null om den inte prenumererar. */
export async function currentPushEndpoint(): Promise<string | null> {
  try {
    const reg = await readyRegistration();
    const sub = await reg?.pushManager.getSubscription();
    return sub?.endpoint ?? null;
  } catch {
    return null;
  }
}

export type SubscribeResult =
  | {
      readonly ok: true;
      readonly endpoint: string;
      readonly keys: Record<string, string> | undefined;
    }
  | { readonly ok: false; readonly reason: "denied" | "no-worker" | "failed" };

/** Frågar om lov och prenumererar den här webbläsaren hos push-tjänsten. */
export async function subscribeThisDevice(publicKey: string): Promise<SubscribeResult> {
  try {
    const permission = await Notification.requestPermission();
    if (permission !== "granted") return { ok: false, reason: "denied" };
    const reg = await readyRegistration();
    if (!reg) return { ok: false, reason: "no-worker" };
    const sub =
      (await reg.pushManager.getSubscription()) ??
      (await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: base64UrlToBytes(publicKey),
      }));
    const json = sub.toJSON();
    if (!json.endpoint) return { ok: false, reason: "failed" };
    return { ok: true, endpoint: json.endpoint, keys: json.keys };
  } catch {
    return { ok: false, reason: "failed" };
  }
}
