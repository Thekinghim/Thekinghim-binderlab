import { RouteLoading } from "@/components/ui/route-loading";

/** Medan ärendet hämtas: rubriken och formuläret som skeleton. */
export default function IncidentLoading() {
  return <RouteLoading label="Laddar ärendet" blocks={["table"]} />;
}
