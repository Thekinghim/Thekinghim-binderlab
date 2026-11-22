import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { Notice } from "@/components/v2/notice";
import { getPortalContext } from "@/server/portal/session";

import { PortalPage } from "../_components/page-head";

export const metadata: Metadata = { title: "Ingen butik" };

/** Inloggad men inte butiksanvändare någonstans (och inte medlem i appen). */
export default async function NoStorePage() {
  const ctx = await getPortalContext();
  if (ctx) redirect("/portal");
  return (
    <PortalPage title="Inget butikskonto" sub="Kontot är inte kopplat till någon butik.">
      <Notice
        tone="warning"
        title="Be operatören som driver automaterna i er butik om en ny inbjudan till butiksportalen."
      >
        Inbjudan gäller en e-postadress och en butik. Logga ut och in igen med rätt adress om ni har
        flera.
      </Notice>
    </PortalPage>
  );
}
