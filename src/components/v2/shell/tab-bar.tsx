"use client";

import { usePathname } from "next/navigation";

import { activeV2NavId, v2MobileNavForRole, type Role } from "@/components/shell/nav";
import type { TodoCountSource } from "@/components/shell/side-nav";

import { NavCount } from "./count";
import { PeriodLink } from "./period-link";
import { NavIcon } from "./nav-icon";

/**
 * Mobilens bottenrad (under 900 px): Hem, Automater, Rutt, Lager, Mer (det rollen får se).
 * Butiker och Pengar ligger överst på Mer. Tryck på aktiv flik = till toppen. Säkra
 * marginaler runt hemindikatorn (env(safe-area-inset-*)). Hålls i skärmens nederkant på iPhone
 * av ViewportPin (viewport-pin-mount.tsx, i rotlayouten).
 */
export function V2TabBar({ role, todoCount }: { role: Role; todoCount?: TodoCountSource }) {
  const pathname = usePathname();
  const active = activeV2NavId(pathname);
  const items = v2MobileNavForRole(role);
  return (
    <nav className="v2-tabs" aria-label="Flikar">
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
