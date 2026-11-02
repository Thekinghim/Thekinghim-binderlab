import { StateMessage } from "@/components/ui/state-message";

/** Okänd rapport (notFound() i sidan): fel länk, borttagen, eller hör till en annan organisation. */
export default function NotFound() {
  return (
    <div className="flex flex-col gap-6 pt-8 md:pt-12">
      <h1 className="sr-only">Rapporten finns inte.</h1>
      <StateMessage
        kind="empty"
        code="Ingen rapport"
        message="Rapporten finns inte."
        detail="Länken kan vara fel, eller så gäller rapporten en annan butik."
        action={{ label: "Alla rapporter", href: "/portal/rapporter" }}
        className="rounded-md border border-line bg-surface"
      />
    </div>
  );
}
