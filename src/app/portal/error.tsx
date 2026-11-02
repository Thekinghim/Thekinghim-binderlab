"use client";

import { RouteError } from "@/components/ui/route-error";

/** Felläget när sidan inte kan visas, t.ex. när databasen inte svarar (RouteError). */
export default function PortalError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div className="pt-8 md:pt-12">
      <RouteError
        error={error}
        retry={retry}
        area="Butiksportalen"
        inset="inset"
        home={{ label: "Till översikten", href: "/portal" }}
      />
    </div>
  );
}
