"use client";

import { useState, type ReactNode } from "react";
import { MobileSidebar, Sidebar } from "./sidebar";
import { Topbar, type Period } from "./topbar";

type AppShellProps = {
  activeHref: string;
  crumbs: string[];
  period: Period;
  onPeriodChange: (p: Period) => void;
  comparison?: string;
  children: ReactNode;
};

export function AppShell({
  activeHref,
  crumbs,
  period,
  onPeriodChange,
  comparison,
  children,
}: AppShellProps) {
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only-focusable label fixed top-2 left-2 z-50 rounded-sm bg-inverse px-3 py-2 text-on-inverse"
      >
        Hoppa till innehåll
      </a>
      <Sidebar activeHref={activeHref} />
      <MobileSidebar activeHref={activeHref} open={menuOpen} onClose={() => setMenuOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          crumbs={crumbs}
          period={period}
          onPeriodChange={onPeriodChange}
          comparison={comparison}
          onOpenMenu={() => setMenuOpen(true)}
        />
        <main id="main" className="flex-1">
          {children}
        </main>
      </div>
    </div>
  );
}
