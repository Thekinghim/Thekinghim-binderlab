"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useTransition } from "react";

import { Icon } from "@/components/ui/icon";
import { Button } from "@/components/v2/button";
import { V2Logo } from "@/components/v2/shell/nav-icon";
import { logout } from "@/server/actions/auth";
import { selectPortalStore } from "@/server/portal/actions";

export type PortalNavItem = { href: string; label: string };

export const PORTAL_NAV: readonly PortalNavItem[] = [
  { href: "/portal", label: "Översikt" },
  { href: "/portal/pengar", label: "Avräkning" },
  { href: "/portal/rapporter", label: "Rapporter" },
  { href: "/portal/felanmalan", label: "Felanmälan" },
];

function isActive(pathname: string | null, href: string): boolean {
  if (!pathname) return false;
  if (href === "/portal") return pathname === "/portal";
  return pathname === href || pathname.startsWith(`${href}/`);
}

/**
 * Portalens huvud i V2: loggan med butikens namn och operatören, e-post och Logga ut, och
 * flikarna under (som SubNav i appen). Inga appmenyer: butiken når aldrig appen. Har
 * användaren flera butiker väljs butiken i en rad över flikarna.
 */
export function PortalHeader({
  store,
  stores,
  email,
}: {
  store: { id: string; name: string; operator: string } | null;
  stores: ReadonlyArray<{ id: string; name: string }>;
  email: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const [pending, startTransition] = useTransition();

  return (
    <header className="pt-head" data-print="hide">
      <div className="pt-wrap">
        <div className="pt-bar">
          <Link href="/portal" className="pt-brand" aria-label="Butiksportalen, översikt">
            <V2Logo size={28} />
            <span className="shrink-0">Butiksportal</span>
            {store && stores.length <= 1 ? (
              <span className="pt-store">
                {store.name} · från {store.operator}
              </span>
            ) : null}
          </Link>
          <div className="pt-tools">
            <span className="pt-email">{email}</span>
            <Button
              disabled={pending}
              aria-label="Logga ut"
              onClick={() =>
                startTransition(async () => {
                  await logout();
                  router.replace("/logga-in");
                  router.refresh();
                })
              }
            >
              <Icon name="logout" size={16} />
              <span className="max-sm:hidden">Logga ut</span>
            </Button>
          </div>
        </div>
        {store && stores.length > 1 ? (
          <label className="pt-storesel">
            <span>Butik</span>
            <select
              className="v2-select"
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
        ) : null}
        {store ? (
          <nav aria-label="Butiksportalen" className="v2-subnav">
            {PORTAL_NAV.map((item) => (
              <Link
                key={item.href}
                href={item.href}
                aria-current={isActive(pathname, item.href) ? "page" : undefined}
              >
                {item.label}
              </Link>
            ))}
          </nav>
        ) : null}
      </div>
    </header>
  );
}
