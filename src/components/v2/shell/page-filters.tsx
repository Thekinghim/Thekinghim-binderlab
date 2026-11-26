"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { Suspense, useState, type ReactNode } from "react";

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
export function PageFilters({ fold = false }: { fold?: boolean }) {
  // Reserven ritar samma filter (utan ?vy=), så att inget byts ut eller hoppar vid laddning.
  return (
    <Suspense fallback={<PageFiltersInner view={null} fold={fold} active={0} />}>
      <PageFiltersWithView fold={fold} />
    </Suspense>
  );
}

/** Filtren som är valda i adressen (Butik, Butiksägare, Automat, Med VMB). */
export function activeFilterCount(sp: { get(name: string): string | null }): number {
  return ["butik", "agare", "automat", "vmb"].filter((k) => !!sp.get(k)).length;
}

function PageFiltersWithView({ fold }: { fold: boolean }) {
  const sp = useSearchParams();
  return <PageFiltersInner view={sp.get("vy")} fold={fold} active={activeFilterCount(sp)} />;
}

/**
 * `fold`: på telefonen fällda bakom en knapp "Filter" (med antalet valda), så att tabellen
 * börjar högst upp i stället för under två rader val. Datorn visar dem alltid.
 */
function Fold({ active, children }: { active: number; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="v2-filters-fold" data-open={open ? "" : undefined}>
      <button
        type="button"
        className="v2-btn v2-filters-toggle"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        Filter{active > 0 ? ` · ${active}` : ""}
        <span aria-hidden="true" className="chev">
          ▾
        </span>
      </button>
      {children}
    </div>
  );
}

function PageFiltersInner({
  view,
  fold,
  active,
}: {
  view: string | null;
  fold: boolean;
  active: number;
}) {
  const shell = useV2Shell();
  const path = usePathname();
  if (!shell || !showsContext(path, view)) return null;
  const id = activeRouteId(path);
  const vmbKey = id && routeById(id).vmb === false ? null : (shell.vmbUserKey ?? null);
  const stores = shell.stores ?? [];
  const machines = shell.machines ?? [];
  if (!vmbKey && stores.length === 0 && machines.length === 0) return null;
  const row = (
    <div className="v2-filters" role="group" aria-label="Filter">
      <ScopeFilter stores={stores} machines={machines} v2 />
      {vmbKey ? <VmbButton userKey={vmbKey} /> : null}
    </div>
  );
  return fold ? <Fold active={active}>{row}</Fold> : row;
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
