import { createHash } from "node:crypto";
import type { ReactNode } from "react";

import { ServiceWorkerRegistration } from "@/components/pwa/service-worker";
import { loadOptionalContext } from "@/server/data/core";

import { DriftNav } from "./_components/drift-nav";

/**
 * Drift: undersidornas meny och service workern (offline-läge och push). Workern får en hash
 * av organisation och användare, så att sparade fältsidor hör till den inloggade.
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
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-6 px-4 pt-4 pb-16 md:gap-8 md:px-8 md:pt-8">
      <DriftNav canRefill={ctx ? ["owner", "admin", "refiller"].includes(ctx.role) : false} />
      <ServiceWorkerRegistration scope={scope} />
      {children}
    </div>
  );
}
