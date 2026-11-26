/**
 * Är förfrågan troligen från en telefon? Bara ett tips till servern om vad som är onödigt att
 * rendera i första HTML-svaret (V2:s sidomeny, som telefonen ändå döljer med CSS under 900 px).
 * Vad som syns avgörs alltid av CSS och mediefrågor i webbläsaren; ett fel här ger bara en
 * sidomeny som ritas en bild senare på datorn, aldrig en saknad eller trasig sida.
 *
 * Sec-CH-UA-Mobile (Chromium) när den finns, annars användaragenten (Safari skickar inga
 * klienttips). En iPad räknas inte som telefon (den kan visa sidomenyn).
 */
export function isPhoneRequest(
  userAgent: string | null | undefined,
  chMobile?: string | null,
): boolean {
  if (chMobile === "?1") return true;
  if (chMobile === "?0") return false;
  if (!userAgent) return false;
  return /\b(iPhone|iPod)\b/.test(userAgent) || /\bAndroid\b.*\bMobile\b/.test(userAgent);
}
