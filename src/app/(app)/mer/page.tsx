import type { Metadata } from "next";

import { routesForRole, v2NavForRole, type RouteId } from "@/components/shell/nav";
import { Card } from "@/components/v2/card";
import { ListRow } from "@/components/v2/list-row";
import { V2Page } from "@/components/v2/shell/page";
import { requireRoute } from "@/server/data/core";

import { MoreAccount } from "./more-account";

export const metadata: Metadata = { title: "Mer" };

/** Sidorna som redan står i menyn (sidomenyn och bottenraden), utom Butiker och Pengar. */
const IN_MENU: ReadonlySet<RouteId> = new Set(["hem", "automater", "rutt", "vart-lager", "mer"]);

/**
 * Mer (/mer): alla sidor rollen får se, med Butiker och Pengar överst (de står inte i mobilens
 * bottenrad), och kontot (organisation, logga ut). Grunden (F0) bygger listan; Mer-gruppen (G4)
 * lägger till Driften-kortet, Kopplingar och Lägg till automat/butik.
 */
export default async function MorePage() {
  const ctx = await requireRoute("mer");
  const top = v2NavForRole(ctx.role).filter((i) => i.id === "butiker" || i.id === "pengar");
  const pages = routesForRole(ctx.role).filter(
    (r) => !IN_MENU.has(r.id) && r.id !== "pengar" && r.id !== "butiker",
  );
  return (
    <V2Page title="Mer">
      <div className="mx-auto flex max-w-[760px] flex-col gap-3.5">
        {top.length > 0 ? (
          <Card title="Sidor">
            {top.map((i) => (
              <ListRow
                key={i.id}
                href={i.href}
                title={i.label}
                actions={<span aria-hidden="true">→</span>}
              />
            ))}
          </Card>
        ) : null}
        <Card title="Alla sidor">
          {pages.map((r) => (
            <ListRow
              key={r.id}
              href={r.href}
              title={r.label}
              sub={r.lead}
              actions={<span aria-hidden="true">→</span>}
            />
          ))}
        </Card>
        <MoreAccount
          email={ctx.user.email}
          organizations={ctx.organizations.map((o) => ({ id: o.id, name: o.name }))}
          activeOrganizationId={ctx.organization.id}
        />
      </div>
    </V2Page>
  );
}
