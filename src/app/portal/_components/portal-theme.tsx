"use client";

import { useLayoutEffect } from "react";

import { THEME_STORAGE_KEY, type Theme } from "@/lib/theme";

import type { PortalTheme } from "./theme-script";

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
 * portalens yta följer med) och återställer appens val när portalen lämnas. I V2 är
 * portalen alltid ljus (layouten skickar "light").
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
