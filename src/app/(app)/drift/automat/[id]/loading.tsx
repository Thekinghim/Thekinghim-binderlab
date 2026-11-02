import { RouteLoading } from "@/components/ui/route-loading";

/** Medan tidslinjen hämtas: rubriken och händelserna som skeleton. */
export default function TimelineLoading() {
  return <RouteLoading label="Laddar tidslinjen" inset="inset" blocks={["chart", "table"]} />;
}
