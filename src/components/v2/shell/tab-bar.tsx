"use client";

import { usePathname } from "next/navigation";
import { useEffect, useRef, type RefObject } from "react";

import { activeV2NavId, v2MobileNavForRole, type Role } from "@/components/shell/nav";
import type { TodoCountSource } from "@/components/shell/side-nav";

import { NavCount } from "./count";
import { PeriodLink } from "./period-link";
import { NavIcon } from "./nav-icon";
import { isTypingTarget, pinShift } from "./viewport-pin";

/**
 * Mobilens bottenrad (under 900 px): Hem, Automater, Rutt, Lager, Mer (det rollen får se).
 * Butiker och Pengar ligger överst på Mer. Tryck på aktiv flik = till toppen. Säkra
 * marginaler runt hemindikatorn (env(safe-area-inset-*)).
 */
export function V2TabBar({ role, todoCount }: { role: Role; todoCount?: TodoCountSource }) {
  const pathname = usePathname();
  const active = activeV2NavId(pathname);
  const items = v2MobileNavForRole(role);
  const ref = useRef<HTMLElement>(null);
  useViewportPin(ref);
  return (
    <nav ref={ref} className="v2-tabs" aria-label="Flikar">
      {items.map((item) => {
        const on =
          active === item.id ||
          // Butiker och Pengar nås från Mer på telefonen.
          (item.id === "mer" && (active === "butiker" || active === "pengar"));
        return (
          <PeriodLink
            key={item.id}
            href={item.href}
            aria-current={on ? "page" : undefined}
            onClick={(e) => {
              if (on && pathname === item.href) {
                e.preventDefault();
                window.scrollTo({ top: 0, behavior: "smooth" });
              }
            }}
          >
            <span className="ic">
              <NavIcon name={item.mobileIcon ?? item.id} />
              {item.counter === "todo" ? <NavCount count={todoCount} /> : null}
            </span>
            {item.short ?? item.label}
          </PeriodLink>
        );
      })}
    </nav>
  );
}

/**
 * Rättar iPhones fel där bottenraden hamnar mitt på skärmen (se viewport-pin.ts).
 * Mäter vid allt som kan ändra vyn och sätter --v2-tabs-shift; puffar även Safari
 * att räkna om vyn när tangentbordet stängs eller appen kommer tillbaka.
 */
function useViewportPin(ref: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const el = ref.current;
    const vv = window.visualViewport;
    if (!el || !vv) return;
    let shift = 0;
    let raf = 0;
    const timers: number[] = [];
    const measure = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => {
        const rect = el.getBoundingClientRect();
        const next = pinShift({
          rectBottom: rect.bottom,
          currentShift: shift,
          rectHeight: rect.height,
          visibleBottom: vv.offsetTop + vv.height,
          scale: vv.scale,
          typing: isTypingTarget(document.activeElement),
        });
        if (next !== shift) {
          shift = next;
          if (next) el.style.setProperty("--v2-tabs-shift", `${next}px`);
          else el.style.removeProperty("--v2-tabs-shift");
        }
      });
    };
    // Efter tangentbord/återkomst: låt Safari landa, puffa vyn och mät igen.
    const settle = () => {
      measure();
      for (const ms of [120, 400, 900]) {
        timers.push(
          window.setTimeout(() => {
            if (ms === 120 && !isTypingTarget(document.activeElement)) {
              window.scrollTo(window.scrollX, window.scrollY);
            }
            measure();
          }, ms),
        );
      }
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") settle();
    };
    vv.addEventListener("resize", measure);
    vv.addEventListener("scroll", measure);
    window.addEventListener("resize", measure);
    window.addEventListener("scroll", measure, { passive: true });
    window.addEventListener("orientationchange", settle);
    window.addEventListener("pageshow", settle);
    document.addEventListener("focusout", settle);
    document.addEventListener("focusin", measure);
    document.addEventListener("visibilitychange", onVisible);
    measure();
    return () => {
      cancelAnimationFrame(raf);
      for (const t of timers) window.clearTimeout(t);
      vv.removeEventListener("resize", measure);
      vv.removeEventListener("scroll", measure);
      window.removeEventListener("resize", measure);
      window.removeEventListener("scroll", measure);
      window.removeEventListener("orientationchange", settle);
      window.removeEventListener("pageshow", settle);
      document.removeEventListener("focusout", settle);
      document.removeEventListener("focusin", measure);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [ref]);
}
