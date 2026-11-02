import { StateMessage } from "@/components/ui/state-message";

/** Okänt ärende (notFound() i sidan): fel länk, borttagen, eller hör till en annan organisation. */
export default function NotFound() {
  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-6 px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <h1 className="sr-only">Ärendet finns inte.</h1>
      <StateMessage
        kind="empty"
        code="Inget ärende"
        message="Ärendet finns inte."
        detail="Länken kan vara fel, eller så hör ärendet till en annan organisation."
        action={{ label: "Till Inkorg", href: "/inkorg" }}
        className="rounded-md border border-line bg-surface"
      />
    </div>
  );
}
