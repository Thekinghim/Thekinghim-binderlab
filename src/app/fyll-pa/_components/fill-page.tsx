import Link from "next/link";

import { messages } from "@/i18n";
import { loadContext } from "@/server/data/core";

import { currentViewer } from "@/app/(app)/lager/_lib/session";

import { loadDayRoute } from "@/server/data/v2/route";

import { loadFillDataFor } from "../_lib/data";
import { FillApp } from "./fill-app";

/** Serverdelen av Fyll på (/fyll-pa och /fyll-pa/<automat>): samma data, samma app. */
export async function FillPage({
  machineId = null,
  routeMode = false,
  returnTo = null,
}: {
  machineId?: string | null;
  /** Öppnad från Rutt (?rutt=1): dagens stopp i körordning (V2, ruttläget). */
  routeMode?: boolean;
  /** Öppnad från Hem eller Automater (?fran=): dit efter Klar, med Ångra i notisen. */
  returnTo?: string | null;
} = {}) {
  const ctx = await loadContext();
  const t = messages(ctx.locale);
  if (!["owner", "admin", "refiller"].includes(ctx.role)) {
    return (
      <div className="flex flex-col gap-4 px-4 pt-[calc(24px+env(safe-area-inset-top))]">
        <p className="text-v2-sm font-[550] text-v2-mute">{t.fill.title}</p>
        <h1 className="text-v2-xl font-[650] text-v2-ink">{t.fill.onlyRefillers}</h1>
        <Link href="/" className="text-v2-md text-v2-mute underline underline-offset-4">
          {t.fill.toApp}
        </Link>
      </div>
    );
  }
  const now = new Date(ctx.now);
  const [data, route] = await Promise.all([
    loadFillDataFor(await currentViewer(), now),
    routeMode && ctx.viewMode !== "simple"
      ? loadDayRoute()
          .then((r) => ({ ids: r.stops.map((x) => x.machineId) }))
          .catch(() => null)
      : Promise.resolve(null),
  ]);
  return (
    <FillApp
      scope={`${ctx.organization.id}:${ctx.user.id}`}
      data={data}
      timeZone={ctx.timeZone}
      renderedAt={now.toISOString()}
      route={route}
      returnTo={ctx.viewMode !== "simple" && !routeMode ? returnTo : null}
      initialMachineId={
        machineId && data.machines.some((m) => m.id === machineId) ? machineId : null
      }
    />
  );
}
