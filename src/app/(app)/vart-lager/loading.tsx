import { RouteLoading } from "@/components/ui/route-loading";

/** Medan sidan hämtar och räknar: rubriken och listan som skeleton. */
export default function VartLagerLoading() {
  return <RouteLoading label="Laddar vårt lager" blocks={["kpi", "table"]} />;
}
