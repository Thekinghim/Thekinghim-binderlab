import { RouteLoading } from "@/components/ui/route-loading";

/** Medan sidan hämtar och räknar: rubriken och innehållet som skeleton. */
export default function ButikerLoading() {
  return <RouteLoading label="Laddar butiker" blocks={["kpi", "table"]} />;
}
