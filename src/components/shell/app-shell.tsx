"use client";

import { usePathname, useRouter } from "next/navigation";
import { Suspense, useMemo, useState, type ReactNode } from "react";
import {
  CommandPalette,
  useCommandPaletteHotkey,
  type CommandGroup,
  type CommandItem,
} from "@/components/ui/command-palette";
import { MobileNav } from "./mobile-nav";
import { activeRouteId, homeHref, routeById, routesForRole, type Role } from "./nav";
import type { ShellMachine, ShellStore } from "./period-bar";
import { periodChoices } from "./period-state";
import {
  Sidebar,
  type ShellOrganization,
  type ShellUser,
  type SyncState,
  type TodoCountSource,
} from "./side-nav";
import { setTheme, useTheme } from "./theme-toggle";
import { Topbar, type Period } from "./topbar";
import { useCarriedQuery, usePeriod, useScope } from "./use-period";

export type AppShellProps = {
  children: ReactNode;
  /**
   * Brödsmulor; sista ledet är sidan. Under md visas bara sista ledet.
   * Standard: [aktiv organisation, aktiv rutt].
   */
  crumbs?: string[];
  role?: Role;
  user?: ShellUser;
  organizations?: ShellOrganization[];
  activeOrganizationId?: string;
  onOrganizationChange?: (id: string) => void;
  /** Antal öppna åtgärder, visas vid "Att göra". */
  todoCount?: TodoCountSource;
  /** Senaste synk, visas som "Synkad 1 nov. 21:23". */
  syncedAt?: Date | string;
  syncState?: SyncState;
  /** Butiker och automater till det globala filtret och kommandopaletten. */
  stores?: ShellStore[];
  machines?: ShellMachine[];
  /** Länk till en automat från kommandopaletten. Standard /automater/<id>. */
  machineHref?: (m: ShellMachine) => string;
  /** Sidans egna kommandon, läggs efter skalets grupper. */
  commands?: CommandGroup[];
  /**
   * Eget sätt att öppna kommandopaletten. Ges den renderar skalet ingen egen
   * palett och lyssnar inte på ⌘K/Ctrl K.
   */
  onOpenCommand?: () => void;
  onSignOut?: () => void;
  signOutHref?: string;
  /** Första dagen med data (för "Allt" och datumväljaren). */
  earliest?: Date;
  /**
   * Visa periodval och filter. Standard: på, utom för rutter med
   * context: false i ./nav (Datakällor, Inställningar).
   */
  showContext?: boolean;
  /** Aktiv sökväg. Standard: aktuell sökväg. */
  activeHref?: string;
  /** Äldre lokalt periodval (/design, /datamodell). */
  period?: Period;
  onPeriodChange?: (p: Period) => void;
  comparison?: string;
};

/**
 * Appens skal: sidomeny (lg+), bottenrad med "Mer" (mobil), toppbar med
 * sök och kontextrad (period + filter i URL:en) och kommandopaletten.
 */
export function AppShell(props: AppShellProps) {
  const { children, onOpenCommand } = props;
  const pathname = usePathname();
  const [paletteOpen, setPaletteOpen] = useState(false);
  const role = props.role ?? "owner";
  const routeId = activeRouteId(props.activeHref ?? pathname);
  const route = routeId ? routeById(routeId) : null;
  const showContext = props.showContext ?? route?.context !== false;
  const orgName = (
    props.organizations?.find((o) => o.id === props.activeOrganizationId) ??
    props.organizations?.[0]
  )?.name;
  const crumbs =
    props.crumbs ?? [orgName, route?.label ?? "Binderlab"].filter((c): c is string => !!c);
  useCommandPaletteHotkey(setPaletteOpen, { enabled: !onOpenCommand });

  const navProps = {
    role: props.role,
    activeHref: props.activeHref,
    todoCount: props.todoCount,
    user: props.user,
    organizations: props.organizations,
    activeOrganizationId: props.activeOrganizationId,
    onOrganizationChange: props.onOrganizationChange,
    syncedAt: props.syncedAt,
    syncState: props.syncState,
    onSignOut: props.onSignOut,
    signOutHref: props.signOutHref,
  };
  const legacyPeriod = props.period !== undefined && props.onPeriodChange !== undefined;

  return (
    <div className="flex min-h-dvh">
      <a
        href="#main"
        className="sr-only-focusable label fixed top-2 left-2 z-50 rounded-sm bg-inverse px-3 py-2 text-on-inverse"
      >
        Hoppa till innehåll
      </a>
      <Sidebar {...navProps} />
      <div className="flex min-w-0 flex-1 flex-col">
        <Topbar
          crumbs={crumbs}
          homeHref={homeHref(role)}
          onOpenCommand={onOpenCommand ?? (() => setPaletteOpen(true))}
          showContext={showContext}
          stores={props.stores}
          machines={props.machines}
          earliest={props.earliest}
          period={props.period}
          onPeriodChange={props.onPeriodChange}
          comparison={props.comparison}
        />
        <main id="main" className="flex-1 pb-[calc(56px+env(safe-area-inset-bottom))] lg:pb-0">
          {children}
        </main>
      </div>
      <MobileNav {...navProps} />
      {onOpenCommand ? null : (
        <Suspense fallback={null}>
          <ShellCommandPalette
            open={paletteOpen}
            onOpenChange={setPaletteOpen}
            role={role}
            stores={props.stores ?? []}
            machines={props.machines ?? []}
            machineHref={props.machineHref}
            commands={props.commands}
            withPeriod={!legacyPeriod && showContext}
            onSignOut={props.onSignOut}
            signOutHref={props.signOutHref}
          />
        </Suspense>
      )}
    </div>
  );
}

const defaultMachineHref = (m: ShellMachine) => `/automater/${encodeURIComponent(m.id)}`;

function ShellCommandPalette({
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
