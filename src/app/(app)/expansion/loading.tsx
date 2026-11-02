import { RouteLoading } from "@/components/ui/route-loading";

/** Medan sidan hämtar och räknar: rubriken och innehållet som skeleton. */
export default function ExpansionLoading() {
  return <RouteLoading label="Laddar expansion" blocks={["kpi", "table", "form"]} />;
}
