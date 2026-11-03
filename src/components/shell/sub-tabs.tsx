"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useLayoutEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { activeSubTab, sectionsForRole, subTabHref, type Role, type SubTab } from "./nav";
import { TodoCountSlot, WithCarriedQuery, withQuery, type TodoCountSource } from "./side-nav";

export type SubTabsProps = {
  role: Role;
  /** Sökväg som räknas som aktiv. Standard: aktuell sökväg. */
  activeHref?: string;
  todoCount?: TodoCountSource;
  className?: string;
};

/**
 * Underflikarna för den aktiva huvudfliken, ovanför sidan. Visas bara när rollen ser minst två.
 * Raden rullar i sidled på mobil; markeringen glider mellan flikarna (bara transform) och
 * flyttas direkt vid klick, innan servern svarat.
 */
export function SubTabs(props: SubTabsProps) {
  return (
    <Suspense fallback={<SubTabsInner {...props} view={null} />}>
      <SubTabsWithView {...props} />
    </Suspense>
  );
}

function SubTabsWithView(props: SubTabsProps) {
  const view = useSearchParams().get("vy");
  return <SubTabsInner {...props} view={view} />;
}

function SubTabsInner({
  role,
  activeHref,
  todoCount,
  className,
  view,
}: SubTabsProps & { view: string | null }) {
  const pathname = usePathname();
  const path = activeHref ?? pathname;
  const hit = activeSubTab(path, view);
  const section = hit ? sectionsForRole(role).find((s) => s.id === hit.section.id) : undefined;
  if (!hit || !section || section.tabs.length < 2) return null;
  return (
    <WithCarriedQuery>
      {(query) => (
        <TabRow
          // Ny huvudflik: ny rad, så att markeringen inte glider in från en annan flik.
          key={section.id}
          label={section.label}
          tabs={section.tabs}
          activeKey={hit.tab.key}
          path={path}
          query={query}
          todoCount={todoCount}
          className={className}
        />
      )}
    </WithCarriedQuery>
  );
}

function TabRow({
  label,
  tabs,
  activeKey,
  path,
  query,
  todoCount,
  className,
}: {
  label: string;
  tabs: ReadonlyArray<SubTab>;
  activeKey: string;
  path: string;
  query: string;
  todoCount?: TodoCountSource;
  className?: string;
}) {
  const router = useRouter();
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLAnchorElement>());
  const barRef = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);

  // Klickad flik som väntar på servern: markeringen flyttas direkt. Släpps när adressen ändras.
  const [pending, setPending] = useState<{ key: string; from: string } | null>(null);
  const stamp = `${path}|${activeKey}`;
  // Släpp klicket när adressen ändras, annars tänds det igen när man backar tillbaka.
  const [lastStamp, setLastStamp] = useState(stamp);
  if (lastStamp !== stamp) {
    setLastStamp(stamp);
    setPending(null);
  }
  const current = pending && pending.from === stamp ? pending.key : activeKey;

  useLayoutEffect(() => {
    const place = () => {
      const el = itemRefs.current.get(current);
      const bar = barRef.current;
      if (!el || !bar) return;
      // Första placeringen hoppar på plats; sedan glider den.
      bar.style.transition = placed.current ? "" : "none";
      bar.style.transform = `translateX(${el.offsetLeft}px) scaleX(${el.offsetWidth})`;
      bar.style.opacity = "1";
      if (!placed.current) {
        void bar.offsetWidth;
        bar.style.transition = "";
        placed.current = true;
      }
      const box = scrollRef.current;
      if (box && box.scrollWidth > box.clientWidth) {
        const left = el.offsetLeft - 16;
        const right = el.offsetLeft + el.offsetWidth + 16 - box.clientWidth;
        if (box.scrollLeft > left) box.scrollTo({ left, behavior: "smooth" });
        else if (box.scrollLeft < right) box.scrollTo({ left: right, behavior: "smooth" });
      }
    };
    place();
    const box = scrollRef.current;
    if (!box || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(place);
    ro.observe(box);
    return () => ro.disconnect();
  }, [current]);

  return (
    <nav aria-label={label} className={cn("min-w-0", className)}>
      <div
        ref={scrollRef}
        className="-mx-4 [scrollbar-width:none] overflow-x-auto px-4 md:mx-0 md:px-0 [&::-webkit-scrollbar]:hidden"
      >
        <div className="relative min-w-max border-b border-line">
          <ul className="flex gap-1">
            {tabs.map((t) => {
              const on = t.key === current;
              const href = withQuery(subTabHref(t), query);
              return (
                <li key={t.key}>
                  <Link
                    ref={(el) => {
                      if (el) itemRefs.current.set(t.key, el);
                      else itemRefs.current.delete(t.key);
                    }}
                    href={href}
                    prefetch={false}
                    onMouseEnter={() => router.prefetch(href)}
                    onFocus={() => router.prefetch(href)}
                    onClick={(e) => {
                      if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
                      setPending({ key: t.key, from: stamp });
                    }}
                    aria-current={t.key === activeKey ? "page" : undefined}
                    className={cn(
                      "inline-flex h-10 items-center gap-2 px-3 text-sm whitespace-nowrap transition-colors duration-200 focus-visible:-outline-offset-2",
                      on ? "font-medium text-fg" : "text-muted hover:text-fg",
                    )}
                  >
                    {t.label}
                    {t.route === "att-gora" ? <TodoCountSlot count={todoCount} hideZero /> : null}
                  </Link>
                </li>
              );
            })}
          </ul>
          <span
            ref={barRef}
            aria-hidden
            className="pointer-events-none absolute bottom-[-1px] left-0 h-0.5 w-px origin-left bg-fg opacity-0 transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none"
          />
        </div>
      </div>
    </nav>
  );
}
