"use client";

import { useEffect } from "react";

import { readCookie, THEME_COOKIE, THEME_STORAGE_KEY, themeCookie } from "@/lib/theme";

/**
 * Flyttar ett äldre temaval från localStorage till cookien (en gång per webbläsare), så att
 * servern renderar rätt tema från nästa sidladdning. Ritar ingenting.
 */
export function ThemeSync() {
  useEffect(() => {
    try {
      if (readCookie(document.cookie, THEME_COOKIE) !== null) return;
      const stored = localStorage.getItem(THEME_STORAGE_KEY);
      if (stored !== "light" && stored !== "dark") return;
      document.cookie = themeCookie(stored, location.protocol === "https:");
      document.documentElement.dataset.theme = stored;
    } catch {
      // Utan lagring gäller serverns tema.
    }
  }, []);
  return null;
}
