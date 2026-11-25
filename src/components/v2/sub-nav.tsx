"use client";

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useLayoutEffect, useRef } from "react";

import { activeSubTab, sectionsForRole, subTabHref } from "@/components/shell/nav";
import { WithCarriedQuery, withQuery } from "@/components/shell/side-nav";
import { cn } from "@/lib/cn";

import { useV2Shell } from "./shell/shell-context";

/**
 * Underflikarna (Lönsamhet · Ekonomi · Bokföring …) för en sida som byggts om till V2Page.
 * V2Page döljer skalets gamla underflikar; lägg den här först i sidans innehåll i stället:
 *
 *   <V2Page title="Lönsamhet" period>
 *     <SubNav />
 *     …
 *   </V2Page>
 *
 * Flikarna kommer från menyn (src/components/shell/nav.ts) och rollen, som skalets egna, och
 * period och filter följer med. Inget ritas när rollen ser färre än två flikar.
 */
export function SubNav({ className }: { className?: string }) {
  return (
    <Suspense fallback={<SubNavInner view={null} className={className} />}>
      <SubNavWithView className={className} />
    </Suspense>
  );
}

function SubNavWithView({ className }: { className?: string }) {
  const view = useSearchParams().get("vy");
  return <SubNavInner view={view} className={className} />;
}

function SubNavInner({ view, className }: { view: string | null; className?: string }) {
  const shell = useV2Shell();
  const path = usePathname();
  const hit = activeSubTab(path, view);
  const role = shell?.role;
  const section =
    hit && role ? sectionsForRole(role).find((s) => s.id === hit.section.id) : undefined;
  const activeKey = hit?.tab.key;
  const navRef = useEdgeFade(activeKey);
  // Sidans egen flik måste finnas bland rollens flikar: annars (Mitt konto för en läsare, som
  // inte ser Inställningar) visades sektionens andra flikar utan någon vald.
  if (!hit || !section || section.tabs.length < 2) return null;
  if (!section.tabs.some((t) => t.key === hit.tab.key)) return null;
  return (
    <WithCarriedQuery>
      {(query) => (
        <nav ref={navRef} aria-label={section.label} className={cn("v2-subnav", className)}>
          {section.tabs.map((t) => (
            <Link
              key={t.key}
              href={withQuery(subTabHref(t), query)}
              prefetch={false}
              aria-current={t.key === hit.tab.key ? "page" : undefined}
            >
              {t.short ? (
                <>
                  <span className="sm:hidden">{t.short}</span>
                  <span className="hidden sm:inline">{t.label}</span>
                </>
              ) : (
                t.label
              )}
            </Link>
          ))}
        </nav>
      )}
    </WithCarriedQuery>
  );
}

/**
 * Var raden ska börja så att vänsterkanten visar en hel flik (inte "tällningar"): närmaste
 * flikstart vid eller före det önskade läget, minus 6 px luft. Längst till höger står raden
 * mot sitt slut. 0 om raden inte rullar.
 */
export function wholeItemLeft(wanted: number, max: number, starts: readonly number[]): number {
  if (max <= 0) return 0;
  const target = Math.max(0, Math.min(wanted, max));
  if (target >= max) return max;
  let best = 0;
  for (const s of starts) if (s - 6 <= target) best = Math.max(0, s - 6);
  return Math.min(best, max);
}

/**
 * Telefon: raden rullar i sidled. Vald flik rullas fram (utan att sidan hoppar i höjdled) och
 * kanterna tonas ut där det finns fler flikar (data-more-start / data-more-end, se v2.css).
 */
function useEdgeFade(activeKey: string | undefined) {
  const ref = useRef<HTMLElement | null>(null);
  const cleanup = useRef<(() => void) | null>(null);

  const mark = useCallback((el: HTMLElement) => {
    const max = el.scrollWidth - el.clientWidth;
    el.toggleAttribute("data-more-start", el.scrollLeft > 2);
    el.toggleAttribute("data-more-end", el.scrollLeft < max - 2);
  }, []);

  const reveal = useCallback(
    (el: HTMLElement) => {
      const a = el.querySelector<HTMLElement>('a[aria-current="page"]');
      if (a && el.scrollWidth > el.clientWidth) {
        // Vald flik i mitten om det går; bara sidledes, så sidan inte hoppar.
        const centred = a.offsetLeft - (el.clientWidth - a.offsetWidth) / 2;
        const max = el.scrollWidth - el.clientWidth;
        const starts = Array.from(el.querySelectorAll<HTMLElement>("a")).map((x) => x.offsetLeft);
        el.scrollLeft = wholeItemLeft(centred, max, starts);
      }
      mark(el);
    },
    [mark],
  );

  const setRef = useCallback(
    (el: HTMLElement | null) => {
      cleanup.current?.();
      cleanup.current = null;
      ref.current = el;
      if (!el) return;
      // Tills någon själv rör raden följer vald flik med när raden får sin bredd (typsnitt,
      // layout); därefter bara tonerna.
      let touched = false;
      const onTouch = () => {
        touched = true;
      };
      const onScroll = () => mark(el);
      const onResize = () => (touched ? mark(el) : reveal(el));
      el.addEventListener("scroll", onScroll, { passive: true });
      el.addEventListener("pointerdown", onTouch, { passive: true });
      el.addEventListener("wheel", onTouch, { passive: true });
      const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(onResize);
      ro?.observe(el);
      el.querySelectorAll("a").forEach((a) => ro?.observe(a));
      reveal(el);
      cleanup.current = () => {
        el.removeEventListener("scroll", onScroll);
        el.removeEventListener("pointerdown", onTouch);
        el.removeEventListener("wheel", onTouch);
        ro?.disconnect();
      };
    },
    [mark, reveal],
  );

  // Ny flik vald i samma rad (klientnavigering): rulla fram den.
  useLayoutEffect(() => {
    if (ref.current) reveal(ref.current);
  }, [activeKey, reveal]);

  return setRef;
}
