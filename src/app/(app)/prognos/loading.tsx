"use client";

import { RouteLoading } from "@/components/ui/route-loading";
import { useLocale } from "@/i18n/client";

/** Medan sidan hämtar och räknar: rubriken och innehållet som skeleton. */
export default function PrognosLoading() {
  // Enkel vy på engelska (delägarens inköpslista ligger här): skärmläsaren säger "Loading".
  const label = useLocale() === "en" ? "Loading" : "Laddar prognos och inköp";
  return <RouteLoading label={label} blocks={["kpi", "chart", "table"]} />;
}
