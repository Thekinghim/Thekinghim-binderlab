/**
 * Notis vid varje försäljning: slå på den här telefonen och knappen (klientkod). Samma steg
 * som "Notiser i mobilen" (drift/larm): lov att visa notiser, prenumeration hos
 * push-tjänsten, enheten sparas, sedan valet.
 */

import { savePushDevice } from "@/app/(app)/drift/actions";
import { deviceHint } from "@/app/(app)/drift/larm/device-hint";
import { detectPushDevice, pushBlock, subscribeThisDevice } from "@/components/pwa/push-device";
import { saveSalePushSetting } from "@/server/actions/sale-push";

export type EnableResult =
  | { readonly ok: true; readonly endpoint: string | null }
  | { readonly ok: false; readonly message: string };

/** Telefon eller surfplatta (inte en dator): notisen hamnar då i den här enheten. */
export function isPhone(): boolean {
  if (typeof navigator === "undefined") return false;
  return detectPushDevice().ios || /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

/** En rad om vad som behövs i den här telefonen (iPhone: hemskärmen), eller null. */
export function thisDeviceHint(): string | null {
  return deviceHint(detectPushDevice());
}

/** Ger den här telefonen notiser. Sant med adressen när den (nu) är påslagen. */
export async function subscribeHere(
  publicKey: string,
): Promise<{ ok: true; endpoint: string } | { ok: false; message: string }> {
  const device = detectPushDevice();
  if (pushBlock(device)) {
    return {
      ok: false,
      message: deviceHint(device) ?? "Den här webbläsaren kan inte visa notiser.",
    };
  }
  const sub = await subscribeThisDevice(publicKey);
  if (!sub.ok) {
    return {
      ok: false,
      message:
        sub.reason === "denied"
          ? "Notiser tillåts inte. Tillåt dem i inställningarna."
          : sub.reason === "no-worker"
            ? "Ladda om sidan och försök igen."
            : "Det gick inte. Försök igen.",
    };
  }
  const saved = await savePushDevice({
    endpoint: sub.endpoint,
    keys: sub.keys,
    userAgent: navigator.userAgent.slice(0, 300),
  }).catch(() => ({ ok: false as const, error: undefined }));
  if (!saved.ok) return { ok: false, message: "Det gick inte. Försök igen." };
  return { ok: true, endpoint: sub.endpoint };
}

/**
 * Slår på notisen: den här telefonen först om personen inte har någon telefon med notiser,
 * sedan valet.
 */
export async function enableSalePush(options: {
  publicKey: string | null;
  hasDevice: boolean;
}): Promise<EnableResult> {
  let endpoint: string | null = null;
  if (!options.hasDevice) {
    if (!options.publicKey) return { ok: false, message: "Notiser är inte påslagna i appen än." };
    const here = await subscribeHere(options.publicKey);
    if (!here.ok) return here;
    endpoint = here.endpoint;
  }
  const res = await saveSalePushSetting({ on: true }).catch(() => ({
    ok: false as const,
    error: "Det gick inte att spara. Försök igen.",
  }));
  if (!res.ok) return { ok: false, message: res.error };
  return { ok: true, endpoint };
}
