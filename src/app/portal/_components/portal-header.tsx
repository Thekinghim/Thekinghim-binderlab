"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";

import { Wordmark } from "@/components/brand/wordmark";
import { IconButton } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { logout } from "@/server/actions/auth";
import { selectPortalStore } from "@/server/portal/actions";

import { PortalThemeToggle } from "./portal-theme";
import type { PortalTheme } from "./theme-script";

export type PortalNavItem = { href: string; label: string };

export const PORTAL_NAV: readonly PortalNavItem[] = [
  { href: "/portal", label: "Översikt" },
  { href: "/portal/rapporter", label: "Rapporter" },
  { href: "/portal/felanmalan", label: "Felanmälan" },
];

function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/portal") return pathname === "/portal";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Portalens huvud: märket, butikens namn och operatören, tre menyval, tema och
 * utloggning. Inga appmenyer: butiken når aldrig appen.
 */
export function PortalHeader({
  store,
  stores,
  email,
  theme,
}: {
  theme: PortalTheme;
  store: { id: string; name: string; operator: string } | null;
  stores: ReadonlyArray<{ id: string; name: string }>;
  email: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <header className="border-b border-line bg-bg" data-print="hide">
      <div className="mx-auto flex max-w-[1120px] items-center justify-between gap-4 px-4 pt-4 pb-3 md:px-8">
        <div className="flex min-w-0 items-baseline gap-3">
          <Link
            href="/portal"
            className="shrink-0 rounded-xs"
            aria-label="Butiksportalen, översikt"
          >
            <Wordmark size="sm" />
          </Link>
          <span aria-hidden className="label hidden text-faint sm:inline">
            /
          </span>
          <span className="label hidden truncate text-subtle sm:inline">Butiksportal</span>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <span className="meta mr-2 hidden max-w-[220px] truncate text-subtle md:inline">
            {email}
          </span>
          <PortalThemeToggle initial={theme} />
          <IconButton
            icon="logout"
            label="Logga ut"
            disabled={pending}
            onClick={() =>
              startTransition(async () => {
                await logout();
                router.replace("/logga-in");
                router.refresh();
              })
            }
          />
        </div>
      </div>
      {store ? (
        <div className="mx-auto flex max-w-[1120px] flex-col gap-3 px-4 pb-0 md:flex-row md:items-end md:justify-between md:px-8">
          <div className="min-w-0">
            {stores.length > 1 ? (
              <label className="flex flex-col gap-1">
                <span className="label text-subtle">Butik</span>
                <select
                  className="h-9 max-w-full min-w-0 rounded-sm border border-line-control bg-bg px-3 text-base text-fg"
                  value={store.id}
                  disabled={pending}
                  onChange={(e) => {
                    const id = e.target.value;
                    startTransition(async () => {
                      await selectPortalStore(id);
                      router.refresh();
                    });
                  }}
                >
                  {stores.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
                </select>
              </label>
            ) : (
              <p className="text-md font-medium text-balance text-fg">
                {store.name}
                <span className="text-subtle"> · automater från {store.operator}</span>
              </p>
            )}
          </div>
          <nav aria-label="Butiksportalen" className="-mb-px flex gap-1 overflow-x-auto">
            {PORTAL_NAV.map((item) => {
              const active = isActive(pathname, item.href);
              return (
                <Link
                  key={item.href}
                  href={item.href}
                  aria-current={active ? "page" : undefined}
                  className={cn(
                    "inline-flex h-10 shrink-0 items-center rounded-xs border-b-2 px-3 text-sm transition-colors duration-fast ease-instrument",
                    active ? "border-fg text-fg" : "border-transparent text-muted hover:text-fg",
                  )}
                >
                  {item.label}
                </Link>
              );
            })}
          </nav>
        </div>
      ) : null}
    </header>
  );
}
