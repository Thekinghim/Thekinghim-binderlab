import { RouteLoading } from "@/components/ui/route-loading";

/** Medan sidan hämtar och räknar: rubriken och innehållet som skeleton. */
export default function AutomaterLoading() {
  return <RouteLoading label="Laddar automater" blocks={["kpi", "table"]} />;
}
