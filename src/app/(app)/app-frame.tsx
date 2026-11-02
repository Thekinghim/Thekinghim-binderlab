"use client";

import { useRouter } from "next/navigation";
import { Suspense, useCallback, useState, useTransition, type ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import { CommandMenu } from "@/components/shell/command-menu";
import type { Role } from "@/components/shell/nav";
import type { ShellMachine, ShellStore } from "@/components/shell/period-bar";
import type { ShellOrganization, ShellUser, SyncState } from "@/components/shell/side-nav";
import { useCommandPaletteHotkey } from "@/components/ui/command-palette";
import { useToast } from "@/components/ui/toast";
import { logout, switchOrganization } from "@/server/actions/auth";

/**
 * Klientdelen av appens layout: kopplar skalets organisationsväxlare och
 * Logga ut till server actions. Allt annat skalet behöver kommer som props
 * från layouten (serverkomponent).
 *
 * Kommandopaletten är appens egen (CommandMenu: sökning på servern via GET /sok,
 * åtgärder, sidor och perioder). Skalet ritar då ingen egen palett och lyssnar inte
 * på ⌘K; genvägen registreras en gång, här.
 */
export function AppFrame({
  role,
  user,
  organizations,
  activeOrganizationId,
  todoCount,
  syncedAt,
  syncState,
  stores,
  machines,
  earliest,
  children,
}: {
  role: Role;
  user: ShellUser;
  organizations: ShellOrganization[];
  activeOrganizationId?: string;
  todoCount?: number;
  syncedAt?: string;
  syncState?: SyncState;
  stores: ShellStore[];
  machines: ShellMachine[];
  earliest?: Date;
  children: ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const [, startTransition] = useTransition();
  const [paletteOpen, setPaletteOpen] = useState(false);
  useCommandPaletteHotkey(setPaletteOpen);
  const openPalette = useCallback(() => setPaletteOpen(true), []);

  const signOut = useCallback(
    () =>
      startTransition(async () => {
        const result = await logout();
        if (result.ok) router.replace("/logga-in");
        else toast({ title: "Kunde inte logga ut", description: result.error, tone: "critical" });
      }),
    [router, toast],
  );

  return (
    <>
      <AppShell
        role={role}
        user={user}
        organizations={organizations}
        activeOrganizationId={activeOrganizationId}
        todoCount={todoCount}
        syncedAt={syncedAt}
        syncState={syncState}
        stores={stores}
        machines={machines}
        earliest={earliest}
        onOrganizationChange={(id) =>
          startTransition(async () => {
            const result = await switchOrganization(id);
            if (result.ok) router.refresh();
            else
              toast({
                title: "Kunde inte byta organisation",
                description: result.error,
                tone: "critical",
              });
          })
        }
        onSignOut={signOut}
        onOpenCommand={openPalette}
      >
        {children}
      </AppShell>
      <Suspense fallback={null}>
        <CommandMenu
          open={paletteOpen}
          onOpenChange={setPaletteOpen}
          role={role}
          organizationId={activeOrganizationId ?? ""}
          userEmail={user.email ?? user.name}
          stores={stores}
          machines={machines}
          onSignOut={signOut}
        />
      </Suspense>
    </>
  );
}
