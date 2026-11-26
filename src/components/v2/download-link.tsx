"use client";

import { useState, type ComponentProps, type MouseEvent } from "react";

import { fileNameFrom, saveFile } from "./save-file";
import { toastV2 } from "./toast";

/**
 * En nedladdningslänk (CSV, månadspaket) som på telefonen öppnar delningsarket med filen i
 * stället för att lämna appen. På datorn, och utan JavaScript, en vanlig länk med download.
 */
export function DownloadLink({
  href,
  fallbackName,
  onClick,
  children,
  ...rest
}: Omit<ComponentProps<"a">, "href" | "download"> & {
  href: string;
  /** Filnamnet när servern inte säger något (Content-Disposition). */
  fallbackName: string;
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
      const name = fileNameFrom(res.headers.get("content-disposition"), fallbackName);
      await saveFile(await res.blob(), name);
    } catch {
      toastV2("Ingen kontakt med servern. Försök igen.", { tone: "critical" });
    } finally {
      setBusy(false);
    }
  };
  return (
    <a {...rest} href={href} download onClick={handle} aria-busy={busy || undefined}>
      {children}
    </a>
  );
}
