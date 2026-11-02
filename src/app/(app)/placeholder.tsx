import type { Metadata } from "next";
import { ComingSoonPage } from "@/components/shell/coming-soon";
import { routeById, type RouteId } from "@/components/shell/nav";
import { requireRoute } from "@/server/data/core";

/** Platshållaren för en rutt i menyn tills sidan byggs (rubrik och fas från components/shell/nav). */
export function placeholderMetadata(id: RouteId): Metadata {
  return { title: routeById(id).label };
}

/**
 * Platshållarsidan. Kontrollerar rollen som en riktig sida gör (requireRoute): en
 * påfyllare som öppnar en rutt hen inte får se skickas till sin startsida.
 */
export async function RoutePlaceholder({ id }: { id: RouteId }) {
  await requireRoute(id);
  const r = routeById(id);
  return <ComingSoonPage title={r.label} lead={r.lead} phase={r.phase} />;
}
