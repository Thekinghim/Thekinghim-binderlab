"use client";

import { useEffect, useState } from "react";

import { StateMessage, type StateDiagnostic } from "@/components/ui/state-message";
import { useT } from "@/i18n/client";

/** Klockan i Stockholm, som resten av appen (inte webbläsarens tidszon): "15:51". */
const stockholmTime = new Intl.DateTimeFormat("sv-SE", {
  timeZone: "Europe/Stockholm",
  hour: "2-digit",
  minute: "2-digit",
  hourCycle: "h23",
});

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
      : { at: stockholmTime.format(new Date()), path: window.location.pathname },
  );
  useEffect(() => {
    console.error(error);
  }, [error]);

  const t = useT();
  const digest = digestOf(error);
  const diagnostics: StateDiagnostic[] = [];
  if (digest) diagnostics.push({ label: t.state.diagErrorId, value: digest });
  if (where) {
    diagnostics.push(
      { label: t.state.diagTime, value: `${where.at} Stockholm` },
      { label: t.state.diagPage, value: where.path },
    );
  }

  const again = retry ?? reset ?? (() => window.location.reload());

  return (
    <div className="flex flex-col">
      <p className="label flex items-center gap-2 text-subtle">
        <span className="text-fg">{t.state.errorEyebrow}</span>
        <span aria-hidden className="text-faint">
          /
        </span>
        <span>{t.state.errorEyebrowArea}</span>
      </p>
      <h1 className="mt-3 text-2xl font-medium text-balance hyphens-none md:text-3xl">
        <span className="text-fg">{t.state.errorTitle}</span>{" "}
        <span className="text-subtle" suppressHydrationWarning>
          {/* Neutral: felet kan vara en databas som inte svarar lika väl som ett programfel. */}
          {t.state.errorStopped(where ? where.at : null)}
        </span>
      </h1>
      <StateMessage
        className="-mt-4 -ml-5 md:-mt-10 md:-ml-6"
        kind="loading-failed"
        message={t.state.errorNothingChanged}
        detail={t.state.errorAskOps}
        action={{ label: t.state.tryAgain, onClick: again }}
        secondaryAction={homeHref ? { label: t.state.toHome, href: homeHref } : undefined}
        diagnostics={diagnostics.length > 0 ? diagnostics : undefined}
      />
    </div>
  );
}
