"use client";

import { useEffect, useState } from "react";

import { reportClientError } from "@/components/pwa/client-error-report";
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
 * Felet som telefonen eller webbläsaren själv kastade (inget fel-id: det kom inte från
 * servern), kort: "TypeError: undefined is not an object (evaluating 'a.b')" och första
 * raden i stacken. Fel från servern har alltid ett fel-id och visar aldrig sitt meddelande.
 */
export function clientErrorText(error: unknown): string | null {
  if (digestOf(error)) return null;
  if (!error || typeof error !== "object")
    return error == null ? null : String(error).slice(0, 300);
  const e = error as { name?: unknown; message?: unknown; stack?: unknown };
  const name = typeof e.name === "string" && e.name ? e.name : "Error";
  const message = typeof e.message === "string" ? e.message : "";
  const head = `${name}: ${message}`.replace(/\s+/g, " ").trim().slice(0, 300);
  const frame =
    typeof e.stack === "string"
      ? e.stack
          .split("\n")
          .map((l) => l.trim())
          .find((l) => l && !l.startsWith(name) && !l.includes(message || "\u0000"))
      : undefined;
  return frame ? `${head} · ${frame.slice(0, 200)}` : head;
}

/**
 * Felläget när en sida inte kan laddas, i V2: ett vitt kort med rubriken som h1, tiden i en
 * grå rad, `StateMessage kind="loading-failed"` (röd prick, "Ej laddad"), "Försök igen" som
 * huvudknapp och de tekniska uppgifterna (fel-id, tid, sida) bakom "Visa detaljer". Ingen
 * stacktrace och inget felmeddelande från servern.
 *
 * Används av `app/error.tsx` (när skalet inte kan laddas, t.ex. när databasen är nere),
 * `app/(app)/error.tsx` (inne i skalet) och `app/global-error.tsx`. Utanför skalet ger
 * StateMessage sidan V2:s färger och typsnitt (data-ui="v2").
 */
export function RouteError({
  error,
  retry,
  reset,
  homeHref = "/",
}: RouteErrorProps & { homeHref?: string | null }) {
  // Felgränsen renderas i webbläsaren (React byter till klientrendering vid fel), så tid
  // och sökväg läses en gång där. På servern blir de tomma.
  const [where] = useState<{ at: string; path: string; message: string | null } | null>(() =>
    typeof window === "undefined"
      ? null
      : {
          at: stockholmTime.format(new Date()),
          path: window.location.pathname,
          message: clientErrorText(error),
        },
  );
  useEffect(() => {
    console.error(error);
    // Felet sparas i databasen (private.client_errors) så att det går att läsa utan
    // skärmdump. En gång per fel; kastar aldrig.
    reportClientError(error, "boundary");
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
    if (where.message) diagnostics.push({ label: t.state.diagMessage, value: where.message });
  }

  const again = retry ?? reset ?? (() => window.location.reload());

  return (
    <div className="v2-card w-full max-w-xl">
      <div className="flex flex-col gap-1 px-[18px] pt-5">
        <h1 className="text-v2-xl font-[650] text-balance text-v2-ink">{t.state.errorTitle}</h1>
        <p className="text-v2-md text-v2-mute" suppressHydrationWarning>
          {/* Neutral: felet kan vara en databas som inte svarar lika väl som ett programfel. */}
          {t.state.errorStopped(where ? where.at : null)}
        </p>
      </div>
      <StateMessage
        className="pt-4"
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
