import { StateMessage } from "@/components/ui/state-message";

/** Okänd automat (notFound() i sidan): fel länk, borttagen, eller hör till en annan organisation. */
export default function NotFound() {
  return (
    <div className="flex flex-col gap-6">
      <h1 className="sr-only">Automaten finns inte.</h1>
      <StateMessage
        kind="empty"
        code="Ingen automat"
        message="Automaten finns inte."
        detail="Länken kan vara fel, eller så hör automaten till en annan organisation."
        action={{ label: "Till Drift", href: "/drift" }}
        className="rounded-md border border-line bg-surface"
      />
    </div>
  );
}
