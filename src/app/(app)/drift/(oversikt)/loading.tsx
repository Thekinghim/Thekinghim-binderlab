import { RouteLoading } from "@/components/ui/route-loading";

/** Medan sidan hämtar och räknar: rubriken och innehållet som skeleton. */
export default function DriftLoading() {
  return <RouteLoading label="Laddar drift" inset="inset" blocks={["kpi", "table"]} />;
}
