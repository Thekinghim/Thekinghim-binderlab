"use client";

import { usePathname } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useState,
  type CSSProperties,
  type ReactNode,
} from "react";
import { useCommandPaletteHotkey } from "@/components/ui/command-hotkey";
import type { CommandGroup } from "@/components/ui/command-palette";
import { fabLayout, phoneFabLayout, showsRefillShortcut } from "./fab";
import { MobileNav } from "./mobile-nav";
import { activeRouteId, homeHref, routeById, routesForRole, showsContext, type Role } from "./nav";
import type { ShellMachine, ShellStore } from "./period-bar";
import {
  Sidebar,
  type ShellOrganization,
  type ShellUser,
  type SyncState,
  type TodoCountSource,
} from "./side-nav";
import { NavigationProgress, ShellMain, ShellNavigationProvider } from "./shell-navigation";
import { SubTabs } from "./sub-tabs";
import { Topbar, type Period } from "./topbar";
import { useAutoRefresh } from "./use-auto-refresh";
import { V2ShellProvider } from "@/components/v2/shell/shell-context";
import { V2SideNavSlot } from "@/components/v2/shell/side-nav";
import { BackHistory } from "@/components/v2/shell/back";
import { V2TabBar } from "@/components/v2/shell/tab-bar";
import { FillReturnToast } from "@/components/v2/fill-return-toast";
import { V2Toaster } from "@/components/v2/toast";
import { lazyPart } from "@/lib/lazy-part";

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
  /** Vyknappen "Med VMB": användarens nyckel för att minnas valet. null = ingen knapp. */
  vmbUserKey?: string | null;
  /**
   * Visa periodval och filter. Standard: på, utom för rutter och vyer med
   * context: false i ./nav (Datakällor, Inställningar, Drift, Inköp, Bokföring …).
   */
  showContext?: boolean;
  /** Sidans vy (?vy=), för underflikarna som döljer periodvalet (Bokföring, Butiksportal). */
  view?: string | null;
  /** Aktiv sökväg. Standard: aktuell sökväg. */
  activeHref?: string;
  /** Äldre lokalt periodval (/design, /datamodell). */
  period?: Period;
  onPeriodChange?: (p: Period) => void;
  comparison?: string;
  /**
   * "v2": V2-skalet (docs/design/v2/byggplan.md avsnitt 4): Polaris-färgerna, sidomenyn med
   * sju poster, bottenraden med fem flikar och notiserna (sonner). De gamla sidornas huvud
   * (brödsmulor, filter, underflikar) står kvar men döljs på V2-sidor (data-v2-page).
   * Standard "legacy" (/design och /datamodell har det gamla skalet).
   */
  ui?: "v2" | "legacy";
  /** V2: antal stopp i dagens rutt (grått tal vid Rutt). */
  routeCount?: TodoCountSource;
  /** V2: organisationens tidszon (Uppdaterad-klockslaget). */
  timeZone?: string;
  /**
   * V2: servern tror att det är en telefon (src/lib/phone-hint.ts). Sidomenyn renderas då
   * inte i första svaret (telefonen döljer den ändå), bara om skärmen visar sig vara bred.
   */
  phoneHint?: boolean;
};

/** Skalets kommandopalett laddas först när den öppnas första gången. */
const shellCommandPalette = lazyPart(() =>
  import("./shell-command-palette").then((m) => m.ShellCommandPalette),
);
const ShellCommandPalette = shellCommandPalette.Component;

/**
 * Appens skal: sidomeny (lg+), bottenrad med "Mer" (mobil), toppbar med
 * sök och kontextrad (period + filter i URL:en) och kommandopaletten.
 */
export function AppShell(props: AppShellProps) {
  const { children, onOpenCommand } = props;
  const pathname = usePathname();
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Paletten monteras vid första öppningen och ligger sedan kvar.
  const [paletteUsed, setPaletteUsed] = useState(false);
  if (paletteOpen && !paletteUsed) setPaletteUsed(true);
  const role = props.role ?? "owner";
  const routeId = activeRouteId(props.activeHref ?? pathname);
  const route = routeId ? routeById(routeId) : null;
  const showContext = props.showContext ?? showsContext(props.activeHref ?? pathname, props.view);
  // Luft under sidan för de flytande knapparna på mobilen (./fab), så att inget göms bakom dem.
  const refill = showsRefillShortcut(role, props.activeHref ?? pathname);
  const fab = fabLayout({
    refill,
    assistant: routesForRole(role).some((r) => r.id === "assistent"),
  });
  // Telefonen (under md) har ingen flytande AI-knapp och behöver mindre luft.
  const phoneFab = phoneFabLayout({ refill });
  const orgName = (
    props.organizations?.find((o) => o.id === props.activeOrganizationId) ??
    props.organizations?.[0]
  )?.name;
  const crumbs =
    props.crumbs ?? [orgName, route?.label ?? "Binderlab"].filter((c): c is string => !!c);
  useCommandPaletteHotkey(setPaletteOpen, { enabled: !onOpenCommand });
  useAutoRefresh();

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
  const v2 = props.ui === "v2";
  const openCommand = useCallback(
    () => (onOpenCommand ? onOpenCommand() : setPaletteOpen(true)),
    [onOpenCommand],
  );
  useLightTheme(v2);

  if (v2) {
    const syncedAt =
      props.syncedAt === undefined
        ? undefined
        : typeof props.syncedAt === "string"
          ? props.syncedAt
          : props.syncedAt.toISOString();
    return (
      <ShellNavigationProvider>
        <V2ShellProvider
          value={{
            role,
            syncedAt,
            syncState: props.syncState,
            openCommand,
            timeZone: props.timeZone ?? "Europe/Stockholm",
            stores: props.stores,
            machines: props.machines,
            vmbUserKey: props.vmbUserKey ?? null,
          }}
        >
          <div className="v2-app" data-ui="v2">
            <NavigationProgress />
            <a
              href="#main"
              className="sr-only-focusable text-white fixed top-2 left-2 z-50 rounded-v2 bg-v2-primary px-3 py-2"
            >
              Hoppa till innehåll
            </a>
            <V2SideNavSlot
              ssr={!props.phoneHint}
              role={role}
              todoCount={props.todoCount}
              routeCount={props.routeCount}
              user={props.user}
              organizations={props.organizations}
              activeOrganizationId={props.activeOrganizationId}
              onOrganizationChange={props.onOrganizationChange}
              onSignOut={props.onSignOut}
            />
            <ShellMain className="v2-main" fade={false}>
              {/* De gamla sidornas huvud: döljs av CSS när sidan är en V2-sida (data-v2-page). */}
              <div data-legacy-chrome>
                <Topbar
                  crumbs={crumbs}
                  homeHref={homeHref(role)}
                  onOpenCommand={openCommand}
                  assistantHref={routesForRole(role).find((r) => r.id === "assistent")?.href}
                  showContext={showContext}
                  stores={props.stores}
                  machines={props.machines}
                  earliest={props.earliest}
                  vmbUserKey={route?.vmb === false ? null : (props.vmbUserKey ?? null)}
                />
                <SubTabs
                  role={role}
                  activeHref={props.activeHref}
                  todoCount={props.todoCount}
                  className="mx-auto w-full max-w-[1280px] px-4 pt-1 md:px-8 md:pt-5"
                />
              </div>
              <div key={pathname}>{children}</div>
            </ShellMain>
            <V2TabBar role={role} todoCount={props.todoCount} />
            <BackHistory />
            <V2Toaster />
            <FillReturnToast />
            {onOpenCommand || !paletteUsed ? null : (
              <Suspense fallback={null}>
                <ShellCommandPalette
                  open={paletteOpen}
                  onOpenChange={setPaletteOpen}
                  role={role}
                  stores={props.stores ?? []}
                  machines={props.machines ?? []}
                  machineHref={props.machineHref}
                  commands={props.commands}
                  withPeriod={showContext}
                  onSignOut={props.onSignOut}
                  signOutHref={props.signOutHref}
                />
              </Suspense>
            )}
          </div>
        </V2ShellProvider>
      </ShellNavigationProvider>
    );
  }

  return (
    <ShellNavigationProvider>
      <div className="flex min-h-dvh">
        <NavigationProgress />
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
            assistantHref={routesForRole(role).find((r) => r.id === "assistent")?.href}
            showContext={showContext}
            stores={props.stores}
            machines={props.machines}
            earliest={props.earliest}
            vmbUserKey={route?.vmb === false ? null : (props.vmbUserKey ?? null)}
            period={props.period}
            onPeriodChange={props.onPeriodChange}
            comparison={props.comparison}
          />
          <ShellMain
            className="flex-1 pb-[var(--shell-pb-phone)] md:pb-[var(--shell-pb)] lg:pb-0"
            style={
              {
                "--shell-pb": `calc(${fab.mainPaddingBottom}px + env(safe-area-inset-bottom))`,
                "--shell-pb-phone": `calc(${phoneFab.mainPaddingBottom}px + env(safe-area-inset-bottom))`,
              } as CSSProperties
            }
          >
            {/* Underflikarna står still vid sidbyte, så att markeringen kan glida. */}
            <SubTabs
              role={role}
              activeHref={props.activeHref}
              todoCount={props.todoCount}
              className="mx-auto w-full max-w-[1280px] px-4 pt-1 md:px-8 md:pt-5"
            />
            {/* Mjuk övergång vid sidbyte: nyckeln är sökvägen, så periodbyten animeras inte. */}
            <div key={pathname} className="fade-in">
              {children}
            </div>
          </ShellMain>
        </div>
        <MobileNav {...navProps} />
        {onOpenCommand || !paletteUsed ? null : (
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
    </ShellNavigationProvider>
  );
}

/**
 * V2 är bara ljust (ägarens val): sätter data-theme="light" på <html> medan V2-skalet visas, så
 * att de gamla sidornas light:-varianter gäller. Personens sparade tema (cookien) ändras inte,
 * så portal och rapporter ser ut som förut. Färgerna själva kommer från v2.css redan i första
 * HTML-svaret (:root:has([data-ui="v2"])).
 */
function useLightTheme(on: boolean) {
  useEffect(() => {
    if (!on) return;
    const html = document.documentElement;
    const before = html.dataset.theme;
    html.dataset.theme = "light";
    return () => {
      if (before) html.dataset.theme = before;
      else delete html.dataset.theme;
    };
  }, [on]);
}
