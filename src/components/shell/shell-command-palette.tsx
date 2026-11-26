"use client";

import { useRouter } from "next/navigation";
import { useMemo } from "react";

import {
  CommandPalette,
  type CommandGroup,
  type CommandItem,
} from "@/components/ui/command-palette";

import { useCopyView } from "./copy-view";
import { routesForRole, type Role } from "./nav";
import type { ShellMachine, ShellStore } from "./period-bar";
import { periodChoices } from "./period-state";
import { setTheme, useTheme } from "./theme-toggle";
import { useCarriedQuery, usePeriod, useScope } from "./use-period";

/**
 * Skalets egen kommandopalett (när appen inte har en egen, t.ex. /design och /datamodell).
 * Egen fil: AppShell laddar den först när den öppnas första gången.
 */
const defaultMachineHref = (m: ShellMachine) => `/automater/${encodeURIComponent(m.id)}`;

export function ShellCommandPalette({
  open,
  onOpenChange,
  role,
  stores,
  machines,
  machineHref = defaultMachineHref,
  commands = [],
  withPeriod,
  onSignOut,
  signOutHref = "/logga-ut",
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  role: Role;
  stores: ShellStore[];
  machines: ShellMachine[];
  machineHref?: (m: ShellMachine) => string;
  commands?: CommandGroup[];
  withPeriod: boolean;
  onSignOut?: () => void;
  signOutHref?: string;
}) {
  const router = useRouter();
  const { key: periodKey, setPeriod } = usePeriod();
  const { butik, automat, setScope } = useScope();
  const theme = useTheme();
  const copyView = useCopyView();
  // Period och filter följer med till sidan man går till.
  const query = useCarriedQuery();

  const groups = useMemo<CommandGroup[]>(() => {
    const navigate: CommandItem[] = routesForRole(role).map((r) => ({
      id: `nav-${r.id}`,
      label: r.label,
      icon: r.icon,
      hint: r.href,
      onSelect: () => router.push(`${r.href}${query}`),
    }));

    // Påfyllare har varken Automater eller Butiker i menyn.
    const canBrowse = role !== "refiller";
    const storeById = new Map(stores.map((st) => [st.id, st]));

    const machineItems: CommandItem[] = canBrowse
      ? machines.map((m) => {
          const store = m.storeId ? storeById.get(m.storeId) : undefined;
          return {
            id: `m-${m.id}`,
            label: m.code ? `${m.code} ${m.name}` : m.name,
            hint: store?.name,
            icon: "machine",
            keywords: [m.code, m.name, store?.name, store?.city, "automat"].filter(
              (k): k is string => !!k,
            ),
            onSelect: () => router.push(`${machineHref(m)}${query}`),
          };
        })
      : [];

    // Butiker sätter det globala filtret när sidan har ett; annars går de till butikens sida.
    const storeItems: CommandItem[] = canBrowse
      ? stores.map((st) => {
          const count = machines.filter((m) => m.storeId === st.id).length;
          const detail = [
            st.city,
            count ? `${count} ${count === 1 ? "automat" : "automater"}` : null,
          ]
            .filter(Boolean)
            .join(" · ");
          return withPeriod
            ? {
                id: `s-${st.id}`,
                label: butik === st.id ? `${st.name} (filtrerad)` : `Filtrera på ${st.name}`,
                hint: detail || undefined,
                icon: "filter",
                keywords: [st.name, st.city, "butik", "filter"].filter((k): k is string => !!k),
                onSelect: () => setScope({ butik: st.id, automat: null }),
              }
            : {
                id: `s-${st.id}`,
                label: st.name,
                hint: detail || undefined,
                icon: "columns",
                keywords: [st.name, st.city, "butik"].filter((k): k is string => !!k),
                onSelect: () => router.push(`/butiker/${encodeURIComponent(st.id)}${query}`),
              };
        })
      : [];

    const actions: CommandItem[] = [];
    if (withPeriod) {
      for (const c of periodChoices) {
        const key = c.key;
        if (key === "eget" || key === periodKey) continue;
        actions.push({
          id: `p-${c.key}`,
          label: `Period: ${c.label}`,
          icon: "calendar",
          keywords: ["period", "datum", "tid"],
          onSelect: () => setPeriod({ key }),
        });
      }
      actions.push({
        id: "copy-view",
        label: "Kopiera länk till vyn",
        icon: "external",
        keywords: ["kopiera", "länk", "dela", "url"],
        onSelect: () => void copyView(),
      });
      if (butik || automat) {
        actions.push({
          id: "scope-clear",
          label: "Rensa filter på butik och automat",
          icon: "filter",
          keywords: ["filter", "alla"],
          onSelect: () => setScope({ butik: null, automat: null }),
        });
      }
    }
    actions.push({
      id: "theme",
      label: theme === "dark" ? "Byt till ljust läge" : "Byt till mörkt läge",
      icon: theme === "dark" ? "sun" : "moon",
      keywords: ["tema", "läge", "mörkt", "ljust"],
      onSelect: () => setTheme(theme === "dark" ? "light" : "dark"),
    });
    actions.push({
      id: "logout",
      label: "Logga ut",
      icon: "logout",
      onSelect: () => (onSignOut ? onSignOut() : window.location.assign(signOutHref)),
    });

    return [
      { label: "Navigera", items: navigate },
      ...(storeItems.length ? [{ label: "Butiker", items: storeItems }] : []),
      ...(machineItems.length ? [{ label: "Automater", items: machineItems }] : []),
      { label: "Åtgärder", items: actions },
      ...commands,
    ];
  }, [
    role,
    stores,
    machines,
    machineHref,
    commands,
    withPeriod,
    periodKey,
    setPeriod,
    butik,
    automat,
    setScope,
    theme,
    router,
    query,
    onSignOut,
    signOutHref,
    copyView,
  ]);

  return (
    <CommandPalette
      open={open}
      onOpenChange={onOpenChange}
      groups={groups}
      placeholder="Sök sida, butik, automat eller åtgärd"
    />
  );
}
