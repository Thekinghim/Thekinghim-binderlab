import { RouteNotFound } from "@/components/ui/route-not-found";

/** Okänt ärende (notFound() i sidan): fel länk, borttagen, eller hör till en annan organisation. */
export default function NotFound() {
  return (
    <RouteNotFound
      className="mx-auto flex w-full max-w-[1280px] flex-col px-4 pt-8 pb-16 md:px-8 md:pt-12"
      eyebrow="Inkorg · 404"
      title="Ärendet finns inte."
      aside="Länken kan vara fel, eller så hör ärendet till en annan organisation."
      code="Inget ärende"
      message="Inget ärende i inkorgen har det här id:t."
      action={{ label: "Till Inkorg", href: "/inkorg" }}
    />
  );
}
