import { createHash } from "node:crypto";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppFrameRoot } from "@/components/shell/frame-root";
import { ServiceWorkerRegistration } from "@/components/pwa/service-worker";
import { ConfigMissing } from "@/components/ui/config-missing";
import { getConfigStatus } from "@/server/config-status";
import { getT } from "@/i18n/server";
import { loadOptionalContext } from "@/server/data/core";
import { requireUser } from "@/server/session";

export async function generateMetadata(): Promise<Metadata> {
  const { t } = await getT();
  return { title: t.fill.title };
}

// Sessionen läses per förfrågan; sidan förrenderas aldrig vid bygget.
export const dynamic = "force-dynamic";

/**
 * Fyll på: mobilsidan vid automaten, utan appens meny (en skärm, stora knappar). Kräver
 * inloggning och en organisation; rollen kontrolleras av sidan. Service workern sparar
 * sidan för läget utan nät och får en hash av organisation och användare (som Drift).
 */
export default async function FillLayout({ children }: { children: ReactNode }) {
  const config = getConfigStatus();
  if (!config.ok) return <ConfigMissing issues={config.issues} />;
  await requireUser();
  const ctx = await loadOptionalContext();
  if (!ctx) redirect("/");
  const scope = createHash("sha256")
    .update(`${ctx.organization.id}:${ctx.user.id}`)
    .digest("hex")
    .slice(0, 32);
  const page = (
    <div className="mx-auto min-h-dvh w-full max-w-[560px] bg-bg text-fg">
      <ServiceWorkerRegistration scope={scope} />
      {children}
    </div>
  );
  // Enkel vy: samma tre flikar nedtill som i resten av den enkla vyn (Fyll på har en egen
  // rubrikrad med menyknappen, se FillApp).
  return (
    <AppFrameRoot
      locale={ctx.locale}
      simple={ctx.viewMode === "simple" ? { role: ctx.role, email: ctx.user.email } : null}
      topBar={false}
    >
      {page}
    </AppFrameRoot>
  );
}
