import type { ReactNode } from "react";
import type { ShellMachine, ShellStore } from "@/components/shell/period-bar";
import { routeById } from "@/components/shell/nav";
import { formatInt } from "@/lib/format";
import {
  isoDateToShellDate,
  loadDataStart,
  loadMachineCounts,
  loadMasterData,
  loadOptionalContext,
  loadSyncInfo,
  loadTodos,
} from "@/server/data/core";
import { requireUser } from "@/server/session";
import { AppFrame } from "./app-frame";
import { NoOrganization } from "./no-organization";

/**
 * Layouten för de inloggade sidorna: skalet kring varje rutt i menyn.
 *
 * Kräver en session (requireUser skickar annars till /logga-in; proxyn är bara en
 * bekvämlighet). Rollen läses ur databasen och styr bara vad menyn visar; varje sida
 * kontrollerar själv behörigheten (requireRoute/requireContextRole i
 * src/server/data/core) och laddarna kontrollerar den igen innan de läser data.
 *
 * Allt läses via de gemensamma laddarna (withUserDb, RLS) och memoiseras per förfrågan,
 * så sidorna kan anropa samma laddare utan dubbla frågor.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const ctx = await loadOptionalContext();
  if (!ctx) return <NoOrganization email={user.email} />;

  const hasTodos = routeById("att-gora").roles.includes(ctx.role);
  const [master, sync, dataStart, machineCounts, todoCount] = await Promise.all([
    loadMasterData(),
    loadSyncInfo(),
    loadDataStart(),
    loadMachineCounts(),
    hasTodos ? countTodos() : Promise.resolve(undefined),
  ]);

  const stores: ShellStore[] = master.stores
    .filter((s) => !s.archived)
    .map((s) => ({ id: s.id, name: s.name }));
  const machines: ShellMachine[] = master.machines
    .filter((m) => !m.archived)
    .map((m) => ({ id: m.id, name: m.name, code: m.code, storeId: m.storeId ?? undefined }));

  return (
    <AppFrame
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
      syncedAt={sync?.syncedAt ?? undefined}
      syncState={sync?.state}
      stores={stores}
      machines={machines}
      earliest={dataStart ? isoDateToShellDate(dataStart) : undefined}
    >
      {children}
    </AppFrame>
  );
}

/** Antal punkter i Att göra. Ett fel i reglerna får inte stoppa hela appen: då visas ingen räknare. */
async function countTodos(): Promise<number | undefined> {
  try {
    return (await loadTodos()).length;
  } catch (error) {
    console.error("[layout] Att göra kunde inte räknas:", error);
    return undefined;
  }
}
