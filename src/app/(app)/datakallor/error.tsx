"use client";

import { RouteError } from "@/components/ui/route-error";

/** Felläget när sidan inte kan visas, t.ex. när databasen inte svarar (RouteError). */
export default function DatakallorError({ error, retry }: { error: unknown; retry: () => void }) {
  return <RouteError error={error} retry={retry} area="Datakällor" />;
}
