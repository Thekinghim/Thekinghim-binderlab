import { RouteLoading } from "@/components/ui/route-loading";

/** Medan sidan hämtar och räknar: rubriken och innehållet som skeleton. */
export default function RapporterLoading() {
  return <RouteLoading label="Laddar rapporter" blocks={["form", "chart", "table"]} />;
}
