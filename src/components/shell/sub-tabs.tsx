"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import {
  activeSubTab,
  sectionsForRole,
  splitSubTabs,
  subTabHref,
  type Role,
  type SubTab,
} from "./nav";
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
 * Med många flikar ligger de mindre använda under "Mer" (en meny som fungerar med tangentbord),
 * så att raden får plats på mobilen. Raden rullar i sidled om den ändå inte får plats;
 * markeringen glider mellan flikarna (bara transform) och flyttas direkt vid klick, innan
 * servern svarat.
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

const TAB_CLASS =
  "inline-flex h-10 items-center gap-2 px-2.5 text-sm whitespace-nowrap transition-colors duration-200 focus-visible:-outline-offset-2 sm:px-3";

function TabLabel({ tab }: { tab: SubTab }) {
  if (!tab.short) return <>{tab.label}</>;
  return (
    <>
      <span className="sm:hidden">{tab.short}</span>
      <span className="hidden sm:inline">{tab.label}</span>
    </>
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
  const rowRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef(new Map<string, HTMLElement>());
  const barRef = useRef<HTMLSpanElement>(null);
  const placed = useRef(false);
  const { inline, more } = splitSubTabs(tabs);
  const MORE_KEY = "__mer__";

  // Klickad flik som väntar på servern: markeringen flyttas direkt. Släpps när adressen ändras.
  const [pending, setPending] = useState<{ key: string; from: string } | null>(null);
  const stamp = `${path}|${activeKey}`;
  // Släpp klicket när adressen ändras, annars tänds det igen när man backar tillbaka.
  const [lastStamp, setLastStamp] = useState(stamp);
  const [menuOpen, setMenuOpen] = useState(false);
  if (lastStamp !== stamp) {
    setLastStamp(stamp);
    setPending(null);
    setMenuOpen(false);
  }
  const current = pending && pending.from === stamp ? pending.key : activeKey;
  const currentInMore = more.find((t) => t.key === current) ?? null;
  // Markeringen står under "Mer" när den aktiva fliken ligger där.
  const markKey = currentInMore ? MORE_KEY : current;

  useLayoutEffect(() => {
    const place = () => {
      const el = itemRefs.current.get(markKey);
      const bar = barRef.current;
      const row = rowRef.current;
      if (!el || !bar || !row) return;
      const left = el.getBoundingClientRect().left - row.getBoundingClientRect().left;
      // Första placeringen hoppar på plats; sedan glider den.
      bar.style.transition = placed.current ? "" : "none";
      bar.style.transform = `translateX(${left}px) scaleX(${el.offsetWidth})`;
      bar.style.opacity = "1";
      if (!placed.current) {
        void bar.offsetWidth;
        bar.style.transition = "";
        placed.current = true;
      }
    };
    const box = scrollRef.current;
    const el = itemRefs.current.get(markKey);
    if (box && el && box.contains(el) && box.scrollWidth > box.clientWidth) {
      const left = el.offsetLeft - 16;
      const right = el.offsetLeft + el.offsetWidth + 16 - box.clientWidth;
      if (box.scrollLeft > left) box.scrollTo({ left, behavior: "smooth" });
      else if (box.scrollLeft < right) box.scrollTo({ left: right, behavior: "smooth" });
    }
    place();
    if (!box) return;
    // Raden rullar: markeringen följer med (utan glidning, den ska sitta fast under fliken).
    const onScroll = () => {
      const bar = barRef.current;
      if (bar) bar.style.transition = "none";
      place();
      if (bar) requestAnimationFrame(() => (bar.style.transition = ""));
    };
    box.addEventListener("scroll", onScroll, { passive: true });
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(place);
    ro?.observe(box);
    return () => {
      box.removeEventListener("scroll", onScroll);
      ro?.disconnect();
    };
  }, [markKey]);

  const link = (t: SubTab, onPick?: () => void, extra?: string) => {
    const href = withQuery(subTabHref(t), query);
    return (
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
          onPick?.();
        }}
        aria-current={t.key === activeKey ? "page" : undefined}
        className={cn(
          extra ?? TAB_CLASS,
          t.key === current ? "font-medium text-fg" : "text-muted hover:text-fg",
        )}
      >
        <TabLabel tab={t} />
        {t.route === "att-gora" ? <TodoCountSlot count={todoCount} hideZero /> : null}
      </Link>
    );
  };

  return (
    <nav aria-label={label} className={cn("min-w-0", className)}>
      <div ref={rowRef} className="relative flex min-w-0 items-stretch border-b border-line">
        <div
          ref={scrollRef}
          // Under md tonar högerkanten ut, så att man ser att raden går att rulla.
          className="-ml-4 min-w-0 [scrollbar-width:none] overflow-x-auto pl-4 max-md:[mask-image:linear-gradient(to_right,black_calc(100%-1.5rem),transparent)] max-md:pr-6 md:ml-0 md:pl-0 [&::-webkit-scrollbar]:hidden"
        >
          <ul className="flex min-w-max gap-1">
            {inline.map((t) => (
              <li key={t.key}>{link(t)}</li>
            ))}
          </ul>
        </div>
        {more.length > 0 ? (
          <MoreMenu
            active={currentInMore}
            open={menuOpen}
            onOpenChange={setMenuOpen}
            triggerRef={(el) => {
              if (el) itemRefs.current.set(MORE_KEY, el);
              else itemRefs.current.delete(MORE_KEY);
            }}
            items={more.map((t) => ({
              key: t.key,
              node: link(
                t,
                () => setMenuOpen(false),
                "flex h-11 w-full items-center gap-2 rounded-sm px-3 text-sm whitespace-nowrap transition-colors duration-fast hover:bg-hover focus-visible:-outline-offset-2",
              ),
            }))}
          />
        ) : null}
        <span
          ref={barRef}
          aria-hidden
          className="pointer-events-none absolute bottom-[-1px] left-0 h-0.5 w-px origin-left bg-fg opacity-0 transition-transform duration-300 ease-[cubic-bezier(0.2,0.8,0.2,1)] motion-reduce:transition-none"
        />
      </div>
    </nav>
  );
}

/**
 * "Mer": knappen visar flikarna som inte får plats. Öppnas med klick, Enter, mellanslag
 * eller pil ned (fokus till första fliken); pilarna flyttar, Esc stänger och lämnar fokus på
 * knappen, och ett klick utanför eller Tab ut stänger. Är en av flikarna aktiv heter
 * knappen som den, så att man ser var man är.
 */
function MoreMenu({
  active,
  open,
  onOpenChange,
  triggerRef,
  items,
}: {
  active: SubTab | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  triggerRef: (el: HTMLButtonElement | null) => void;
  items: ReadonlyArray<{ key: string; node: ReactNode }>;
}) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const focusFirst = useRef(false);
  const id = useId();

  const links = () => [...(listRef.current?.querySelectorAll<HTMLElement>("a[href]") ?? [])];
  const close = (refocus: boolean) => {
    onOpenChange(false);
    if (refocus) requestAnimationFrame(() => buttonRef.current?.focus());
  };

  useEffect(() => {
    if (!open) return;
    if (focusFirst.current) {
      focusFirst.current = false;
      requestAnimationFrame(() => links()[0]?.focus());
    }
    const onDown = (e: PointerEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) onOpenChange(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open, onOpenChange]);

  const onButtonKey = (e: KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown" || ((e.key === "Enter" || e.key === " ") && !open)) {
      e.preventDefault();
      focusFirst.current = true;
      if (open) links()[0]?.focus();
      else onOpenChange(true);
    } else if (e.key === "Escape" && open) {
      e.preventDefault();
      close(true);
    }
  };

  const onListKey = (e: KeyboardEvent<HTMLUListElement>) => {
    const list = links();
    const at = list.indexOf(document.activeElement as HTMLElement);
    const go = (i: number) => list[(i + list.length) % list.length]?.focus();
    if (e.key === "ArrowDown") go(at + 1);
    else if (e.key === "ArrowUp") go(at - 1);
    else if (e.key === "Home") go(0);
    else if (e.key === "End") go(list.length - 1);
    else if (e.key === "Escape") close(true);
    else return;
    e.preventDefault();
  };

  return (
    <div
      ref={wrapRef}
      className="relative shrink-0"
      onBlur={(e) => {
        // Tab ut ur menyn stänger den.
        if (open && !wrapRef.current?.contains(e.relatedTarget as Node | null)) onOpenChange(false);
      }}
    >
      <button
        ref={(el) => {
          buttonRef.current = el;
          triggerRef(el);
        }}
        type="button"
        aria-expanded={open}
        aria-controls={id}
        onClick={() => onOpenChange(!open)}
        onKeyDown={onButtonKey}
        className={cn(
          TAB_CLASS,
          "pr-2 sm:pr-2.5",
          active ? "font-medium text-fg" : open ? "text-fg" : "text-muted hover:text-fg",
        )}
      >
        {active ? (
          <>
            <span className="sr-only">Mer: </span>
            <TabLabel tab={active} />
          </>
        ) : (
          "Mer"
        )}
        <Icon
          name="chevronDown"
          size={12}
          className={cn(
            "transition-transform duration-200 motion-reduce:transition-none",
            open && "rotate-180",
          )}
        />
      </button>
      <ul
        ref={listRef}
        id={id}
        hidden={!open}
        onKeyDown={onListKey}
        className="shadow-lg absolute top-full right-0 z-40 mt-1 flex min-w-44 animate-enter flex-col rounded-md border border-line-strong bg-surface p-1 md:right-auto md:left-0"
      >
        {items.map((it) => (
          <li key={it.key}>{it.node}</li>
        ))}
      </ul>
    </div>
  );
}
