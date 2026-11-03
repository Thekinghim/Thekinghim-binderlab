"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { cn } from "@/lib/cn";
import { Icon } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/button";
import { StatusGlyph } from "@/components/ui/status-tag";
import { activeRouteId, menuRoutesForRole, primaryMobileRoutes } from "./nav";
import {
  NavList,
  numberRoutes,
  OrgSwitcher,
  SyncStatus,
  syncHref,
  TodoCountSlot,
  UserMenu,
  WithCarriedQuery,
  type ShellNavProps,
} from "./side-nav";

/** Höjden på bottenraden, utan säkerhetsmarginal. Sidans innehåll får lika mycket luft nedtill. */
export const MOBILE_NAV_HEIGHT = 56;

/**
 * Mobil navigering för tummen: en fast bottenrad med de viktigaste
 * rutterna för rollen och "Mer", som öppnar ett ark nedifrån med
 * resten, organisation, synkstatus och kontot. Döljs från lg.
 */
export function MobileNav(props: ShellNavProps) {
  const pathname = usePathname();
  const [open, setOpen] = useState(false);
  const role = props.role ?? "owner";
  const routes = menuRoutesForRole(role);
  const numbering = numberRoutes(routes);
  const primary = primaryMobileRoutes(role, 4);
  const rest = routes.filter((r) => !primary.includes(r));
  // Arket: först de primära sidorna som inte fick plats, sedan "Mer"-gruppen och System.
  const restMain = rest.filter((r) => r.section === "main" && !r.group);
  const restMore = rest.filter((r) => r.section === "main" && r.group === "more");
  const restHidden = rest.filter((r) => r.section === "main" && r.group === "hidden");
  const restSystem = rest.filter((r) => r.section === "system");
  const activeId = activeRouteId(props.activeHref ?? pathname);
  // "Mer" är aktiv bara när den aktiva sidan faktiskt ligger i arket.
  const moreActive = rest.some((r) => r.id === activeId);

  // Stäng arket vid sidbyte.
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    if (open) setOpen(false);
  }

  // Genvägen bara för påfyllaren (ägare och admin når Fyll på från Drift), och inte på
  // fältsidorna som har en egen knapp nedtill.
  const showRefill =
    role === "refiller" && pathname !== "/drift/pafyllning" && !pathname.startsWith("/drift/besok");

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
              {primary.map((r) => {
                const active = r.id === activeId;
                return (
                  <li key={r.id} className="relative">
                    {active ? (
                      <span aria-hidden className="absolute inset-x-3 top-0 h-px bg-fg" />
                    ) : null}
                    <Link
                      href={`${r.href}${query}`}
                      prefetch={false}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "flex h-14 flex-col items-center justify-center gap-1 transition-colors focus-visible:-outline-offset-2",
                        active ? "text-fg" : "text-muted hover:text-fg",
                      )}
                    >
                      <span className="flex h-4 items-center gap-1">
                        <Icon name={r.icon} />
                        {r.counter === "todo" ? (
                          <TodoCountSlot count={props.todoCount} hideZero />
                        ) : null}
                      </span>
                      <span
                        className={cn(
                          "text-xs transition-transform duration-200",
                          active && "-translate-y-px font-medium",
                        )}
                      >
                        {r.label}
                      </span>
                    </Link>
                  </li>
                );
              })}
              <li className="relative">
                {moreActive ? (
                  <span aria-hidden className="absolute inset-x-3 top-0 h-px bg-fg" />
                ) : null}
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
                        <span className="sr-only">Synk misslyckades</span>
                      </>
                    ) : null}
                  </span>
                  <span className={cn("text-xs", moreActive && "font-medium")}>Mer</span>
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
        {rest.length ? (
          <nav aria-label="Fler sidor" className="border-b border-line py-2">
            <WithCarriedQuery>
              {(query) => (
                <>
                  {[restMain, restMore, restHidden, restSystem]
                    .filter((list) => list.length > 0)
                    .map((list, i) => (
                      <div key={i} className={cn(i > 0 && "mt-2 border-t border-line pt-2")}>
                        <NavList
                          routes={list}
                          numbering={numbering}
                          activeId={activeId}
                          query={query}
                          todoCount={props.todoCount}
                          onNavigate={() => setOpen(false)}
                        />
                      </div>
                    ))}
                </>
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
