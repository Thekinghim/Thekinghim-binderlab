import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { ConfigMissing } from "@/components/ui/config-missing";
import { ButtonLink } from "@/components/v2/button";
import { V2Logo } from "@/components/v2/shell/nav-icon";
import { getConfigStatus } from "@/server/config-status";

import { PlatformNav } from "./_components/platform-nav";
import { requirePlatform } from "./_lib/context";

export const metadata: Metadata = {
  title: { default: "Plattform", template: "%s · Plattform · Binderlab" },
  robots: { index: false, follow: false },
};

// Inloggade sidor läser sessionen per förfrågan och förrenderas aldrig vid bygget.
export const dynamic = "force-dynamic";

/**
 * Plattformens skal, utanför appens (app)-grupp: Binderlabs egen vy över alla kunder.
 * Bara plattformsoperatörer (404 för alla andra, även kundernas ägare).
 */
export default async function PlatformLayout({ children }: { children: ReactNode }) {
  const config = getConfigStatus();
  if (!config.ok) return <ConfigMissing issues={config.issues} />;
  await requirePlatform();
  return (
    <div data-ui="v2" className="flex min-h-dvh flex-col">
      <a
        href="#main"
        className="sr-only rounded-v2 bg-v2-panel px-3 py-2 text-v2-ink focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
      >
        Till innehållet
      </a>
      <header className="bg-v2-panel shadow-[0_1px_0_var(--v2-line)]" data-print="hide">
        <div className="mx-auto w-full max-w-[1280px] px-[22px] max-[900px]:px-3">
          <div className="flex min-h-14 items-center justify-between gap-3">
            <Link
              href="/plattform"
              className="inline-flex min-w-0 items-center gap-2.5 text-v2-md font-[650] text-v2-ink"
            >
              <V2Logo size={28} />
              <span>Plattform</span>
              <span className="truncate font-normal text-v2-mute max-sm:hidden">Binderlab</span>
            </Link>
            <ButtonLink href="/">Till panelen →</ButtonLink>
          </div>
          <PlatformNav />
        </div>
      </header>
      <main
        id="main"
        className="mx-auto flex w-full max-w-[1280px] flex-1 flex-col px-[22px] pt-5 pb-16 max-[900px]:px-3 max-[900px]:pt-3"
      >
        {children}
      </main>
    </div>
  );
}
