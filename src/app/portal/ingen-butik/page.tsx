import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { getPortalContext } from "@/server/portal/session";

export const metadata: Metadata = { title: "Ingen butik" };

/** Inloggad men inte butiksanvändare någonstans (och inte medlem i appen). */
export default async function NoStorePage() {
  const ctx = await getPortalContext();
  if (ctx) redirect("/portal");
  return (
    <div className="flex flex-col gap-8 py-16">
      <SectionHeader
        as="h1"
        size="xl"
        title="Inget butikskonto."
        aside="Kontot är inte kopplat till någon butik."
      />
      <StateMessage
        kind="denied"
        message="Be operatören som driver automaterna i er butik om en ny inbjudan till butiksportalen."
        detail="Inbjudan gäller en e-postadress och en butik. Logga ut och in igen med rätt adress om ni har flera."
      />
    </div>
  );
}
