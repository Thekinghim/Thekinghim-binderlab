"use client";

import { usePathname } from "next/navigation";
import { useState } from "react";

import { activeV2NavId, v2MobileNavForRole, type Role } from "@/components/shell/nav";
import type { TodoCountSource } from "@/components/shell/side-nav";

import { NavCount } from "./count";
import { PeriodLink } from "./period-link";
import { NavIcon } from "./nav-icon";

/** Ett tryck på en flik som väntar på sidan: vilken flik, och från vilken sida. */
export type PressedTab = { id: string; from: string };

/**
 * Fliken som ska vara tänd: den man nyss tryckte på medan sidan laddas (samma sida som när
 * man tryckte), annars den som adressen säger. En sida utan egen flik (Butiker och Pengar,
 * som nås från Mer på telefonen) tänder Mer.
 */
export function shownTabId(
  active: string | null,
  pressed: PressedTab | null,
  pathname: string,
  tabs: readonly string[],
): string | null {
  const id = pressed && pressed.from === pathname ? pressed.id : active;
  if ((id === "butiker" || id === "pengar") && !tabs.includes(id)) return "mer";
  return id;
}

/**
 * Mobilens bottenrad (under 900 px): Hem, Automater, Rutt, Lager, Mer (det rollen får se).
 * Butiker och Pengar ligger överst på Mer. Tryck på aktiv flik = till toppen. Säkra
 * marginaler runt hemindikatorn (env(safe-area-inset-*)). Hålls i skärmens nederkant på iPhone
 * av ViewportPin (viewport-pin-mount.tsx, i rotlayouten).
 *
 * Fliken tänds direkt vid trycket (inte först när servern svarat), och sidan hämtas i förväg
 * först när fingret landar (PeriodLink).
 */
export function V2TabBar({ role, todoCount }: { role: Role; todoCount?: TodoCountSource }) {
  const pathname = usePathname();
  const active = activeV2NavId(pathname);
  const items = v2MobileNavForRole(role);
  const [pressed, setPressed] = useState<PressedTab | null>(null);
  // Släpp trycket vid sidbyte, annars tänds fliken igen när man backar tillbaka.
  const [lastPath, setLastPath] = useState(pathname);
  if (pathname !== lastPath) {
    setLastPath(pathname);
    setPressed(null);
  }
  const shown = shownTabId(
    active,
    pressed,
    pathname,
    items.map((i) => i.id),
  );
  return (
    <nav className="v2-tabs" aria-label="Flikar">
      {items.map((item) => {
        const on = shown === item.id;
        return (
          <PeriodLink
            key={item.id}
            href={item.href}
            aria-current={on ? "page" : undefined}
            onClick={(e) => {
              if (on && pathname === item.href) {
                e.preventDefault();
                window.scrollTo({ top: 0, behavior: "smooth" });
                return;
              }
              // Nytt fönster eller flik (cmd/ctrl-klick): här byts ingen sida.
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
              setPressed({ id: item.id, from: pathname });
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
