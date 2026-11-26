"use client";

/**
 * Kommandopalettens genväg (⌘K / Ctrl K och "/") och plattformens modifieringstangent. Egen
 * fil, så att skalet kan lyssna på genvägen utan att ladda själva paletten
 * (./command-palette.tsx) förrän den öppnas.
 */

import { useEffect, useLayoutEffect, useRef, useSyncExternalStore } from "react";

/* ------------------------------------------------------------------ */
/* Plattform och kortkommando                                          */
/* ------------------------------------------------------------------ */

type NavigatorWithUAData = Navigator & { userAgentData?: { platform?: string } };

export function detectMac(): boolean {
  const nav = navigator as NavigatorWithUAData;
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

const noopSubscribe = () => () => {};

/**
 * Modifieringstangent för plattformen: "⌘" på Apple, "Ctrl" annars.
 * null under serverrendering och första hydreringen, så att markup stämmer.
 */
export function useModifierKey(): "⌘" | "Ctrl" | null {
  return useSyncExternalStore(
    noopSubscribe,
    () => (detectMac() ? "⌘" : "Ctrl"),
    () => null,
  );
}

/** "⌘K" på Apple, "Ctrl K" annars. Tom sträng innan plattformen är känd. */
export function formatHotkey(mod: "⌘" | "Ctrl" | null, key = "K"): string {
  if (!mod) return "";
  return mod === "⌘" ? `⌘${key}` : `Ctrl ${key}`;
}

export function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !["button", "checkbox", "radio", "range", "reset", "submit", "color", "file"].includes(
    type,
  );
}

type SetOpen = (update: boolean | ((prev: boolean) => boolean)) => void;

/**
 * Global genväg: ⌘K (Apple) eller Ctrl+K (övriga) växlar paletten.
 * "/" öppnar den när fokus inte ligger i ett fält och ingen annan dialog är öppen.
 * Returnerar modifieringstangenten för att visa rätt symbol.
 */
export function useCommandPaletteHotkey(
  setOpen: SetOpen,
  options: { enabled?: boolean; slash?: boolean } = {},
): "⌘" | "Ctrl" | null {
  const { enabled = true, slash = true } = options;
  const mod = useModifierKey();
  const setOpenRef = useRef(setOpen);
  useLayoutEffect(() => {
    setOpenRef.current = setOpen;
  });

  useEffect(() => {
    if (!enabled) return;
    const mac = detectMac();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const primary = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (primary && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpenRef.current((prev) => !prev);
        return;
      }
      if (
        slash &&
        e.key === "/" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !isEditable(e.target) &&
        !document.querySelector("dialog[open]")
      ) {
        e.preventDefault();
        setOpenRef.current(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, slash]);

  return mod;
}
