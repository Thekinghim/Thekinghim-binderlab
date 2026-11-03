import Link from "next/link";

import { wallClockIn } from "@/components/shell/period-state";
import { formatRelative } from "@/lib/format";
import { loadContext } from "@/server/data/core";

import { currentViewer } from "@/app/(app)/lager/_lib/session";

import { loadFillDataFor } from "../_lib/data";
import { FillApp } from "./fill-app";

/** En Awish-läsning yngre än så här pulserar (synken går var 10:e minut). */
const FRESH_MS = 30 * 60_000;

/** Serverdelen av Fyll på (/fyll-pa och /fyll-pa/<automat>): samma data, samma app. */
export async function FillPage({ machineId = null }: { machineId?: string | null } = {}) {
  const ctx = await loadContext();
  if (!["owner", "admin", "refiller"].includes(ctx.role)) {
    return (
      <div className="flex flex-col gap-4 px-4 pt-[calc(24px+env(safe-area-inset-top))]">
        <p className="label text-subtle">Fyll på</p>
        <h1 className="text-2xl font-medium text-fg">Bara för dem som fyller på.</h1>
        <Link href="/" className="text-md text-muted underline underline-offset-4">
          Till Binderlab
        </Link>
      </div>
    );
  }
  const now = new Date(ctx.now);
  const data = await loadFillDataFor(await currentViewer(), now);
  const syncLabels: Record<string, string> = {};
  const fresh: Record<string, boolean> = {};
  for (const m of data.machines) {
    if (m.syncedAt) {
      const at = new Date(m.syncedAt);
      syncLabels[m.id] = formatRelative(
        wallClockIn(at, ctx.timeZone),
        wallClockIn(now, ctx.timeZone),
      );
      fresh[m.id] = now.getTime() - at.getTime() < FRESH_MS;
    }
  }
  return (
    <FillApp
      scope={`${ctx.organization.id}:${ctx.user.id}`}
      data={data}
      syncLabels={syncLabels}
      fresh={fresh}
      initialMachineId={
        machineId && data.machines.some((m) => m.id === machineId) ? machineId : null
      }
    />
  );
}
