"use client";

import { useEffect, useState } from "react";

import { StateMessage, type StateDiagnostic } from "@/components/ui/state-message";
import { formatTime } from "@/lib/format";

export type RouteErrorProps = {
  /** Det som kastades. Från en serverkomponent är det ett Error med `digest` (fel-id i serverloggen). */
  error: unknown;
  /** Next 16: hämtar och renderar segmentet igen. */
  retry?: () => void;
  /** Äldre namn i Next; används bara om `retry` saknas. */
  reset?: () => void;
};

function digestOf(error: unknown): string | undefined {
  if (error && typeof error === "object" && "digest" in error) {
    const d = (error as { digest?: unknown }).digest;
    return typeof d === "string" && d ? d : undefined;
  }
  return undefined;
}

/**
 * Felläget när en sida inte kan laddas (design.md 6, "Tom-, fel- och laddningslägen"):
 * tvådelad rubrik, `StateMessage kind="loading-failed"` med signal bara på glyfen, en
 * åtgärd med verbet först och de tekniska uppgifterna (fel-id, tid, sida) bakom
 * "Visa detaljer". Ingen stacktrace och inget felmeddelande från servern.
 *
 * Används av `app/error.tsx` (när skalet inte kan laddas, t.ex. när databasen är nere),
 * `app/(app)/error.tsx` (inne i skalet) och `app/global-error.tsx`.
 */
export function RouteError({
  error,
  retry,
  reset,
  homeHref = "/",
}: RouteErrorProps & { homeHref?: string | null }) {
  // Felgränsen renderas i webbläsaren (React byter till klientrendering vid fel), så tid
  // och sökväg läses en gång där. På servern blir de tomma.
  const [where] = useState<{ at: string; path: string } | null>(() =>
    typeof window === "undefined"
      ? null
      : { at: formatTime(new Date()), path: window.location.pathname },
  );
  useEffect(() => {
    console.error(error);
  }, [error]);

  const digest = digestOf(error);
  const diagnostics: StateDiagnostic[] = [];
  if (digest) diagnostics.push({ label: "Fel-id", value: digest });
  if (where) {
    diagnostics.push({ label: "Tid", value: where.at }, { label: "Sida", value: where.path });
  }

  const again = retry ?? reset ?? (() => window.location.reload());

  return (
    <div className="flex flex-col">
      <p className="label flex items-center gap-2 text-subtle">
        <span className="text-fg">Fel</span>
        <span aria-hidden className="text-faint">
          /
        </span>
        <span>Inläsning</span>
      </p>
      <h1 className="mt-3 text-2xl font-medium text-balance hyphens-none md:text-3xl">
        <span className="text-fg">Sidan kunde inte laddas.</span>{" "}
        <span className="text-subtle" suppressHydrationWarning>
          Servern fick inget svar när uppgifterna skulle hämtas
          {where ? ` kl. ${where.at}` : ""}.
        </span>
      </h1>
      <StateMessage
        className="-mt-4 -ml-5 md:-mt-10 md:-ml-6"
        kind="loading-failed"
        message="Inget av det som redan är sparat har ändrats."
        detail="Fortsätter felet, skicka fel-id:t i detaljerna till den som sköter driften."
        action={{ label: "Försök igen", onClick: again }}
        secondaryAction={homeHref ? { label: "Till Hem", href: homeHref } : undefined}
        diagnostics={diagnostics.length > 0 ? diagnostics : undefined}
      />
    </div>
  );
}
