/** Vad den här webbläsaren kan, för notiserna. Rent, så att raden kan testas. */
export interface NoticeDevice {
  /** Push finns (service worker, PushManager, Notification). */
  readonly push: boolean;
  /** Notiser blockerade för sidan. */
  readonly denied: boolean;
  /** iPhone eller iPad. */
  readonly ios: boolean;
  /** Öppnad från hemskärmen (installerad webbapp). */
  readonly installed: boolean;
}

/**
 * En rad om vad som behövs på den här enheten, eller null. På iPhone fungerar push bara när
 * Binderlab ligger på hemskärmen (iOS 16.4 eller senare) och öppnas därifrån.
 */
export function deviceHint(d: NoticeDevice): string | null {
  if (d.ios && !d.installed) {
    return "iPhone: tryck på Dela och Lägg till på hemskärmen. Öppna Binderlab därifrån.";
  }
  if (!d.push) {
    return d.ios
      ? "Uppdatera iPhone till iOS 16.4 eller senare."
      : "Den här webbläsaren kan inte visa notiser.";
  }
  if (d.denied) return "Notiser är blockerade. Tillåt dem i inställningarna.";
  return null;
}
