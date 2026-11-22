"use client";

import { useRouter } from "next/navigation";
import { useCallback, useTransition, type ReactNode } from "react";

import { clearAllRecent } from "@/components/shell/command-recent";
import type { Role } from "@/components/shell/nav";
import type { ShellOrganization, ShellUser, TodoCountSource } from "@/components/shell/side-nav";
import { V2SideNav } from "@/components/v2/shell/side-nav";
import { useToast } from "@/components/ui/toast";
import { logout, switchOrganization } from "@/server/actions/auth";

/**
 * V2-skalet runt Fyll på på datorn (prototypen: sidomenyn till vänster, sidan bredvid). Under
 * 900 px döljs sidomenyn av v2.css (.v2-side) och telefonen får Fyll på som förut: ingen
 * bottenrad, Klar ligger längst ner. Organisationsbytet och Logga ut som i appens skal.
 */
export function FillShell({
  role,
  user,
  organizations,
  activeOrganizationId,
  todoCount,
  routeCount,
  children,
}: {
  role: Role;
  user: ShellUser;
  organizations: ShellOrganization[];
  activeOrganizationId: string;
  todoCount?: TodoCountSource;
  routeCount?: TodoCountSource;
  children: ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const [, startTransition] = useTransition();

  const signOut = useCallback(
    () =>
      startTransition(async () => {
        clearAllRecent();
        const result = await logout();
        if (result.ok) router.replace("/logga-in");
        else toast({ title: "Kunde inte logga ut", description: result.error, tone: "critical" });
      }),
    [router, toast],
  );

  return (
    <div className="v2-app v2-fill-shell" data-ui="v2">
      <V2SideNav
        role={role}
        todoCount={todoCount}
        routeCount={routeCount}
        user={user}
        organizations={organizations}
        activeOrganizationId={activeOrganizationId}
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
      />
      <div className="v2-fill-shell-main">{children}</div>
    </div>
  );
}
