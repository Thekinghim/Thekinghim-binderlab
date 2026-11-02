import { wallClockIn } from "@/components/shell/period-state";
import { formatDateTime } from "@/lib/format";

/** Tidpunkt i organisationens tidszon, samma på server och klient: "1 nov. 17:17". */
export function when(iso: string | null, timeZone: string): string {
  if (!iso) return "–";
  return formatDateTime(wallClockIn(new Date(iso), timeZone));
}
