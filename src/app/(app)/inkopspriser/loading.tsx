"use client";

import { V2PageSkeleton } from "@/components/v2/skeleton";
import { useLocale } from "@/i18n/client";

/** Medan inköpspriserna läses: sidhuvudet och titeltabellen som skeleton. */
export default function Loading() {
  // Enkel vy på engelska (delägarens prislista ligger här): skärmläsaren säger "Loading".
  const label = useLocale() === "en" ? "Loading" : "Laddar inköpspriser";
  return <V2PageSkeleton label={label} sub main={[3, 8]} />;
}
