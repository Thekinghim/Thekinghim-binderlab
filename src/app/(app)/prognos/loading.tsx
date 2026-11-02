import { RouteLoading } from "@/components/ui/route-loading";

/** Medan sidan hämtar och räknar: rubriken och innehållet som skeleton. */
export default function PrognosLoading() {
  return <RouteLoading label="Laddar prognos och inköp" blocks={["kpi", "chart", "table"]} />;
}
