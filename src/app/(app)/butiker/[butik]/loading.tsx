import { RouteLoading } from "@/components/ui/route-loading";

/** Medan butikens siffror räknas: rubriken, nyckeltal och innehåll som skeleton. */
export default function StoreLoading() {
  return <RouteLoading label="Laddar butiken" blocks={["kpi", "chart", "table"]} />;
}
