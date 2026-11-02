import { RouteNotFound } from "@/components/ui/route-not-found";

/** Okänd automat (notFound() i sidan): fel länk, borttagen, eller hör till en annan organisation. */
export default function NotFound() {
  return (
    <RouteNotFound
      className="flex flex-col"
      eyebrow="Drift · 404"
      title="Automaten finns inte."
      aside="Länken kan vara fel, eller så hör automaten till en annan organisation."
      code="Ingen automat"
      message="Ingen automat i organisationen har det här id:t."
      action={{ label: "Till Drift", href: "/drift" }}
    />
  );
}
