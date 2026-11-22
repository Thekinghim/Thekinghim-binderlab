"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useEffect, useRef } from "react";

import { toastV2 } from "@/components/v2/toast";

import { DENIED_PARAM, deniedNotice, type Role } from "./nav";

/**
 * Förklarar en omdirigering från en sida rollen inte får se (requireRoute skickar till
 * startsidan med `?nekad=<rutt>`): en notis i stället för att användaren tyst hamnar på
 * Hem. Parametern tas bort ur adressen efteråt, så att den inte visas igen vid omladdning
 * eller följer med en kopierad länk.
 */
export function DeniedNotice({ role }: { role: Role }) {
  const params = useSearchParams();
  const pathname = usePathname();
  const router = useRouter();
  const value = params.get(DENIED_PARAM);
  // En gång per värde, även när effekten körs två gånger (React Strict Mode i dev).
  const shown = useRef<string | null>(null);

  useEffect(() => {
    if (value === null || shown.current === value) return;
    shown.current = value;
    const notice = deniedNotice(role, value);
    // Samma notis som resten av V2 (sonner, src/components/v2/toast.tsx).
    // Efter första målningen, så att Toastern hunnit monteras (som FillReturnToast).
    if (notice) {
      window.setTimeout(
        () => toastV2(notice.title, { detail: notice.description, tone: "neutral" }),
        60,
      );
    }
    const rest = new URLSearchParams(params.toString());
    rest.delete(DENIED_PARAM);
    const query = rest.toString();
    router.replace(`${pathname}${query ? `?${query}` : ""}`, { scroll: false });
  }, [value, role, params, pathname, router]);

  return null;
}
