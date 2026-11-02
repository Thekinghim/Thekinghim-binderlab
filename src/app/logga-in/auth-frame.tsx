import type { ReactNode } from "react";

import { Wordmark } from "@/components/brand/wordmark";
import { ThemeToggle } from "@/components/shell/theme-toggle";

import { SystemStatus } from "./system-status";

/**
 * Ramen för sidorna utan inloggning (/logga-in, /logga-in/bekrafta,
 * /inbjudan/[token]): ordmärket, ett vänsterställt block och systemstatus i
 * mono längst ner. Inga kort, ingen illustration och inget nät: här mäts
 * ingenting (design.md 5.4), så ytan är bara bakgrund, linjer och text.
 */
export function AuthFrame({
  eyebrow,
  title,
  aside,
  children,
}: {
  /** Mono-raden ovanför rubriken, t.ex. "01 / Inloggning". */
  eyebrow: ReactNode;
  /** Första, ljusa delen av rubriken. */
  title: string;
  /** Andra, grå delen: ett faktum. */
  aside?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh overflow-x-clip bg-bg">
      <div className="mx-auto flex min-h-dvh w-full max-w-[1280px] flex-col px-4 md:px-8">
        <header className="flex h-16 items-center justify-between">
          <a href="/logga-in" className="rounded-xs">
            <Wordmark size="md" />
          </a>
          <ThemeToggle />
        </header>

        <main id="main" className="flex flex-1 flex-col pt-16 pb-16 md:pt-32">
          <div className="w-full max-w-sm md:ml-16">
            <p className="label flex items-center gap-2 text-subtle">{eyebrow}</p>
            <h1 className="mt-3 text-2xl font-medium text-balance">
              <span className="text-fg">{title}</span>
              {aside ? <span className="text-subtle"> {aside}</span> : null}
            </h1>
            <div className="mt-8">{children}</div>
          </div>
        </main>

        <footer className="border-t border-line py-3">
          <SystemStatus />
        </footer>
      </div>
    </div>
  );
}
