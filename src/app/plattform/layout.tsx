import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { ConfigMissing } from "@/components/ui/config-missing";
import { getConfigStatus } from "@/server/config-status";

import { requirePlatform } from "./_lib/context";

export const metadata: Metadata = {
  title: { default: "Plattform", template: "%s · Plattform · Binderlab" },
  robots: { index: false, follow: false },
};

// Inloggade sidor läser sessionen per förfrågan och förrenderas aldrig vid bygget.
export const dynamic = "force-dynamic";

const LINKS = [
  { href: "/plattform", label: "Kunder" },
  { href: "/plattform/underlag", label: "Fakturaunderlag" },
] as const;

/**
 * Plattformens skal, utanför appens (app)-grupp: Binderlabs egen vy över alla kunder.
 * Bara plattformsoperatörer (404 för alla andra, även kundernas ägare).
 */
export default async function PlatformLayout({ children }: { children: ReactNode }) {
  const config = getConfigStatus();
  if (!config.ok) return <ConfigMissing issues={config.issues} />;
  await requirePlatform();
  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg">
      <a
        href="#main"
        className="sr-only rounded-xs bg-raised px-3 py-2 text-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
      >
        Till innehållet
      </a>
      <header className="border-b border-line" data-print="hide">
        <div className="mx-auto flex w-full max-w-[1280px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3 md:px-8">
          <p className="label text-fg">Binderlab · Plattform</p>
          <nav aria-label="Plattform" className="flex gap-1">
            {LINKS.map((l) => (
              <Link
                key={l.href}
                href={l.href}
                className="inline-flex h-11 items-center rounded-sm px-3 text-base text-muted hover:bg-hover hover:text-fg md:h-9"
              >
                {l.label}
              </Link>
            ))}
          </nav>
          <Link
            href="/"
            className="ml-auto inline-flex h-11 items-center text-sm text-muted hover:text-fg md:h-9"
          >
            Till panelen →
          </Link>
        </div>
      </header>
      <main
        id="main"
        className="mx-auto w-full max-w-[1280px] flex-1 px-4 pt-6 pb-24 md:px-8 md:pt-10"
      >
        {children}
      </main>
    </div>
  );
}
