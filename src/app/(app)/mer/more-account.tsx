"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";

import { AppRefreshRow } from "@/components/pwa/app-refresh-button";
import { pushEndpointForLogout } from "@/components/pwa/push-device";
import { clearAllRecent } from "@/components/shell/command-recent";
import { Button } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { ListRow } from "@/components/v2/list-row";
import { toastV2 } from "@/components/v2/toast";
import { logout, switchOrganization } from "@/server/actions/auth";

/** Kontot på Mer: byt organisation, uppdatera appen och logga ut (telefonen har ingen sidomeny). */
export function MoreAccount({
  email,
  organizations,
  activeOrganizationId,
}: {
  email: string;
  organizations: { id: string; name: string }[];
  activeOrganizationId: string;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  return (
    <Card title="Konto">
      {organizations.length > 1
        ? organizations.map((o) => (
            <ListRow
              key={o.id}
              title={o.name}
              sub={o.id === activeOrganizationId ? "Vald nu" : undefined}
              actions={
                o.id === activeOrganizationId ? null : (
                  <Button
                    size="sm"
                    pending={pending}
                    onClick={() =>
                      start(async () => {
                        const r = await switchOrganization(o.id);
                        if (r.ok) router.refresh();
                        else
                          toastV2("Kunde inte byta organisation", {
                            detail: r.error,
                            tone: "critical",
                          });
                      })
                    }
                  >
                    Byt
                  </Button>
                )
              }
            />
          ))
        : null}
      {/* Hämtar senaste versionen och laddar om (även appen på hemskärmen). */}
      <AppRefreshRow className="px-[18px] text-v2-ink" />
      <ListRow
        title="Logga ut"
        sub={email}
        actions={
          <Button
            size="sm"
            pending={pending}
            onClick={() =>
              start(async () => {
                clearAllRecent();
                const r = await logout({ pushEndpoint: await pushEndpointForLogout() });
                if (r.ok) router.replace("/logga-in");
                else toastV2("Kunde inte logga ut", { detail: r.error, tone: "critical" });
              })
            }
          >
            Logga ut
          </Button>
        }
      />
    </Card>
  );
}
