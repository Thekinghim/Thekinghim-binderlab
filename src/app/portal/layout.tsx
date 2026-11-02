import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { getPortalContext } from "@/server/portal/session";

import { PortalHeader } from "./_components/portal-header";
import { PortalThemeScope } from "./_components/portal-theme";
import { portalThemeScript } from "./_components/theme-script";

export const metadata: Metadata = {
  title: { default: "Butiksportal", template: "%s · Butiksportal · Binderlab" },
  description: "Butikens försäljning, ersättning och rapporter från automaterna.",
};

export const viewport: Viewport = {
  themeColor: "#f4f3ef",
};

/**
 * Butiksportalens skal, utanför appens (app)-grupp: eget huvud, tre menyval och
 * inga appmenyer. Ljust läge som standard.
 *
 * Kräver inloggning (requireUser i getPortalContext). Användare som inte är
 * butiksanvändare får inget innehåll här: sidorna kräver en butik
 * (requirePortalContext) och skickar övriga till appen eller /portal/ingen-butik.
 */
export default async function PortalLayout({ children }: { children: ReactNode }) {
  const ctx = await getPortalContext();
  return (
    <div className="flex min-h-dvh flex-col bg-bg text-fg">
      <script dangerouslySetInnerHTML={{ __html: portalThemeScript }} />
      <PortalThemeScope />
      <a
        href="#main"
        className="sr-only rounded-xs bg-raised px-3 py-2 text-fg focus:not-sr-only focus:fixed focus:top-2 focus:left-2 focus:z-50"
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
      <main id="main" className="mx-auto w-full max-w-[1120px] flex-1 px-4 pb-24 md:px-8">
        {children}
      </main>
      <footer className="border-t border-line" data-print="hide">
        <div className="meta mx-auto flex max-w-[1120px] flex-wrap items-center justify-between gap-2 px-4 py-6 text-subtle md:px-8">
          <span>
            {ctx
              ? `${ctx.store.organizationName} driver automaterna i ${ctx.store.storeName}.`
              : "Binderlab butiksportal."}
          </span>
          <span>Siffrorna räknas från automaternas försäljning, exkl. moms.</span>
        </div>
      </footer>
    </div>
  );
}
