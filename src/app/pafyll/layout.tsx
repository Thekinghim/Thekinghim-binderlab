import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";

import { V2Logo } from "@/components/v2/shell/nav-icon";
import { ConfigMissing } from "@/components/ui/config-missing";
import { getConfigStatus } from "@/server/config-status";
import { requireStaff } from "@/server/staff/session";

import { PortalThemeScope } from "@/app/portal/_components/portal-theme";

import { StaffLogout } from "./_components/staff-logout";

export const metadata: Metadata = { title: "Fyll på" };
export const viewport: Viewport = { themeColor: "#ffffff" };

// Sessionen läses per förfrågan; sidan förrenderas aldrig vid bygget.
export const dynamic = "force-dynamic";

/**
 * Fyll på för påfyllare i butiken (rollen machine_refiller): loggan, namnet och Logga ut.
 * Ingen meny, inget organisationsval. Avstängt eller oanvänt i 90 dagar: utloggad
 * (requireStaff). Bara ljust läge (V2).
 */
export default async function StaffLayout({ children }: { children: ReactNode }) {
  const config = getConfigStatus();
  if (!config.ok) return <ConfigMissing issues={config.issues} />;
  await requireStaff();
  return (
    <div data-theme="light" data-ui="v2" className="min-h-dvh bg-v2-bg text-v2-ink">
      <PortalThemeScope theme="light" />
      <header className="mx-auto flex w-full max-w-[560px] items-center justify-between px-4 pt-[max(12px,env(safe-area-inset-top))] pb-2">
        <span className="flex items-center gap-2 font-semibold">
          <V2Logo size={26} />
          Binderlab
        </span>
        <StaffLogout />
      </header>
      <main
        id="main"
        className="mx-auto w-full max-w-[560px] px-4 pb-[calc(120px+env(safe-area-inset-bottom))]"
      >
        {children}
      </main>
    </div>
  );
}
