import type { ReactNode } from "react";

import { Wordmark } from "@/components/brand/wordmark";
import { ThemeToggle } from "@/components/shell/theme-toggle";

import { SystemStatus } from "./system-status";

/**
 * Ramen för sidorna utan inloggning (/logga-in, /logga-in/bekrafta,
 * /inbjudan/[token]): ordmärket, ett vänsterställt block på koordinatnätet
 * och systemstatus i mono längst ner. Blocket är 12 rutor brett (384 px) och
 * står på nätets linjer; inga kort, ingen illustration.
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
      <div className="relative mx-auto flex min-h-dvh w-full max-w-[1280px] flex-col px-4 md:px-8">
        {/* Nätet börjar i ramens vänsterkant, så att blocket står på dess linjer. */}
        <div
          aria-hidden
          className="grid-field pointer-events-none absolute inset-0 [mask-image:linear-gradient(to_right,black,black_50%,transparent_90%)]"
        />
        <header className="relative flex h-16 items-center justify-between">
          <a href="/logga-in" className="rounded-xs">
            <Wordmark size="md" />
          </a>
          <ThemeToggle />
        </header>

        <main id="main" className="relative flex flex-1 flex-col pt-16 pb-16 md:pt-32">
          <div className="relative w-full max-w-[384px] md:ml-[64px]">
            <Ticks />
            <p className="label flex items-center gap-2 text-subtle">{eyebrow}</p>
            <h1 className="mt-3 text-2xl font-medium text-balance">
              <span className="text-fg">{title}</span>
              {aside ? <span className="text-subtle"> {aside}</span> : null}
            </h1>
            <div className="mt-8">{children}</div>
          </div>
        </main>

        <footer className="relative border-t border-line bg-bg py-3">
          <SystemStatus />
        </footer>
      </div>
    </div>
  );
}

/** Koordinatmärken vid blockets vänsterkant, i nätets steg (32 px). Bara från md. */
function Ticks() {
  return (
    <div
      aria-hidden
      className="label tnum pointer-events-none absolute top-0 -left-[64px] hidden flex-col text-faint md:flex"
    >
      {["00", "01", "02", "03", "04", "05", "06", "07", "08", "09", "10", "11"].map((t) => (
        <span key={t} className="flex h-8 items-start gap-2">
          <span className="mt-[7px] h-px w-2 bg-[color:var(--bl-grid-mark)]" />
          {t}
        </span>
      ))}
    </div>
  );
}
