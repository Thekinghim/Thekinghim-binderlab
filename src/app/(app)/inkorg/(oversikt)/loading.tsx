import { RouteLoading } from "@/components/ui/route-loading";

/** Medan sidan hämtar och räknar: rubriken och innehållet som skeleton. */
export default function InkorgLoading() {
  return <RouteLoading label="Laddar inkorgen" blocks={["kpi", "table"]} />;
}
