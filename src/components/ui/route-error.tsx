"use client";

import { useEffect, useState, useTransition } from "react";

import { useFormat, useT } from "@/i18n/client";
import { cn } from "@/lib/cn";

import { SectionHeader } from "./section-header";
import { StateMessage, type StateDiagnostic } from "./state-message";

export type RouteErrorProps = {
  /** Det som `error.tsx` får av Next. */
  error: unknown;
  /** Next:s `retry()`: hämtar och renderar segmentet igen. */
  retry: () => void;
  /** Sidans namn i etiketten, t.ex. "Rapporter". */
  area: string;
  /** Rubriken. Standard: "{area} kunde inte visas." */
  title?: string;
  /** Vart den andra åtgärden leder. Standard: Hem. */
  home?: { label: string; href: string };
  /** "page": egen sidbehållare. "inset": ligger redan i en layout med marginaler (Drift). */
  inset?: "page" | "inset";
};

/**
 * Felläget för en hel sida (`error.tsx`): rubrik med sidans namn, ett `StateMessage`
 * av typen `loading-failed` med "Försök igen" och felkoden bakom "Visa detaljer".
 * Ingen stacktrace och inget felmeddelande från servern visas (det kan innehålla
 * uppgifter som inte hör hemma i webbläsaren); felkoden (`digest`) går att söka på i
 * serverloggen och Sentry.
 */
export function RouteError({ error, retry, area, title, home, inset = "page" }: RouteErrorProps) {
  const t = useT();
  const f = useFormat();
  const [pending, startTransition] = useTransition();
  // Felgränsen renderas i webbläsaren, så tid och sökväg läses där (på servern blir de tomma).
  const [where] = useState<{ at: string; path: string } | null>(() =>
    typeof window === "undefined"
      ? null
      : { at: f.dateTime(new Date()), path: window.location.pathname },
  );
  useEffect(() => {
    console.error(error);
  }, [error]);

  const digest =
    error && typeof error === "object" && "digest" in error && typeof error.digest === "string"
      ? error.digest
      : null;
  const diagnostics: StateDiagnostic[] = [
    ...(digest ? [{ label: t.state.diagErrorCode, value: digest }] : []),
    ...(where
      ? [
          { label: t.state.diagTime, value: where.at },
          { label: t.state.diagPage, value: where.path },
        ]
      : []),
  ];

  return (
    <div
      className={cn(
        "flex w-full flex-col gap-8",
        inset === "page" && "mx-auto max-w-[1280px] px-4 pt-8 pb-16 md:px-8 md:pt-12",
      )}
    >
      <SectionHeader
        as="h1"
        size="xl"
        eyebrow={t.state.areaEyebrow(area)}
        title={title ?? t.state.areaTitle(area)}
        aside={t.state.areaAside}
      />
      <StateMessage
        kind="loading-failed"
        className="border-t border-line px-0! pt-10! md:pt-12!"
        message={t.state.areaMessage}
        detail={t.state.areaDetail}
        action={{
          label: t.state.tryAgain,
          loading: pending,
          onClick: () => startTransition(() => retry()),
        }}
        secondaryAction={home ?? { label: t.state.toHome, href: "/" }}
        diagnostics={diagnostics.length > 0 ? diagnostics : undefined}
      />
    </div>
  );
}
