"use client";

import { useCallback } from "react";
import { cn } from "@/lib/cn";
import { useToast } from "@/components/ui/toast";

export const COPY_VIEW_LABEL = "Kopiera länk till vyn";

/** Kopierar text; faller tillbaka på en dold textruta där Clipboard API saknas. */
export async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Faller igenom till reservvägen.
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** Kopierar aktuell adress (period, butik och automat ligger i URL:en) och visar en notis. */
export function useCopyView() {
  const toast = useToast();
  return useCallback(async () => {
    const ok = await copyText(window.location.href);
    toast(
      ok
        ? { title: "Länken är kopierad", tone: "ok", duration: 2500 }
        : { title: "Kunde inte kopiera länken", tone: "critical" },
    );
  }, [toast]);
}

export function CopyViewButton({ className }: { className?: string }) {
  const copy = useCopyView();
  return (
    <button
      type="button"
      onClick={() => void copy()}
      aria-label={COPY_VIEW_LABEL}
      title={COPY_VIEW_LABEL}
      className={cn(
        "flex size-7 shrink-0 items-center justify-center rounded-sm text-subtle transition-colors hover:text-fg",
        className,
      )}
    >
      <svg
        aria-hidden
        width={14}
        height={14}
        viewBox="0 0 16 16"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.25}
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M6.5 9.5l3-3M7 4.5l1.25-1.25a2.47 2.47 0 0 1 3.5 3.5L10.5 8M9 11.5l-1.25 1.25a2.47 2.47 0 0 1-3.5-3.5L5.5 8" />
      </svg>
    </button>
  );
}
