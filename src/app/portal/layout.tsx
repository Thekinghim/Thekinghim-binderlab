import { ConfigMissing } from "@/components/ui/config-missing";
import { getConfigStatus } from "@/server/config-status";
import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { getPortalContext } from "@/server/portal/session";

import { PortalHeader } from "./_components/portal-header";
import { PortalThemeScope } from "./_components/portal-theme";
import { PORTAL_ROOT_ID } from "./_components/theme-script";

import "./_components/portal.css";

export const metadata: Metadata = {
  title: { default: "Butiksportal", template: "%s · Butiksportal · Binderlab" },
  description: "Butikens försäljning, ersättning och rapporter från automaterna.",
};

export const viewport: Viewport = {
  themeColor: "#ffffff",
};

/**
 * Butiksportalens skal, utanför appens (app)-grupp: eget huvud, tre menyval och
 * inga appmenyer. V2 (data-ui="v2"): vita kort på grå yta, bara ljust läge.
 *
 * Kräver inloggning (requireUser i getPortalContext). Användare som inte är
 * butiksanvändare får inget innehåll här: sidorna kräver en butik
 * (requirePortalContext) och skickar övriga till appen eller /portal/ingen-butik.
 */
// Inloggade sidor läser sessionen per förfrågan och förrenderas aldrig vid bygget.
export const dynamic = "force-dynamic";

export default async function PortalLayout({ children }: { children: ReactNode }) {
  const config = getConfigStatus();
  if (!config.ok) return <ConfigMissing issues={config.issues} />;
  const ctx = await getPortalContext();
  return (
    <div id={PORTAL_ROOT_ID} data-theme="light" data-ui="v2" className="v2-portal">
      <PortalThemeScope theme="light" />
      <a
        href="#main"
        className="text-white sr-only rounded-v2 bg-v2-primary px-3 py-2 focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
      >
        Till innehållet
      </a>
      <PortalHeader
        email={ctx?.user.email ?? ""}
        store={
          ctx
            ? {
                id: ctx.store.storeId,
                name: ctx.store.storeName,
                operator: ctx.store.organizationName,
              }
            : null
        }
        stores={(ctx?.stores ?? []).map((s) => ({ id: s.storeId, name: s.storeName }))}
      />
      <main id="main" className="pt-wrap flex-1">
        {children}
      </main>
      <footer className="pt-wrap pt-foot" data-print="hide">
        <span>
          {ctx
            ? // Verksamhetens namn, inget påstående om vem som äger automaterna: bolaget och
              // vad det äger står i varje rapports underlag.
              `Butiksportal för ${ctx.store.storeName} från ${ctx.store.organizationName}.`
            : "Binderlab butiksportal."}
        </span>
        <span>Siffrorna räknas från automaternas försäljning.</span>
      </footer>
    </div>
  );
}
