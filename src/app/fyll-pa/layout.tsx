import { createHash } from "node:crypto";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { ServiceWorkerRegistration } from "@/components/pwa/service-worker";
import { ConfigMissing } from "@/components/ui/config-missing";
import { getConfigStatus } from "@/server/config-status";
import { loadOptionalContext } from "@/server/data/core";
import { requireUser } from "@/server/session";

export const metadata: Metadata = { title: "Fyll på" };

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
  return (
    <div className="mx-auto min-h-dvh w-full max-w-[560px] bg-bg text-fg">
      <ServiceWorkerRegistration scope={scope} />
      {children}
    </div>
  );
}
