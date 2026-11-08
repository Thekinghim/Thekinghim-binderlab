import Link from "next/link";

import { messages } from "@/i18n";
import { loadContext } from "@/server/data/core";

import { currentViewer } from "@/app/(app)/lager/_lib/session";

import { loadFillDataFor } from "../_lib/data";
import { FillApp } from "./fill-app";

/** Serverdelen av Fyll på (/fyll-pa och /fyll-pa/<automat>): samma data, samma app. */
export async function FillPage({ machineId = null }: { machineId?: string | null } = {}) {
  const ctx = await loadContext();
  const t = messages(ctx.locale);
  if (!["owner", "admin", "refiller"].includes(ctx.role)) {
    return (
      <div className="flex flex-col gap-4 px-4 pt-[calc(24px+env(safe-area-inset-top))]">
        <p className="label text-subtle">{t.fill.title}</p>
        <h1 className="text-2xl font-medium text-fg">{t.fill.onlyRefillers}</h1>
        <Link href="/" className="text-md text-muted underline underline-offset-4">
          {t.fill.toApp}
        </Link>
      </div>
    );
  }
  const now = new Date(ctx.now);
  const data = await loadFillDataFor(await currentViewer(), now);
  return (
    <FillApp
      scope={`${ctx.organization.id}:${ctx.user.id}`}
      data={data}
      timeZone={ctx.timeZone}
      renderedAt={now.toISOString()}
      initialMachineId={
        machineId && data.machines.some((m) => m.id === machineId) ? machineId : null
      }
    />
  );
}
