"use client";

import { useEffect } from "react";

import {
  forgetsHealthy,
  HealthyTracker,
  isTypingTarget,
  keyboardUp,
  looksStuck,
  pinShift,
} from "./viewport-pin";

const DEBUG_KEY = "binderlab:vp-debug";

/**
 * Rättar iPhones fel där bottenraden hamnar mitt på skärmen (se viewport-pin.ts). Monteras en
 * gång i rotlayouten och sätter `--v2-vp-shift` på <html>; bottenraden, notiserna och de fasta
 * knapparna nedtill räknar med den. Sätter även `data-v2-kb` medan tangentbordet syns, så att
 * bottenraden inte står mitt i vägen ovanför det.
 *
 * Felsökning på telefonen: öppna valfri sida med `?vp=1` (av: `?vp=0`) så visas måtten uppe
 * till vänster.
 */
export function ViewportPin() {
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const root = document.documentElement;
    const probe = document.createElement("div");
    probe.setAttribute("aria-hidden", "true");
    probe.style.cssText =
      "position:fixed;left:0;bottom:0;width:1px;height:1px;pointer-events:none;visibility:hidden;contain:strict";
    document.body.appendChild(probe);

    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    const screenMax = Math.max(window.screen.width, window.screen.height);
    const screenMin = Math.min(window.screen.width, window.screen.height);
    // Bara telefoner: en iPad i Stage Manager kan ändra höjden på riktigt utan att bredden ändras.
    const phone = screenMin < 500;
    const useHealthy = standalone && phone;
    const healthy = new HealthyTracker();
    // Högre höjd som väntar på bekräftelse: mät om nästa bildruta, men inte i all evighet.
    let confirmFrames = 0;

    const debug = setupDebug();
    let shift = 0;
    let kb = false;
    let raf = 0;
    let lastVvHeight = vv.height;
    const timers: number[] = [];

    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const typing = isTypingTarget(document.activeElement);
        const naturalBottom = probe.getBoundingClientRect().bottom;
        const visibleBottom = vv.offsetTop + vv.height;
        let healthyBottom = 0;
        if (useHealthy) {
          const r = healthy.sample({
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            vvWidth: vv.width,
            visibleBottom,
            naturalBottom,
            typing,
            scale: vv.scale,
            screenMin,
            screenMax,
          });
          healthyBottom = r.healthy;
          if (r.confirm && confirmFrames < 30) {
            confirmFrames++;
            measure(); // nästa bildruta
          } else if (!r.confirm) {
            confirmFrames = 0;
          }
        }
        const next = pinShift({
          naturalBottom,
          visibleBottom,
          healthyBottom,
          scale: vv.scale,
          typing,
        });
        if (next !== shift) {
          shift = next;
          if (next) root.style.setProperty("--v2-vp-shift", `${next}px`);
          else root.style.removeProperty("--v2-vp-shift");
        }
        const nextKb = keyboardUp({
          typing,
          visibleHeight: vv.height,
          fullHeight: Math.max(window.innerHeight, healthyBottom),
        });
        if (nextKb !== kb) {
          kb = nextKb;
          if (kb) root.setAttribute("data-v2-kb", "");
          else root.removeAttribute("data-v2-kb");
        }
        debug?.({
          inner: window.innerHeight,
          client: root.clientHeight,
          vvH: Math.round(vv.height),
          vvTop: Math.round(vv.offsetTop),
          scrollY: Math.round(window.scrollY),
          screen: window.screen.height,
          fixedBottom: Math.round(naturalBottom),
          healthy: healthyBottom,
          shift,
          kb,
          mode: standalone ? "standalone" : "browser",
        });
      });
    };

    // WebKit räknar inte om vyn av ett scrollTo till samma läge; ett steg bort och tillbaka gör det.
    const nudge = () => {
      if (!useHealthy) return;
      const typing = isTypingTarget(document.activeElement);
      const stuck = looksStuck({
        innerHeight: window.innerHeight,
        healthyBottom: healthy.get(window.innerWidth),
        offsetTop: vv.offsetTop,
        typing,
      });
      if (!stuck) return;
      const x = window.scrollX;
      const y = window.scrollY;
      window.scrollTo(x, y + 1);
      requestAnimationFrame(() => {
        window.scrollTo(x, Math.max(0, y));
        measure();
      });
    };

    // Efter tangentbord, ark eller återkomst: låt Safari landa, puffa vyn och mät igen.
    const settle = () => {
      measure();
      for (const ms of [120, 400, 900]) {
        timers.push(
          window.setTimeout(() => {
            if (ms === 120) nudge();
            measure();
          }, ms),
        );
      }
    };
    const onVvResize = () => {
      // Tangentbordet stängdes (vyn blev mycket högre): samma städning som vid blur.
      if (vv.height - lastVvHeight >= 60) settle();
      else measure();
      lastVvHeight = vv.height;
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") settle();
    };
    let lastWidth = Math.round(window.innerWidth);
    // Vridning: mät om när vyn landat. Glöm inget här: är bredden oförändrad (vyn kan vara fast
    // just då) skulle den fastnade höjden läras in. Ny bredd glöms i onResize och i sample().
    const onOrientation = settle;
    const onResize = () => {
      const w = Math.round(window.innerWidth);
      if (forgetsHealthy("resize", lastWidth, w)) {
        lastWidth = w;
        healthy.reset();
        confirmFrames = 0;
      }
      measure();
    };
    vv.addEventListener("resize", onVvResize);
    vv.addEventListener("scroll", measure);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("orientationchange", onOrientation);
    window.addEventListener("pageshow", settle);
    window.addEventListener("focus", settle);
    document.addEventListener("focusout", settle);
    document.addEventListener("focusin", measure);
    document.addEventListener("visibilitychange", onVisible);
    measure();
    return () => {
      cancelAnimationFrame(raf);
      for (const t of timers) window.clearTimeout(t);
      vv.removeEventListener("resize", onVvResize);
      vv.removeEventListener("scroll", measure);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", measure);
      window.removeEventListener("orientationchange", onOrientation);
      window.removeEventListener("pageshow", settle);
      window.removeEventListener("focus", settle);
      document.removeEventListener("focusout", settle);
      document.removeEventListener("focusin", measure);
      document.removeEventListener("visibilitychange", onVisible);
      probe.remove();
      root.style.removeProperty("--v2-vp-shift");
      root.removeAttribute("data-v2-kb");
    };
  }, []);
  return null;
}

/** `?vp=1` slår på (och minns) en liten mätruta uppe till vänster; `?vp=0` stänger av den. */
function setupDebug(): ((v: Record<string, string | number | boolean>) => void) | null {
  let on = false;
  try {
    const q = new URLSearchParams(window.location.search).get("vp");
    if (q === "1") window.localStorage.setItem(DEBUG_KEY, "1");
    if (q === "0") window.localStorage.removeItem(DEBUG_KEY);
    on = window.localStorage.getItem(DEBUG_KEY) === "1";
  } catch {
    on = false;
  }
  if (!on) return null;
  const box = document.createElement("pre");
  box.setAttribute("data-vp-debug", "");
  box.style.cssText =
    "position:fixed;z-index:2147483647;top:calc(4px + env(safe-area-inset-top,0px));left:4px;margin:0;padding:4px 6px;font:10px/1.3 ui-monospace,monospace;background:rgb(0 0 0/.75);color:#fff;border-radius:4px;pointer-events:none;white-space:pre";
  document.body.appendChild(box);
  return (v) => {
    box.textContent = Object.entries(v)
      .map(([k, val]) => `${k} ${String(val)}`)
      .join("\n");
  };
}
