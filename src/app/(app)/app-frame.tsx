"use client";

import { useRouter } from "next/navigation";
import { useTransition, type ReactNode } from "react";
import { AppShell } from "@/components/shell/app-shell";
import type { Role } from "@/components/shell/nav";
import type { ShellOrganization, ShellUser } from "@/components/shell/side-nav";
import { useToast } from "@/components/ui/toast";
import { logout, switchOrganization } from "@/server/actions/auth";

/**
 * Klientdelen av appens layout: kopplar skalets organisationsväxlare och
 * Logga ut till server actions. Allt annat skalet behöver kommer som props
 * från layouten (serverkomponent).
 */
export function AppFrame({
  role,
  user,
  organizations,
  activeOrganizationId,
  children,
}: {
  role: Role;
  user: ShellUser;
  organizations: ShellOrganization[];
  activeOrganizationId?: string;
  children: ReactNode;
}) {
  const router = useRouter();
  const toast = useToast();
  const [, startTransition] = useTransition();

  return (
    <AppShell
      role={role}
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
      onSignOut={() =>
        startTransition(async () => {
          const result = await logout();
          if (result.ok) router.replace("/logga-in");
          else toast({ title: "Kunde inte logga ut", description: result.error, tone: "critical" });
        })
      }
    >
      {children}
    </AppShell>
  );
}
