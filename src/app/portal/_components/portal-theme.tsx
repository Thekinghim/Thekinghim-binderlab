"use client";

import { useLayoutEffect, useSyncExternalStore } from "react";

import { IconButton } from "@/components/ui/button";
import { THEME_STORAGE_KEY, type Theme } from "@/lib/theme";

import { PORTAL_THEME_KEY } from "./theme-script";

function readStored(key: string): Theme | null {
  try {
    const t = localStorage.getItem(key);
    return t === "light" || t === "dark" ? t : null;
  } catch {
    return null;
  }
}

/** Sätter portalens tema vid klientnavigering in i portalen och återställer appens vid utgång. */
export function PortalThemeScope() {
  useLayoutEffect(() => {
    document.documentElement.dataset.theme = readStored(PORTAL_THEME_KEY) ?? "light";
    return () => {
      document.documentElement.dataset.theme = readStored(THEME_STORAGE_KEY) ?? "dark";
    };
  }, []);
  return null;
}

function read(): Theme {
  return document.documentElement.dataset.theme === "dark" ? "dark" : "light";
}

function subscribe(cb: () => void) {
  const mo = new MutationObserver(cb);
  mo.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => mo.disconnect();
}

export function PortalThemeToggle() {
  const theme = useSyncExternalStore(subscribe, read, () => "light");
  const next: Theme = theme === "dark" ? "light" : "dark";
  return (
    <IconButton
      icon={theme === "dark" ? "sun" : "moon"}
      label={next === "light" ? "Byt till ljust läge" : "Byt till mörkt läge"}
      onClick={() => {
        document.documentElement.dataset.theme = next;
        try {
          localStorage.setItem(PORTAL_THEME_KEY, next);
        } catch {
          /* privat läge: ignorera */
        }
      }}
    />
  );
}
