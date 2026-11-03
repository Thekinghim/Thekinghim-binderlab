import Link from "next/link";

import { wallClockIn } from "@/components/shell/period-state";
import { formatRelative } from "@/lib/format";
import { loadContext } from "@/server/data/core";

import { currentViewer } from "@/app/(app)/lager/_lib/session";

import { loadFillDataFor } from "../_lib/data";
import { FillApp } from "./fill-app";

/** Serverdelen av Fyll på (/fyll-pa och /fyll-pa/<automat>): samma data, samma app. */
export async function FillPage() {
  const ctx = await loadContext();
  if (!["owner", "admin", "refiller"].includes(ctx.role)) {
    return (
      <div className="flex flex-col gap-4 px-4 pt-[calc(24px+env(safe-area-inset-top))]">
        <p className="label text-subtle">Fyll på</p>
        <h1 className="text-2xl font-medium text-fg">
          Påfyllning registreras av ägare, admin och påfyllare.
        </h1>
        <Link href="/" className="text-md text-muted underline underline-offset-4">
          Till Binderlab
        </Link>
      </div>
    );
  }
  const now = new Date(ctx.now);
  const data = await loadFillDataFor(await currentViewer(), now);
  const syncLabels: Record<string, string> = {};
  for (const m of data.machines) {
    if (m.syncedAt) {
      syncLabels[m.id] = formatRelative(
        wallClockIn(new Date(m.syncedAt), ctx.timeZone),
        wallClockIn(now, ctx.timeZone),
      );
    }
  }
  return (
    <FillApp scope={`${ctx.organization.id}:${ctx.user.id}`} data={data} syncLabels={syncLabels} />
  );
}
