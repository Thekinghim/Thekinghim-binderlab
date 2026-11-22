"use client";

import { useLocale } from "@/i18n/client";

import { OpsLoading } from "../drift/_components/ops-loading";

/** Medan sidan hämtar och räknar: rubriken och korten som skeleton. */
export default function PrognosLoading() {
  // Enkel vy på engelska (delägarens inköpslista ligger här): skärmläsaren säger "Loading".
  const label = useLocale() === "en" ? "Loading" : "Laddar prognos och inköp";
  return <OpsLoading label={label} cards={[4, 6, 3]} />;
}
