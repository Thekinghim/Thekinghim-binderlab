"use client";

import { useSyncExternalStore } from "react";
import { IconButton } from "@/components/ui/button";
import { THEME_STORAGE_KEY, themeCookie, type Theme } from "@/lib/theme";

function read(): Theme {
  return document.documentElement.dataset.theme === "light" ? "light" : "dark";
}

function subscribe(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
}

/** Byter tema och sparar valet: cookien (servern renderar rätt tema) och localStorage. */
export function setTheme(t: Theme) {
  document.documentElement.dataset.theme = t;
  document.cookie = themeCookie(t, location.protocol === "https:");
  try {
    localStorage.setItem(THEME_STORAGE_KEY, t);
  } catch {
    /* privat läge: ignorera */
  }
}

export function useTheme(): Theme {
  return useSyncExternalStore(subscribe, read, () => "dark");
}

export function ThemeToggle() {
  const theme = useTheme();
  const next = theme === "dark" ? "light" : "dark";
  return (
    <IconButton
      icon={theme === "dark" ? "sun" : "moon"}
      label={next === "light" ? "Byt till ljust läge" : "Byt till mörkt läge"}
      onClick={() => setTheme(next)}
    />
  );
}
