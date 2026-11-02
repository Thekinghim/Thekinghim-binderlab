import { StateMessage } from "@/components/ui/state-message";

/** Okänt eller ogiltigt import-id (notFound() i sidan). */
export default function ImportNotFound() {
  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-6 px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <StateMessage
        kind="empty"
        code="Ingen import"
        message="Importen finns inte."
        detail="Länken kan vara fel, eller så hör importen till en annan organisation."
        action={{ label: "Till importloggen", href: "/datakallor#importlogg" }}
        className="rounded-md border border-line bg-surface"
      />
    </div>
  );
}
