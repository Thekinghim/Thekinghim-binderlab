import { RouteLoading } from "@/components/ui/route-loading";

/** Medan sidan hämtar och räknar: rubriken och innehållet som skeleton. */
export default function AssistentLoading() {
  return <RouteLoading label="Laddar assistenten" blocks={["form"]} />;
}
