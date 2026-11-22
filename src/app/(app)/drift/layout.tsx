import { createHash } from "node:crypto";
import type { ReactNode } from "react";

import { ServiceWorkerRegistration } from "@/components/pwa/service-worker";
import { loadOptionalContext } from "@/server/data/core";

/**
 * Drift: service workern (offline-läge och push). Workern får en hash av organisation och
 * användare, så att sparade fältsidor hör till den inloggade. Sidhuvudet och undersidornas
 * meny ritar varje sida själv (DriftFrame, V2Page).
 */
export default async function DriftLayout({ children }: { children: ReactNode }) {
  const ctx = await loadOptionalContext();
  const scope = ctx
    ? createHash("sha256")
        .update(`${ctx.organization.id}:${ctx.user.id}`)
        .digest("hex")
        .slice(0, 32)
    : null;
  return (
    <>
      <ServiceWorkerRegistration scope={scope} />
      {children}
    </>
  );
}
