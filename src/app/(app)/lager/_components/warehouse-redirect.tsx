"use client";

import { useEffect } from "react";
import { useRouter, useSearchParams } from "next/navigation";

/**
 * Vårt lager (centrallagret) har flyttat till Prognos & inköp. Gamla länkar
 * (/lager#centrallager, /lager?vy=centrallager) skickas dit. Ankaret når aldrig servern,
 * därför görs det här i klienten.
 */
export function WarehouseRedirect() {
  const router = useRouter();
  const searchParams = useSearchParams();
  useEffect(() => {
    const hash = window.location.hash.replace(/^#/, "");
    if (hash === "centrallager" || searchParams.get("vy") === "centrallager") {
      router.replace("/prognos#vart-lager");
    }
  }, [router, searchParams]);
  return null;
}
