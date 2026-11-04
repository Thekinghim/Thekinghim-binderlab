"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/button";
import { StatusGlyph } from "@/components/ui/status-tag";
import { showsRefillShortcut } from "./fab";
import {
  activeRouteId,
  activeSectionId,
  sectionHref,
  sectionsForRole,
  subTabHref,
  type SectionId,
} from "./nav";
import {
  OrgSwitcher,
  SyncStatus,
  syncHref,
  TodoCountSlot,
  UserMenu,
  WithCarriedQuery,
  withQuery,
  type ShellNavProps,
} from "./side-nav";

/** Höjden på bottenraden, utan säkerhetsmarginal. Sidans innehåll får lika mycket luft nedtill. */
export const MOBILE_NAV_HEIGHT = 56;

/**
 * Mobil navigering för tummen: en fast bottenrad med huvudflikarna och "Mer",
 * som öppnar ett ark nedifrån med Mer-flikens sidor, organisation, synkstatus
 * och kontot. Underflikarna visas ovanför sidan (SubTabs). Döljs från lg.
 */
export function MobileNav(props: ShellNavProps) {
  const pathname = usePathname();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const role = props.role ?? "owner";
  const sections = sectionsForRole(role);
  // Bottenraden: huvudflikarna utom Mer (högst fem), sedan Mer som öppnar arket.
  const primary = sections.filter((s) => s.id !== "mer").slice(0, 5);
  const mer = sections.find((s) => s.id === "mer");
  const activeId = activeSectionId(props.activeHref ?? pathname);
  const routeId = activeRouteId(props.activeHref ?? pathname);
  const moreActive = activeId === "mer";
  const [clicked, setClicked] = useState<{ id: SectionId; from: string } | null>(null);
  const current = clicked && clicked.from === pathname ? clicked.id : activeId;

  // Stäng arket vid sidbyte.
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    if (open) setOpen(false);
    // Släpp klicket, annars tänds fliken igen när man backar tillbaka.
    setClicked(null);
  }

  // Genvägen bara för påfyllaren (ägare och admin når Fyll på från Drift), och inte på
  // fältsidorna som har en egen knapp nedtill.
  const showRefill = showsRefillShortcut(role, pathname);

  return (
    <>
      {showRefill ? (
        // Genväg till Fyll på (mobilsidan vid automaten), ovanför bottenraden.
        <Link
          href="/fyll-pa"
          prefetch={false}
          className="fixed right-4 bottom-[calc(56px+12px+env(safe-area-inset-bottom))] z-30 inline-flex h-11 items-center gap-2 rounded-full border border-inverse bg-inverse pr-4 pl-3 text-md font-medium text-on-inverse shadow-[0_8px_24px_-8px_rgb(0_0_0/0.5)] transition-transform active:scale-95 lg:hidden"
        >
          <Icon name="plus" />
          Fyll på
        </Link>
      ) : null}
      <nav
        aria-label="Snabbmeny"
        className="fixed inset-x-0 bottom-0 z-30 border-t border-line bg-bg pb-[env(safe-area-inset-bottom)] lg:hidden"
      >
        <WithCarriedQuery>
          {(query) => (
            <ul
              className="grid"
              style={{ gridTemplateColumns: `repeat(${primary.length + 1}, minmax(0, 1fr))` }}
            >
              {primary.map((s) => {
                const active = s.id === current;
                const href = withQuery(sectionHref(s), query);
                return (
                  <li key={s.id} className="relative">
                    <span
                      aria-hidden
                      className={cn(
                        "absolute inset-x-3 top-0 h-0.5 origin-center bg-fg transition-transform duration-300 motion-reduce:transition-none",
                        active ? "scale-x-100" : "scale-x-0",
                      )}
                    />
                    <Link
                      href={href}
                      prefetch={false}
                      onTouchStart={() => router.prefetch(href)}
                      onClick={() => setClicked({ id: s.id, from: pathname })}
                      aria-current={s.id === activeId ? "page" : undefined}
                      className={cn(
                        "flex h-14 flex-col items-center justify-center gap-1 transition-colors focus-visible:-outline-offset-2",
                        active ? "text-fg" : "text-muted hover:text-fg",
                      )}
                    >
                      <span className="flex h-4 items-center gap-1">
                        <Icon
                          name={s.icon}
                          className={cn(
                            "transition-transform duration-200",
                            active && "-translate-y-0.5 scale-110",
                          )}
                        />
                        {s.tabs.some((t) => t.route === "att-gora") ? (
                          <TodoCountSlot count={props.todoCount} hideZero />
                        ) : null}
                      </span>
                      <span
                        className={cn(
                          "max-w-full truncate px-0.5 text-[11px] leading-none",
                          active && "font-medium",
                        )}
                      >
                        {s.label}
                      </span>
                    </Link>
                  </li>
                );
              })}
              <li className="relative">
                <span
                  aria-hidden
                  className={cn(
                    "absolute inset-x-3 top-0 h-0.5 origin-center bg-fg transition-transform duration-300 motion-reduce:transition-none",
                    moreActive ? "scale-x-100" : "scale-x-0",
                  )}
                />
                <button
                  type="button"
                  aria-haspopup="dialog"
                  aria-expanded={open}
                  onClick={() => setOpen(true)}
                  className={cn(
                    "flex h-14 w-full flex-col items-center justify-center gap-1 transition-colors focus-visible:-outline-offset-2",
                    moreActive ? "text-fg" : "text-muted hover:text-fg",
                  )}
                >
                  <span className="flex h-4 items-center gap-1">
                    <Icon name="more" />
                    {props.syncState === "failed" ? (
                      <>
                        <StatusGlyph status="critical" size={6} />
                        <span className="sr-only">Awish svarar inte</span>
                      </>
                    ) : null}
                  </span>
                  <span className={cn("text-[11px] leading-none", moreActive && "font-medium")}>
                    Mer
                  </span>
                </button>
              </li>
            </ul>
          )}
        </WithCarriedQuery>
      </nav>

      <MoreSheet open={open} onClose={() => setOpen(false)}>
        {props.organizations?.length ? (
          <div className="border-b border-line">
            <OrgSwitcher
              organizations={props.organizations}
              activeOrganizationId={props.activeOrganizationId}
              onOrganizationChange={props.onOrganizationChange}
            />
          </div>
        ) : null}
        {mer ? (
          <nav aria-label="Fler sidor" className="border-b border-line py-2">
            <WithCarriedQuery>
              {(query) => (
                <ul className="flex flex-col">
                  {mer.tabs.map((t, i) => {
                    const active = t.route === routeId;
                    return (
                      <li
                        key={t.key}
                        className="rise relative"
                        style={{ "--i": i } as React.CSSProperties}
                      >
                        {active ? (
                          <span aria-hidden className="absolute inset-y-0 left-0 w-0.5 bg-fg" />
                        ) : null}
                        <Link
                          href={withQuery(subTabHref(t), query)}
                          prefetch={false}
                          onClick={() => setOpen(false)}
                          aria-current={active ? "page" : undefined}
                          className={cn(
                            "flex h-11 items-center gap-3 px-4 text-base transition-colors focus-visible:-outline-offset-2",
                            active ? "font-medium text-fg" : "text-muted hover:text-fg",
                          )}
                        >
                          {t.label}
                        </Link>
                      </li>
                    );
                  })}
                </ul>
              )}
            </WithCarriedQuery>
          </nav>
        ) : null}
        <SyncStatus
          syncedAt={props.syncedAt}
          syncState={props.syncState}
          timeZone={props.timeZone}
          href={syncHref(role)}
          className="border-b border-line px-4 py-3"
        />
        <UserMenu
          user={props.user}
          role={role}
          onSignOut={props.onSignOut}
          signOutHref={props.signOutHref}
        />
      </MoreSheet>
    </>
  );
}

/** Ark nedifrån, byggt på <dialog>: fokusfälla, Esc och inert bakgrund. */
function MoreSheet({
  open,
  onClose,
  children,
}: {
  open: boolean;
  onClose: () => void;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label="Mer"
      onClose={onClose}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="m-0 mt-auto max-h-[85dvh] w-full max-w-none rounded-t-md border-0 border-t border-line-strong bg-bg p-0 text-fg backdrop:bg-overlay lg:hidden"
    >
      <div
        className="pb-[env(safe-area-inset-bottom)]"
        style={{ animation: "bl-enter var(--bl-dur-slow) var(--bl-ease)" }}
      >
        <div className="flex h-12 items-center justify-between border-b border-line pr-2 pl-4">
          <p className="label text-subtle">Mer</p>
          <IconButton icon="close" label="Stäng" size="sm" onClick={onClose} />
        </div>
        {children}
      </div>
    </dialog>
  );
}
