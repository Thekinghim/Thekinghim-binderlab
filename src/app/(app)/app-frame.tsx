"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useState, useTransition, type ReactNode } from "react";
import { AssistantPanelProvider } from "@/components/assistant/assistant-panel";
import { AppShell } from "@/components/shell/app-shell";
import { CommandMenu } from "@/components/shell/command-menu";
import { DeniedNotice } from "@/components/shell/denied-notice";
import { clearAllRecent } from "@/components/shell/command-recent";
import type { Role } from "@/components/shell/nav";
import type { ShellMachine, ShellStore } from "@/components/shell/period-bar";
import { ShellOwnersProvider, type ShellOwner } from "@/components/shell/owners-context";
import type {
  ShellOrganization,
  ShellUser,
  SyncState,
  TodoCountSource,
} from "@/components/shell/side-nav";
import { useCommandPaletteHotkey } from "@/components/ui/command-palette";
import { useToast } from "@/components/ui/toast";
import { logout, switchOrganization } from "@/server/actions/auth";

import { crumbsFor } from "./crumbs";

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
  routeCount,
  syncedAt,
  syncState,
  stores,
  owners = [],
  machines,
  earliest,
  vmbUserKey = null,
  timeZone,
  children,
}: {
  role: Role;
  user: ShellUser;
  organizations: ShellOrganization[];
  activeOrganizationId?: string;
  todoCount?: TodoCountSource;
  /** V2: stoppen i dagens rutt (räknaren vid Rutt i sidomenyn). */
  routeCount?: TodoCountSource;
  syncedAt?: string;
  syncState?: SyncState;
  stores: ShellStore[];
  /** Butiksägare med flera butiker: val i filtret (?agare=). */
  owners?: ShellOwner[];
  machines: ShellMachine[];
  earliest?: Date;
  /** Vyknappen "Med VMB" (roller som ser ekonomi): användarens id. */
  vmbUserKey?: string | null;
  /** Organisationens tidszon (V2-sidhuvudets "Uppdaterad"). */
  timeZone?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const view = useSearchParams().get("vy");
  const toast = useToast();
  const orgName = (organizations.find((o) => o.id === activeOrganizationId) ?? organizations[0])
    ?.name;
  const [, startTransition] = useTransition();
  const [paletteOpen, setPaletteOpen] = useState(false);
  useCommandPaletteHotkey(setPaletteOpen);
  const openPalette = useCallback(() => setPaletteOpen(true), [setPaletteOpen]);

  const signOut = useCallback(
    () =>
      startTransition(async () => {
        // Palettens senaste val (ordernummer, titlar) ska inte finnas kvar för nästa
        // person vid datorn. Rensas före utloggningen, även om den skulle misslyckas.
        clearAllRecent();
        const result = await logout();
        if (result.ok) router.replace("/logga-in");
        else toast({ title: "Kunde inte logga ut", description: result.error, tone: "critical" });
      }),
    [router, toast, startTransition],
  );

  return (
    // AI-panelen ligger utanför sidorna: samtalet finns kvar när man byter sida.
    <AssistantPanelProvider role={role} stores={stores}>
      <ShellOwnersProvider owners={owners}>
        <AppShell
          ui="v2"
          timeZone={timeZone}
          role={role}
          user={user}
          organizations={organizations}
          activeOrganizationId={activeOrganizationId}
          todoCount={todoCount}
          routeCount={routeCount}
          syncedAt={syncedAt}
          syncState={syncState}
          stores={stores}
          machines={machines}
          earliest={earliest}
          vmbUserKey={vmbUserKey}
          crumbs={crumbsFor(pathname, orgName, view)}
          view={view}
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
      </ShellOwnersProvider>
      <Suspense fallback={null}>
        <DeniedNotice role={role} />
      </Suspense>
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
    </AssistantPanelProvider>
  );
}
