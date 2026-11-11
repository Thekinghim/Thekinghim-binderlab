"use client";

import { RouteLoading } from "@/components/ui/route-loading";
import { useLocale } from "@/i18n/client";

/** Medan sidan hämtar och räknar: rubriken och listan som skeleton. */
export default function VartLagerLoading() {
  // Enkel vy på engelska (Mystery ligger under Vårt lager): skärmläsaren säger "Loading".
  const label = useLocale() === "en" ? "Loading" : "Laddar vårt lager";
  return <RouteLoading label={label} blocks={["kpi", "table"]} />;
}
