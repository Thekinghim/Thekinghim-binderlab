"use client";

import { RouteError } from "@/components/ui/route-error";

/**
 * Felläget när sidan inte kan visas, t.ex. när databasen inte svarar (RouteError). Rapportsidorna
 * ligger utanför appens skal: data-ui="v2" ger felet V2:s grå yta, färger och typsnitt.
 */
export default function RapportError({ error, retry }: { error: unknown; retry: () => void }) {
  return (
    <div data-ui="v2" className="min-h-dvh bg-v2-bg">
      <RouteError
        error={error}
        retry={retry}
        area="Rapport"
        title="Rapporten kunde inte visas."
        home={{ label: "Till Rapporter", href: "/rapporter" }}
      />
    </div>
  );
}
