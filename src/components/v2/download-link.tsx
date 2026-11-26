"use client";

import { useState, type ComponentProps, type MouseEvent } from "react";

import { fileNameFrom, saveFile } from "./save-file";
import { toastV2 } from "./toast";

/**
 * En nedladdningslänk (CSV, månadspaket) som på telefonen öppnar delningsarket med filen i
 * stället för att lämna appen. På datorn, och utan JavaScript, en vanlig länk med download.
 *
 * Svarar servern med en sida i stället för en fil (en omdirigering, t.ex. rapportens
 * utskriftssida när PDF:en inte kan skapas, eller inloggningen) öppnas sidan som vanligt.
 */
export function DownloadLink({
  href,
  fallbackName,
  download = true,
  onClick,
  children,
  ...rest
}: Omit<ComponentProps<"a">, "href" | "download"> & {
  href: string;
  /** Filnamnet när servern inte säger något (Content-Disposition). */
  fallbackName: string;
  /**
   * `download` på länken (datorn). false när servern kan svara med en sida i stället för en
   * fil (rapportens PDF): då öppnas sidan i stället för att sparas som fil.
   */
  download?: boolean;
}) {
  const [busy, setBusy] = useState(false);
  const handle = async (e: MouseEvent<HTMLAnchorElement>) => {
    onClick?.(e);
    if (e.defaultPrevented || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (!window.matchMedia("(pointer: coarse)").matches) return;
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    try {
      const res = await fetch(href, { credentials: "same-origin" });
      if (!res.ok) {
        toastV2("Filen kunde inte hämtas", {
          detail: (await res.text()) || undefined,
          tone: "critical",
        });
        return;
      }
      const type = res.headers.get("content-type") ?? "";
      if (res.redirected || type.startsWith("text/html")) {
        // En sida, ingen fil: öppna den (samma som länken utan JavaScript).
        window.location.assign(res.url);
        return;
      }
      const name = fileNameFrom(res.headers.get("content-disposition"), fallbackName);
      await saveFile(await res.blob(), name);
    } catch {
      toastV2("Ingen kontakt med servern. Försök igen.", { tone: "critical" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <a
      {...rest}
      href={href}
      download={download || undefined}
      onClick={handle}
      aria-busy={busy || undefined}
    >
      {children}
    </a>
  );
}
