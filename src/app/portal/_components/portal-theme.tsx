"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";

import { IconButton } from "@/components/ui/button";
import { THEME_STORAGE_KEY, type Theme } from "@/lib/theme";

import { PORTAL_ROOT_ID, PORTAL_THEME_COOKIE, type PortalTheme } from "./theme-script";

function appTheme(): Theme {
  try {
    const t = localStorage.getItem(THEME_STORAGE_KEY);
    return t === "light" || t === "dark" ? t : "dark";
  } catch {
    return "dark";
  }
}

/**
 * Sätter portalens tema även på <html> (dialoger, notiser och kanterna utanför
 * portalens yta följer med) och återställer appens val när portalen lämnas.
 */
export function PortalThemeScope({ theme }: { theme: PortalTheme }) {
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = theme;
    return () => {
      document.documentElement.dataset.theme = appTheme();
    };
  }, [theme]);
  return null;
}

function read(): Theme {
  return document.getElementById(PORTAL_ROOT_ID)?.dataset.theme === "dark" ? "dark" : "light";
}

function subscribe(cb: () => void) {
  const root = document.getElementById(PORTAL_ROOT_ID);
  if (!root) return () => {};
  const mo = new MutationObserver(cb);
  mo.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
}

export function PortalThemeToggle({ initial }: { initial: PortalTheme }) {
  const theme = useSyncExternalStore(subscribe, read, () => initial);
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <IconButton
      icon={theme === "dark" ? "sun" : "moon"}
      label={next === "light" ? "Byt till ljust läge" : "Byt till mörkt läge"}
      onClick={() => {
        const root = document.getElementById(PORTAL_ROOT_ID);
        if (root) root.dataset.theme = next;
        document.documentElement.dataset.theme = next;
        document.cookie = `${PORTAL_THEME_COOKIE}=${next}; path=/portal; max-age=31536000; samesite=lax`;
      }}
    />
  );
}
