import { shellRoutes, type Role, type RouteId } from "@/components/shell/nav";
import { RoutePlaceholder } from "@/app/(app)/placeholder";
import { parsePeriod, parseScope, toIsoDate } from "@/components/shell/period-state";
import { LabShell } from "./lab-shell";

export const metadata = { title: "Lab: skal" };

const ROLES: Role[] = ["owner", "admin", "refiller", "viewer"];

export default async function Page({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const role = ROLES.includes(sp.roll as Role) ? (sp.roll as Role) : "owner";
  const p = parsePeriod(sp, { now: new Date("2026-11-02T09:30:00+01:00") });
  const scope = parseScope(sp);
  const page =
    shellRoutes.find((r) => r.id === sp.sida) ?? shellRoutes.find((r) => r.id === "lonsamhet")!;
  return (
    <LabShell
      role={role}
      syncState={sp.synk === "fel" ? "failed" : sp.synk === "gammal" ? "stale" : "ok"}
      activeHref={page.href}
    >
      <RoutePlaceholder id={page.id as RouteId} />
      <div className="mx-auto max-w-[1280px] px-4 md:px-8">
        <p className="label text-subtle">Servern läste (parsePeriod)</p>
        <p className="meta tnum mt-2 text-muted">
          {p.key} · {p.range ? `${toIsoDate(p.range.start)}/${toIsoDate(p.range.end)}` : "–"} · mot{" "}
          {p.previous ? `${toIsoDate(p.previous.start)}/${toIsoDate(p.previous.end)}` : "–"} · butik{" "}
          {scope.butik ?? "alla"} · automat {scope.automat ?? "alla"}
        </p>
        <div className="h-[120vh]" />
      </div>
    </LabShell>
  );
}
