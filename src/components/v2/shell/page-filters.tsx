"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense } from "react";

import { activeRouteId, routeById, showsContext } from "@/components/shell/nav";
import { ScopeFilter } from "@/components/shell/period-bar";
import { useVmbView } from "@/components/shell/use-period";
import { VMB_TOGGLE_TITLE, vmbToggleLabel } from "@/components/shell/vmb-toggle";

import { useV2Shell } from "./shell-context";

/**
 * Sidans filter i V2-sidhuvudet: Butik och Automat (?butik=, ?agare=, ?automat=) och
 * vyknappen "Med VMB" (?vmb=1), samma val som de gamla sidornas kontextrad. Visas bara där
 * sidan har filter (nav.ts: context, vmb) och när rollen har något att välja.
 */
export function PageFilters() {
  // Reserven ritar samma filter (utan ?vy=), så att inget byts ut eller hoppar vid laddning.
  return (
    <Suspense fallback={<PageFiltersInner view={null} />}>
      <PageFiltersWithView />
    </Suspense>
  );
}

function PageFiltersWithView() {
  return <PageFiltersInner view={useSearchParams().get("vy")} />;
}

function PageFiltersInner({ view }: { view: string | null }) {
  const shell = useV2Shell();
  const path = usePathname();
  if (!shell || !showsContext(path, view)) return null;
  const id = activeRouteId(path);
  const vmbKey = id && routeById(id).vmb === false ? null : (shell.vmbUserKey ?? null);
  const stores = shell.stores ?? [];
  const machines = shell.machines ?? [];
  if (!vmbKey && stores.length === 0 && machines.length === 0) return null;
  return (
    <div className="v2-filters" role="group" aria-label="Filter">
      <ScopeFilter stores={stores} machines={machines} v2 />
      {vmbKey ? <VmbButton userKey={vmbKey} /> : null}
    </div>
  );
}

function VmbButton({ userKey }: { userKey: string }) {
  const { on, setOn } = useVmbView(userKey);
  return (
    <button
      type="button"
      aria-pressed={on}
      title={VMB_TOGGLE_TITLE}
      onClick={() => setOn(!on)}
      className="v2-btn v2-filter-vmb"
    >
      <span aria-hidden="true" className="box" />
      {vmbToggleLabel(on)}
    </button>
  );
}
