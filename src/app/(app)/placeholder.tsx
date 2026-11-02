import type { Metadata } from "next";
import { ComingSoonPage } from "@/components/shell/coming-soon";
import { routeById, type RouteId } from "@/components/shell/nav";

/** Platshållaren för en rutt i menyn tills sidan byggs (rubrik och fas från ./nav). */
export function placeholderMetadata(id: RouteId): Metadata {
  return { title: routeById(id).label };
}

export function RoutePlaceholder({ id }: { id: RouteId }) {
  const r = routeById(id);
  return <ComingSoonPage title={r.label} lead={r.lead} phase={r.phase} />;
}
