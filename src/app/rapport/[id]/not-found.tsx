import { StateMessage } from "@/components/ui/state-message";

/** Okänd rapport (notFound() i sidan): fel länk, borttagen, eller hör till en annan organisation. */
export default function NotFound() {
  return (
    <div className="mx-auto flex min-h-dvh w-full max-w-[1280px] flex-col gap-6 bg-bg px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <h1 className="sr-only">Rapporten finns inte.</h1>
      <StateMessage
        kind="empty"
        code="Ingen rapport"
        message="Rapporten finns inte."
        detail="Länken kan vara fel, eller så hör rapporten till en annan organisation."
        action={{ label: "Alla rapporter", href: "/rapporter" }}
        className="rounded-md border border-line bg-surface"
      />
    </div>
  );
}
