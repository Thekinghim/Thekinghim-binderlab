"use client";

import { useEffect } from "react";

import { reportViewportSample } from "@/components/pwa/client-error-report";

import {
  forgetsHealthy,
  HealthyTracker,
  isTypingTarget,
  keyboardUp,
  looksStuck,
  pinDecision,
  RELEARN_MS,
  STUCK_MIN_GAP,
} from "./viewport-pin";
import { REPORT_EVERY_MS, reportDue, SnapshotRing, vpReport } from "./viewport-pin-telemetry";

const DEBUG_KEY = "binderlab:vp-debug";

/**
 * Rättar iPhones fel där bottenraden hamnar mitt på skärmen (se viewport-pin.ts). Monteras en
 * gång i rotlayouten och sätter `--v2-vp-shift` på <html>; bottenraden, notiserna och de fasta
 * knapparna nedtill räknar med den. Sätter även `data-v2-kb` medan tangentbordet syns, så att
 * bottenraden inte står mitt i vägen ovanför det.
 *
 * Felsökning på telefonen: öppna valfri sida med `?vp=1` (av: `?vp=0`) så visas måtten uppe
 * till vänster. I hemskärmsappen skickas dessutom de senaste måtten till klientfelen när raden
 * flyttas, när skyddet mot en för liten förskjutning slår till eller när raden hamnar nedanför
 * den friska höjden (viewport-pin-telemetry.ts).
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
    // Fältdata (bara hemskärmsappen): de senaste måtten och när appen senast kom tillbaka.
    const ring = new SnapshotRing();
    let resumedAt = performance.now();
    let reportTimer = 0;
    let pendingReason = "";
    let quietUntil = 0;
    let recheckTimer = 0;
    let event = "start";

    let lastGap = 0;
    // Ett glapp i storlek med statusraden (som skyddet inte flyttar): värt att se i fältdatan.
    const smallGap = (gap: number) => gap >= 20 && gap < STUCK_MIN_GAP;
    // Det fasta innehållet hamnar nedanför den friska höjden (WebKit ritar raden under
    // skärmkanten, något vi aldrig rättar uppåt): just det felet vill vi se i fältdatan.
    const below = (gap: number) => gap <= -20;
    const minor = (reason: string) => reason === "small gap" || reason === "below";

    const report = (reason: string, stillTrue: () => boolean = () => true) => {
      if (!useHealthy || Date.now() < quietUntil) return;
      // En väntande "small gap"/"below" får ge plats åt en flyttad rad eller en omlärd höjd.
      if (reportTimer && (!minor(pendingReason) || minor(reason))) return;
      window.clearTimeout(reportTimer);
      pendingReason = reason;
      // Vänta lite så att raderna också visar vad som hände efteråt.
      reportTimer = window.setTimeout(() => {
        reportTimer = 0;
        // Bara ett glapp som håller i sig (inte en bildruta medan tangentbordet går ner).
        if (!stillTrue()) return;
        quietUntil = Date.now() + REPORT_EVERY_MS;
        reportViewportSample(reason, vpReport(ring.rows(), screenMax), reportDue);
      }, 2000);
    };

    const measure = (ev = "measure") => {
      event = ev;
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const cause = event;
        const typing = isTypingTarget(document.activeElement);
        const naturalBottom = probe.getBoundingClientRect().bottom;
        const visibleBottom = vv.offsetTop + vv.height;
        // Ett vaul-ark är öppet (eller låser body): mätningen kan påverkas, lär inget då.
        const drawerOpen =
          document.querySelector("[data-vaul-drawer]") !== null ||
          document.body.style.position === "fixed";
        const scrollY = window.scrollY;
        let healthyBottom = 0;
        let relearned = false;
        if (useHealthy) {
          const r = healthy.sample({
            innerWidth: window.innerWidth,
            innerHeight: window.innerHeight,
            vvWidth: vv.width,
            vvHeight: vv.height,
            vvTop: vv.offsetTop,
            naturalBottom,
            typing,
            scale: vv.scale,
            blocked: drawerOpen,
            now: performance.now(),
            screenMin,
            screenMax,
          });
          healthyBottom = r.healthy;
          relearned = r.relearned;
          if (r.confirm && confirmFrames < 30) {
            confirmFrames++;
            measure("confirm"); // nästa bildruta
          } else if (!r.confirm) {
            confirmFrames = 0;
          }
          // En lägre höjd väntar på att ligga still: mät igen när den gjort det.
          if (r.recheck && !recheckTimer) {
            recheckTimer = window.setTimeout(() => {
              recheckTimer = 0;
              measure("recheck");
            }, RELEARN_MS + 100);
          }
        }
        const decision = pinDecision({
          naturalBottom,
          visibleBottom,
          visibleTop: vv.offsetTop,
          healthyBottom,
          scale: vv.scale,
          typing,
          learned: useHealthy,
        });
        const next = decision.shift;
        if (useHealthy) {
          ring.push({
            ev: cause,
            inner: window.innerHeight,
            vvH: vv.height,
            vvTop: vv.offsetTop,
            fixedBottom: naturalBottom,
            healthy: healthyBottom,
            shift: next,
            gap: decision.gap,
            scrollY,
            msResume: performance.now() - resumedAt,
            drawerOpen,
          });
          lastGap = typing ? 0 : decision.gap;
          if (next > 0 && shift === 0) report("shift");
          else if (relearned) report("relearn");
          else if (smallGap(lastGap)) report("small gap", () => smallGap(lastGap));
          else if (healthyBottom > 0 && below(lastGap)) report("below", () => below(lastGap));
        }
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
          gap: decision.gap,
          drawer: drawerOpen,
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
        measure("nudge");
      });
    };

    // Efter tangentbord, ark eller återkomst: låt Safari landa, puffa vyn och mät igen.
    const settle = (ev: string) => {
      measure(ev);
      for (const ms of [120, 400, 900]) {
        timers.push(
          window.setTimeout(() => {
            if (ms === 120) nudge();
            measure(`t${ms}`);
          }, ms),
        );
      }
    };
    const resumed = (ev: string) => {
      resumedAt = performance.now();
      settle(ev);
    };
    const onVvResize = () => {
      // Tangentbordet stängdes (vyn blev mycket högre): samma städning som vid blur.
      if (vv.height - lastVvHeight >= 60) settle("vvresize");
      else measure("vvresize");
      lastVvHeight = vv.height;
    };
    const onVvScroll = () => measure("vvscroll");
    const onScroll = () => measure("scroll");
    const onPageShow = () => resumed("pageshow");
    const onFocus = () => resumed("focus");
    const onFocusOut = () => settle("focusout");
    const onFocusIn = () => measure("focusin");
    const onVisible = () => {
      if (document.visibilityState === "visible") resumed("visible");
    };
    let lastWidth = Math.round(window.innerWidth);
    // Vridning: mät om när vyn landat. Glöm inget här: är bredden oförändrad (vyn kan vara fast
    // just då) skulle den fastnade höjden läras in. Ny bredd glöms i onResize och i sample().
    const onOrientation = () => settle("orient");
    const onResize = () => {
      const w = Math.round(window.innerWidth);
      if (forgetsHealthy("resize", lastWidth, w)) {
        lastWidth = w;
        healthy.reset();
        confirmFrames = 0;
      }
      measure("resize");
    };
    vv.addEventListener("resize", onVvResize);
    vv.addEventListener("scroll", onVvScroll);
    window.addEventListener("resize", onResize);
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("orientationchange", onOrientation);
    window.addEventListener("pageshow", onPageShow);
    window.addEventListener("focus", onFocus);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("focusin", onFocusIn);
    document.addEventListener("visibilitychange", onVisible);
    measure("start");
    return () => {
      cancelAnimationFrame(raf);
      for (const t of timers) window.clearTimeout(t);
      window.clearTimeout(reportTimer);
      window.clearTimeout(recheckTimer);
      vv.removeEventListener("resize", onVvResize);
      vv.removeEventListener("scroll", onVvScroll);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("orientationchange", onOrientation);
      window.removeEventListener("pageshow", onPageShow);
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("focusin", onFocusIn);
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
