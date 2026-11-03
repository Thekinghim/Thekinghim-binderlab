import { ConfigMissing } from "@/components/ui/config-missing";
import { getConfigStatus } from "@/server/config-status";
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
} from "@/server/data/core";
import { redirectStoreUserToPortal } from "@/server/portal/session";
import { loadTodoCount } from "@/server/data/todos";
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
// Inloggade sidor läser sessionen per förfrågan och förrenderas aldrig vid bygget.
export const dynamic = "force-dynamic";

export default async function AppLayout({ children }: { children: ReactNode }) {
  const config = getConfigStatus();
  if (!config.ok) return <ConfigMissing issues={config.issues} />;
  const user = await requireUser();
  // Allt skalet behöver läses parallellt (varje laddare är minst en rundresa till
  // databasen). Stamdata m.m. kräver en organisation: utan den avvisas de, och felet
  // fångas här eftersom layouten då visar NoOrganization i stället.
  const ctxP = loadOptionalContext();
  const shellP = Promise.all([
    loadMasterData(),
    loadSyncInfo(),
    loadDataStart(),
    loadMachineCounts(),
  ]);
  shellP.catch(() => {});
  const ctx = await ctxP;
  if (!ctx) {
    // En butiksanvändare (rollen store, fas 10) har ingen approll: till /portal.
    await redirectStoreUserToPortal();
    return <NoOrganization email={user.email} />;
  }

  const hasTodos = routeById("att-gora").roles.includes(ctx.role);
  // Räknaren i menyn väntas inte in: den skickas som ett löfte och strömmar in när
  // punkterna är räknade (Att göra läser order och lager och tar längst tid i skalet).
  const todoCount = hasTodos ? countTodos() : undefined;
  const [master, sync, dataStart, machineCounts] = await shellP;

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
      vmbUserKey={ctx.canSeeEconomy ? ctx.user.id : null}
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
    // Samma punkter som listan: utan påfyllningar av utgångna titlar (som Lager och Drift).
    return await loadTodoCount();
  } catch (error) {
    console.error("[layout] Att göra kunde inte räknas:", error);
    return undefined;
  }
}
