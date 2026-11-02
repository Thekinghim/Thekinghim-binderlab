import type { ReactNode } from "react";
import type { Role } from "@/components/shell/nav";
import { listOrganizationsFor } from "@/server/access";
import { getActiveOrganization, requireUser } from "@/server/session";
import { AppFrame } from "./app-frame";

/**
 * Layouten för de inloggade sidorna: skalet kring varje rutt i menyn.
 *
 * Proxyn skickar oinloggade till /logga-in, men layouten kräver ändå en
 * session (requireUser) eftersom proxyn bara är en bekvämlighet. Rollen
 * styr bara vad menyn visar; varje sida kontrollerar själv behörigheten
 * (requireRole) när den börjar visa data.
 *
 * Fas 3 kopplar på räknaren för Att göra, synkstatus och butiker/automater
 * till filtret och kommandopaletten.
 */
export default async function AppLayout({ children }: { children: ReactNode }) {
  const user = await requireUser();
  const [active, organizations] = await Promise.all([
    getActiveOrganization(),
    listOrganizationsFor(user),
  ]);
  const role: Role = active?.role ?? "viewer";

  return (
    <AppFrame
      role={role}
      user={{ name: user.email }}
      organizations={organizations.map((o) => ({ id: o.id, name: o.name }))}
      activeOrganizationId={active?.id}
    >
      {children}
    </AppFrame>
  );
}
