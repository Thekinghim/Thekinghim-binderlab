import { RouteNotFound } from "@/components/ui/route-not-found";

/** Okänd rapport (notFound() i sidan): fel länk, borttagen, eller hör till en annan organisation. */
export default function NotFound() {
  return (
    <RouteNotFound
      className="flex min-h-dvh w-full flex-col items-center px-4 pt-16 pb-16 md:pt-24"
      eyebrow="Rapporter · 404"
      title="Rapporten finns inte."
      aside="Länken kan vara fel, eller så hör rapporten till en annan organisation."
      code="Ingen rapport"
      message="Ingen sparad rapport har det här id:t."
      action={{ label: "Alla rapporter", href: "/rapporter" }}
    />
  );
}
