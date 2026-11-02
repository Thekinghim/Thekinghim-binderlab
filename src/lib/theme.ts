export type Theme = "dark" | "light";

/** Valet i localStorage (äldre versioner sparade bara här). */
export const THEME_STORAGE_KEY = "binderlab-theme";

/**
 * Valet i en cookie, så att servern renderar rätt `data-theme` på `<html>` direkt: inget
 * mörkt blink i ljust läge, och inget inline-skript i rotlayouten (React varnar för
 * `<script>` som renderas på klienten, och CSP:n slipper ett inline-skript till).
 * Samma namn som nyckeln i localStorage.
 */
export const THEME_COOKIE = THEME_STORAGE_KEY;

/** Ett år. */
const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365;

/** Temat ur cookiens värde. Standard (saknas eller okänt): mörkt. */
export function themeFromCookie(value: string | undefined | null): Theme {
  return value === "light" ? "light" : "dark";
}

/** `document.cookie`-raden som sparar valet. Secure på https. */
export function themeCookie(theme: Theme, secure: boolean): string {
  return `${THEME_COOKIE}=${theme}; Path=/; Max-Age=${THEME_COOKIE_MAX_AGE}; SameSite=Lax${secure ? "; Secure" : ""}`;
}

/** Värdet av en cookie i en `document.cookie`-sträng, eller null. */
export function readCookie(cookieHeader: string, name: string): string | null {
  for (const part of cookieHeader.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return v.join("=");
  }
  return null;
}
