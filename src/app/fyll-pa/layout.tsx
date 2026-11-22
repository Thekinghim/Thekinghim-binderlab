import { createHash } from "node:crypto";
import type { Metadata } from "next";
import { redirect } from "next/navigation";
import type { ReactNode } from "react";

import { AppUpdate } from "@/components/pwa/app-update";
import { AppFrameRoot } from "@/components/shell/frame-root";
import { ServiceWorkerRegistration } from "@/components/pwa/service-worker";
import { ConfigMissing } from "@/components/ui/config-missing";
import { V2Toaster } from "@/components/v2/toast";
import { liveBuildId } from "@/server/build-id";
import { getConfigStatus } from "@/server/config-status";
import { getT } from "@/i18n/server";
import { routeById } from "@/components/shell/nav";
import { formatInt } from "@/lib/format";
import { loadMachineCounts, loadOptionalContext } from "@/server/data/core";
import { loadHemMenuCount, loadRouteMenuCount } from "@/app/(app)/_hem/v2/menu-counts";

import { FillShell } from "./_components/fill-shell";
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
 * AppUpdate visar "Ny version av appen finns" när en ny version har driftsatts.
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
  const buildId = await liveBuildId();
  // V2 (docs/design/v2/byggplan.md 4.1): ljusa Polaris-färger och V2:s notiser, utom i Enkel vy.
  const v2 = ctx.viewMode !== "simple";
  const page = (
    <div
      // V2: sidan styr bredden själv (en kolumn på telefon, två på datorn, .v2-fill-app).
      className={
        v2
          ? "min-h-dvh w-full bg-bg text-fg"
          : "mx-auto min-h-dvh w-full max-w-[560px] bg-bg text-fg"
      }
      data-ui={v2 ? "v2" : undefined}
    >
      {v2 ? <V2Toaster /> : null}
      <ServiceWorkerRegistration scope={scope} />
      {/* "Ny version av appen finns": överst, så att Klar nedtill aldrig skyms. */}
      <AppUpdate buildId={buildId} />
      {children}
    </div>
  );
  // Enkel vy: samma tre flikar nedtill som i resten av den enkla vyn (Fyll på har en egen
  // rubrikrad med menyknappen, se FillApp).
  if (!v2) {
    return (
      <AppFrameRoot
        locale={ctx.locale}
        simple={{ role: ctx.role, email: ctx.user.email }}
        topBar={false}
      >
        {page}
      </AppFrameRoot>
    );
  }
  // V2 på datorn: sidomenyn som på appens övriga sidor (prototypen). Räknarna strömmar in och
  // ett fel i dem stoppar aldrig Fyll på. På telefonen döljer v2.css sidomenyn.
  const machineCounts = await loadMachineCounts().catch(() => new Map<string, number>());
  const todoCount = routeById("hem").roles.includes(ctx.role)
    ? loadHemMenuCount().catch(() => undefined)
    : undefined;
  const routeCount = routeById("rutt").roles.includes(ctx.role)
    ? loadRouteMenuCount().catch(() => undefined)
    : undefined;
  return (
    <AppFrameRoot locale={ctx.locale} simple={null} topBar={false}>
      <FillShell
        role={ctx.role}
        user={{ name: ctx.user.displayName ?? ctx.user.email, email: ctx.user.email }}
        organizations={ctx.organizations.map((o) => {
          const n = machineCounts.get(o.id);
          return {
            id: o.id,
            name: o.name,
            detail:
              n === undefined ? undefined : `${formatInt(n)} ${n === 1 ? "automat" : "automater"}`,
          };
        })}
        activeOrganizationId={ctx.organization.id}
        todoCount={todoCount}
        routeCount={routeCount}
      >
        {page}
      </FillShell>
    </AppFrameRoot>
  );
}
