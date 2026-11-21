"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useRef, useState } from "react";

import { activeV2NavId, roleLabel, v2NavForRole, type Role } from "@/components/shell/nav";
import type { ShellOrganization, ShellUser, TodoCountSource } from "@/components/shell/side-nav";

import { NavCount } from "./count";
import { NavIcon, V2Logo } from "./nav-icon";

/**
 * V2:s sidomeny (232 px, hopfälld till 78 px under 1 360 px, dold under 900 px): logga, sju
 * poster med räknare, organisation och person längst ner. Organisationen och personen öppnar
 * en liten meny (byt organisation, Mer, logga ut).
 */
export function V2SideNav({
  role,
  todoCount,
  routeCount,
  user,
  organizations,
  activeOrganizationId,
  onOrganizationChange,
  onSignOut,
}: {
  role: Role;
  todoCount?: TodoCountSource;
  /** Antal stopp i dagens rutt (grått tal vid Rutt). */
  routeCount?: TodoCountSource;
  user?: ShellUser;
  organizations?: ShellOrganization[];
  activeOrganizationId?: string;
  onOrganizationChange?: (id: string) => void;
  onSignOut?: () => void;
}) {
  const pathname = usePathname();
  const active = activeV2NavId(pathname);
  const items = v2NavForRole(role);
  const org = organizations?.find((o) => o.id === activeOrganizationId) ?? organizations?.[0];

  return (
    <aside className="v2-side" aria-label="Meny">
      <Link
        href={items[0]?.href ?? "/"}
        className="v2-brand"
        aria-label="Binderlab, till startsidan"
      >
        <V2Logo />
        <span>Binderlab</span>
      </Link>
      <nav aria-label="Huvudmeny" className="contents">
        {items.map((item) => (
          <Link
            key={item.id}
            href={item.href}
            className="v2-nav"
            aria-current={active === item.id ? "page" : undefined}
          >
            <NavIcon name={item.id} />
            <span>{item.label}</span>
            {item.counter === "todo" ? <NavCount count={todoCount} /> : null}
            {item.counter === "rutt" ? (
              <NavCount count={routeCount} neutral label="stopp i dag" />
            ) : null}
          </Link>
        ))}
      </nav>
      <WhoMenu
        role={role}
        user={user}
        org={org}
        organizations={organizations ?? []}
        onOrganizationChange={onOrganizationChange}
        onSignOut={onSignOut}
      />
    </aside>
  );
}

function initial(text: string | undefined): string {
  return (text ?? "?").trim().charAt(0).toUpperCase() || "?";
}

function WhoMenu({
  role,
  user,
  org,
  organizations,
  onOrganizationChange,
  onSignOut,
}: {
  role: Role;
  user?: ShellUser;
  org?: ShellOrganization;
  organizations: ShellOrganization[];
  onOrganizationChange?: (id: string) => void;
  onSignOut?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: PointerEvent | KeyboardEvent) => {
      if (
        e instanceof KeyboardEvent ? e.key === "Escape" : !root.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", close);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", close);
    };
  }, [open]);

  return (
    <div ref={root} className="relative mt-auto">
      {open ? (
        <div
          role="menu"
          className="absolute bottom-full left-0 z-30 mb-2 w-60 overflow-hidden rounded-v2-lg bg-v2-panel py-1 text-v2-sm shadow-[0_0_0_1px_var(--v2-line),0_10px_30px_rgb(0_0_0/0.1)]"
        >
          <div className="px-3 py-2 text-v2-xs text-v2-mute">
            {user?.email ?? user?.name} · {roleLabel[role]}
          </div>
          {organizations.length > 1
            ? organizations.map((o) => (
                <button
                  key={o.id}
                  type="button"
                  role="menuitemradio"
                  aria-checked={o.id === org?.id}
                  className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-v2-hover"
                  onClick={() => {
                    setOpen(false);
                    if (o.id !== org?.id) onOrganizationChange?.(o.id);
                  }}
                >
                  <span className="truncate">{o.name}</span>
                  {o.id === org?.id ? <span aria-hidden="true">✓</span> : null}
                </button>
              ))
            : null}
          <Link
            role="menuitem"
            href="/mer"
            className="block px-3 py-2 hover:bg-v2-hover"
            onClick={() => setOpen(false)}
          >
            Alla sidor och inställningar
          </Link>
          {onSignOut ? (
            <button
              type="button"
              role="menuitem"
              className="block w-full px-3 py-2 text-left hover:bg-v2-hover"
              onClick={() => {
                setOpen(false);
                onSignOut();
              }}
            >
              Logga ut
            </button>
          ) : null}
        </div>
      ) : null}
      <button
        type="button"
        className="v2-who"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        title={org?.name}
      >
        <span className="v2-av" aria-hidden="true">
          {initial(org?.name ?? user?.name)}
        </span>
        <div className="min-w-0">
          <div className="truncate text-v2-md font-[650]">{org?.name ?? user?.name}</div>
          <div className="truncate text-v2-xs text-v2-mute">{org?.detail ?? user?.name}</div>
        </div>
      </button>
    </div>
  );
}
