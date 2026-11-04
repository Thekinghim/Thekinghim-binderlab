"use client";

import { useRouter } from "next/navigation";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type CSSProperties,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";

/**
 * Skalets navigering inom sidan (period och filter i URL:en).
 *
 * Ett periodbyte ändrar bara sökparametrarna, så Next återanvänder sidans
 * Suspense-gränser och visar den gamla sidan tills hela serverrenderingen är klar.
 * Utan det här syntes ingenting förrän servern svarat (3–7 s i drift). Här körs
 * router.replace i en transition vars väntetillstånd hela skalet ser:
 *
 * - `target` är adressen som väntar. Periodväljaren, periodraden, filtren och
 *   länkarna läser den i stället för URL:en, så valet syns direkt.
 * - `pending` sätter aria-busy på <main>, tonar innehållet och visar en tunn
 *   laddningsrad överst tills den nya sidan är på plats.
 * - Ett nytt val medan ett annat väntar ersätter det (Next kastar det äldre svaret),
 *   så det sista klicket vinner, även när man klickar tillbaka till där man var.
 */
export type ShellNavigation = {
  /** En navigering väntar på servern. */
  readonly pending: boolean;
  /** Adressen som väntar (sökväg och sökparametrar), eller null. */
  readonly target: string | null;
  replace(href: string): void;
};

const Ctx = createContext<ShellNavigation | null>(null);

export function ShellNavigationProvider({ children }: { children: ReactNode }) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [target, setTarget] = useState<string | null>(null);

  const replace = useCallback(
    (href: string) => {
      setTarget(href);
      startTransition(() => router.replace(href, { scroll: false }));
    },
    [router],
  );

  const value = useMemo<ShellNavigation>(
    // Klart (eller misslyckat): URL:en gäller igen.
    () => ({ pending: isPending, target: isPending ? target : null, replace }),
    [isPending, target, replace],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

/** Skalets navigering, eller null utanför AppShell (då skriver hookarna direkt till routern). */
export function useShellNavigation(): ShellNavigation | null {
  return useContext(Ctx);
}

/**
 * Tunn rad överst medan en navigering väntar. Den växer snabbt i början och
 * saktar in mot 90 %, och fylls ut och tonas bort när sidan är klar.
 */
export function NavigationProgress() {
  const pending = useShellNavigation()?.pending ?? false;
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !pending || typeof el.animate !== "function") return;
    const grow = el.animate(
      [
        { transform: "scaleX(0.05)", opacity: 1 },
        { transform: "scaleX(0.6)", opacity: 1, offset: 0.2 },
        { transform: "scaleX(0.9)", opacity: 1 },
      ],
      { duration: 8000, easing: "cubic-bezier(0.1, 0.6, 0.2, 1)", fill: "forwards" },
    );
    return () => {
      grow.cancel();
      el.animate(
        [
          { transform: "scaleX(1)", opacity: 1 },
          { transform: "scaleX(1)", opacity: 0 },
        ],
        { duration: 350, easing: "ease-out", fill: "forwards" },
      );
    };
  }, [pending]);

  return (
    <div aria-hidden className="pointer-events-none fixed inset-x-0 top-0 z-50 h-0.5">
      <div ref={ref} className="h-full origin-left bg-fg opacity-0" />
    </div>
  );
}

/** <main> som visar att innehållet laddas (aria-busy, tonat) medan skalets navigering väntar. */
export function ShellMain({
  children,
  className,
  style,
}: {
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
}) {
  const nav = useShellNavigation();
  const pending = nav?.pending ?? false;
  return (
    <main id="main" aria-busy={pending || undefined} className={className} style={style}>
      <div
        className={cn(
          "transition-opacity duration-200 ease-out",
          // Fördröjt, så att ett snabbt svar inte blinkar.
          pending && "opacity-60 delay-150",
        )}
      >
        {children}
      </div>
    </main>
  );
}
