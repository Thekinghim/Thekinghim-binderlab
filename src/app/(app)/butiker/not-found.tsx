import { StateMessage } from "@/components/ui/state-message";

/** Okänd butik (notFound() i sidan): fel länk, eller en butik i en annan organisation. */
export default function StoreNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-6 px-4 pt-8 pb-16 md:px-8 md:pt-12">
      {/* Sidans rubrik för skärmläsare; blocket nedan säger samma sak synligt. */}
      <h1 className="sr-only">Butiken finns inte.</h1>
      <StateMessage
        kind="empty"
        code="Ingen butik"
        message="Butiken finns inte."
        detail="Länken kan vara fel, eller så hör butiken till en annan organisation."
        action={{ label: "Alla butiker", href: "/butiker" }}
        className="rounded-md border border-line bg-surface"
      />
    </div>
  );
}
