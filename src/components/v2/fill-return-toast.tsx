"use client";

import { useRouter } from "next/navigation";
import { useEffect } from "react";

import { takeFillReturn } from "@/lib/fill-return";

import { toastUndo, toastV2 } from "./toast";

/**
 * Notisen efter Fyll på → tillbaka (src/lib/fill-return.ts): "Klart! 12 pack påfyllda" med
 * Ångra, på sidan man kom tillbaka till (Hem eller Automater). Ångra tar bort påfyllningarna
 * på samma sätt som Ångra i Fyll på (undoRefills, påfyllarens egna).
 */
export function FillReturnToast() {
  const router = useRouter();
  useEffect(() => {
    // Efter första målningen (Toastern ska ha hunnit monteras). Läses i timern, så att
    // Reacts dubbla effekt i utvecklingsläget inte tar beskedet utan att visa det.
    const timer = window.setTimeout(() => {
      const r = takeFillReturn();
      if (!r) return;
      toastUndo(
        r.title,
        r.detail || undefined,
        () => {
          // Laddas först vid Ångra (skalet importerar inte serverkoden i förväg).
          void import("@/app/(app)/drift/actions")
            .then(({ undoRefills }) => undoRefills([...r.clientIds]))
            .then((res) => {
              if (res.ok) {
                toastV2(`Ångrat · ${r.packs} pack tillbaka`, { tone: "neutral" });
                router.refresh();
              } else {
                toastV2("Kunde inte ångra", { detail: res.error, tone: "critical" });
              }
            })
            .catch(() =>
              toastV2("Kunde inte ångra", {
                detail: "Kontrollera nätet och försök igen.",
                tone: "critical",
              }),
            );
        },
        { id: "fyll-tillbaka" },
      );
    }, 0);
    return () => window.clearTimeout(timer);
  }, [router]);
  return null;
}
