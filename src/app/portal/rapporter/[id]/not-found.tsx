import { RouteNotFound } from "@/components/ui/route-not-found";

/** Okänd rapport (notFound() i sidan): fel länk, borttagen, eller gäller en annan butik. */
export default function NotFound() {
  return (
    <RouteNotFound
      className="flex flex-col pt-10 md:pt-12"
      eyebrow="Rapporter · 404"
      title="Rapporten finns inte."
      aside="Länken kan vara fel, eller så gäller rapporten en annan butik."
      code="Ingen rapport"
      message="Ingen rapport för butiken har det här id:t."
      action={{ label: "Alla rapporter", href: "/portal/rapporter" }}
    />
  );
}
