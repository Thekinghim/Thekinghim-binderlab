"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Suspense,
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@/lib/cn";
import { formatDateTime } from "@/lib/format";
import { Icon } from "@/components/ui/icon";
import { StatusGlyph } from "@/components/ui/status-tag";
import { Logo } from "./logo";
import {
  activeRouteId,
  homeHref,
  roleLabel,
  routesForRole,
  type Role,
  type RouteId,
  type ShellRoute,
} from "./nav";
import { wallClockIn } from "./period-state";
import { useCarriedQuery } from "./use-period";

/* ------------------------------------------------------------------ */
/* Typer                                                               */
/* ------------------------------------------------------------------ */

export type ShellUser = { name: string; email?: string };

export type ShellOrganization = {
  id: string;
  name: string;
  /** Kort fakta i mono, t.ex. "14 automater". */
  detail?: string;
};

/** ok: synkad. stale: data äldre än väntat. failed: senaste synk misslyckades (kräver åtgärd). */
export type SyncState = "ok" | "stale" | "failed";

export type ShellNavProps = {
  role?: Role;
  /** Sökväg som räknas som aktiv. Standard: aktuell sökväg. */
  activeHref?: string;
  todoCount?: number;
  user?: ShellUser;
  organizations?: ShellOrganization[];
  activeOrganizationId?: string;
  onOrganizationChange?: (id: string) => void;
  /** Senaste lyckade synk. Date eller ISO-sträng. */
  syncedAt?: Date | string;
  syncState?: SyncState;
  /** Logga ut. Utan den blir raden en länk till signOutHref. */
  onSignOut?: () => void;
  signOutHref?: string;
  /** Tidszon för klockslag. Standard Europe/Stockholm. */
  timeZone?: string;
};

/* ------------------------------------------------------------------ */
/* Delar (används även av mobilens "Mer"-ark)                          */
/* ------------------------------------------------------------------ */

/** Räknare för sådant som kräver åtgärd. Signal bara när talet är större än noll. */
export function TodoCounter({ count, className }: { count: number; className?: string }) {
  if (count <= 0) {
    return (
      <span className={cn("label tnum text-subtle", className)}>
        0<span className="sr-only"> att göra</span>
      </span>
    );
  }
  return (
    <span className={cn("label tnum flex items-center gap-1.5 text-signal-fg", className)}>
      <StatusGlyph status="critical" size={6} />
      {count}
      <span className="sr-only"> kräver åtgärd</span>
    </span>
  );
}

/** Hämtar period/filter ur URL:en till länkar; utan Suspense-stöd faller den tillbaka på rena länkar. */
export function WithCarriedQuery({ children }: { children: (query: string) => ReactNode }) {
  return (
    <Suspense fallback={children("")}>
      <CarriedQuery>{children}</CarriedQuery>
    </Suspense>
  );
}

function CarriedQuery({ children }: { children: (query: string) => ReactNode }) {
  return <>{children(useCarriedQuery())}</>;
}

/** En navigeringsrad: mono-löpnummer och text. Aktiv: förgrundsfärg och 1px linje vid x=0. */
export function NavRow({
  route,
  number,
  active,
  query,
  todoCount = 0,
  onNavigate,
  dense = false,
  numbered = true,
}: {
  route: ShellRoute;
  number: number;
  active: boolean;
  query: string;
  todoCount?: number;
  onNavigate?: () => void;
  dense?: boolean;
  /** Visa löpnumret. Av i "Mer"-arket, där urvalet ger luckor i numreringen. */
  numbered?: boolean;
}) {
  return (
    <li className="relative">
      {active ? <span aria-hidden className="absolute inset-y-0 left-0 w-px bg-fg" /> : null}
      <Link
        href={`${route.href}${query}`}
        onClick={onNavigate}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex items-center gap-3 px-4 text-base transition-colors focus-visible:-outline-offset-2",
          dense ? "h-8" : "h-11",
          active ? "text-fg" : "text-muted hover:text-fg",
        )}
      >
        {numbered ? (
          <span
            aria-hidden
            className={cn("label tnum w-4 shrink-0", active ? "text-fg" : "text-subtle")}
          >
            {String(number).padStart(2, "0")}
          </span>
        ) : null}
        <span className={cn("flex-1 truncate", active && "font-medium")}>{route.label}</span>
        {route.counter === "todo" ? <TodoCounter count={todoCount} /> : null}
      </Link>
    </li>
  );
}

export function NavList({
  routes,
  numbering,
  activeId,
  query,
  todoCount,
  onNavigate,
  dense,
  numbered,
}: {
  routes: ShellRoute[];
  /** Löpnummer per rutt, så att numren är desamma i alla vyer. */
  numbering: Map<RouteId, number>;
  activeId: RouteId | null;
  query: string;
  todoCount?: number;
  onNavigate?: () => void;
  dense?: boolean;
  numbered?: boolean;
}) {
  return (
    <ul className="flex flex-col">
      {routes.map((r) => (
        <NavRow
          key={r.id}
          route={r}
          number={numbering.get(r.id) ?? 0}
          active={r.id === activeId}
          query={query}
          todoCount={todoCount}
          onNavigate={onNavigate}
          dense={dense}
          numbered={numbered}
        />
      ))}
    </ul>
  );
}

export function numberRoutes(routes: ShellRoute[]): Map<RouteId, number> {
  return new Map(routes.map((r, i) => [r.id, i + 1]));
}

/**
 * Stänger en utfälld meny med Esc (fokus tillbaka till knappen) och vid
 * pekartryck utanför.
 */
function useDismiss(
  open: boolean,
  setOpen: (open: boolean) => void,
  rootRef: RefObject<HTMLElement | null>,
  buttonRef: RefObject<HTMLElement | null>,
) {
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setOpen(false);
      buttonRef.current?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, setOpen, rootRef, buttonRef]);
}

/** Organisationsväxlare. Med en organisation: bara namnet, ingen meny. */
export function OrgSwitcher({
  organizations = [],
  activeOrganizationId,
  onOrganizationChange,
}: Pick<ShellNavProps, "organizations" | "activeOrganizationId" | "onOrganizationChange">) {
  const [open, setOpen] = useState(false);
  const listId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useDismiss(open, setOpen, rootRef, buttonRef);
  const active = organizations.find((o) => o.id === activeOrganizationId) ?? organizations[0];
  if (!active) return null;
  const many = organizations.length > 1;

  const head = (
    <>
      <span className="min-w-0 flex-1">
        <span className="flex items-baseline justify-between gap-3">
          <span className="label text-subtle">Organisation</span>
          {active.detail ? (
            <span className="meta tnum truncate text-subtle">{active.detail}</span>
          ) : null}
        </span>
        <span className="mt-1 block truncate text-base text-fg">{active.name}</span>
      </span>
    </>
  );

  if (!many) return <div className="flex items-end gap-3 px-4 py-3">{head}</div>;

  return (
    <div ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-end gap-3 px-4 py-3 text-left focus-visible:-outline-offset-2"
      >
        {head}
        <Icon
          name="chevronDown"
          size={12}
          className={cn(
            "mb-1 shrink-0 text-subtle transition-transform group-hover:text-fg",
            open && "rotate-180",
          )}
        />
        <span className="sr-only">, byt organisation</span>
      </button>
      {open ? (
        <ul id={listId} className="pb-2" aria-label="Organisationer">
          {organizations.map((o) => {
            const current = o.id === active.id;
            return (
              <li key={o.id}>
                <button
                  type="button"
                  aria-current={current ? "true" : undefined}
                  onClick={() => {
                    setOpen(false);
                    if (!current) onOrganizationChange?.(o.id);
                  }}
                  className={cn(
                    "flex h-8 w-full items-center gap-3 px-4 text-left text-base transition-colors focus-visible:-outline-offset-2",
                    current ? "text-fg" : "text-muted hover:text-fg",
                  )}
                >
                  <span className="flex w-4 shrink-0 justify-center">
                    {current ? <Icon name="check" size={12} /> : null}
                  </span>
                  <span className="flex-1 truncate">{o.name}</span>
                  {o.detail ? <span className="meta tnum text-subtle">{o.detail}</span> : null}
                </button>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}

function toDate(v: Date | string): Date | null {
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Statusrad: "Synkad 1 nov. 21:23". Normalläget är bara text. Inaktuell och
 * misslyckad synk bär glyf + text (aldrig bara färg) och blir en länk till
 * Datakällor när `href` ges, så att det som kräver åtgärd har en väg dit.
 */
export function SyncStatus({
  syncedAt,
  syncState = "ok",
  timeZone,
  href,
  className,
}: Pick<ShellNavProps, "syncedAt" | "syncState" | "timeZone"> & {
  href?: string;
  className?: string;
}) {
  if (!syncedAt && syncState === "ok") return null;
  const d = syncedAt ? toDate(syncedAt) : null;
  const when = d
    ? formatDateTime(wallClockIn(d, timeZone), { now: wallClockIn(new Date(), timeZone) })
    : null;
  const text =
    syncState === "failed"
      ? `Synk misslyckades${when ? ` · senast ${when}` : ""}`
      : syncState === "stale"
        ? `Inaktuell · synkad ${when ?? "–"}`
        : `Synkad ${when ?? "–"}`;
  const problem = syncState !== "ok";
  const body = (
    <>
      <span className="inline-flex w-4 shrink-0 justify-center">
        {problem ? (
          <StatusGlyph status={syncState === "failed" ? "critical" : "warning"} size={6} />
        ) : null}
      </span>
      <span className="min-w-0 flex-1">
        {d ? <time dateTime={d.toISOString()}>{text}</time> : text}
      </span>
      {problem && href ? <Icon name="chevronRight" size={12} className="shrink-0" /> : null}
    </>
  );
  const tone =
    syncState === "failed" ? "text-signal-fg" : syncState === "stale" ? "text-fg" : "text-subtle";
  if (problem && href) {
    return (
      <Link
        href={href}
        className={cn(
          "meta tnum flex items-center gap-2 transition-colors focus-visible:-outline-offset-2",
          tone,
          "hover:underline hover:underline-offset-4",
          className,
        )}
      >
        {body}
        <span className="sr-only">, öppna Datakällor</span>
      </Link>
    );
  }
  return <p className={cn("meta tnum flex items-center gap-2", tone, className)}>{body}</p>;
}

/** Länken från synkraden, om rollen får se Datakällor. */
export function syncHref(role: Role): string | undefined {
  return routesForRole(role).find((r) => r.id === "datakallor")?.href;
}

/** Användarmeny: namn och roll, fäller ut e-post och Logga ut uppåt. */
export function UserMenu({
  user,
  role = "owner",
  onSignOut,
  signOutHref = "/logga-ut",
}: Pick<ShellNavProps, "user" | "role" | "onSignOut" | "signOutHref">) {
  const [open, setOpen] = useState(false);
  const panelId = useId();
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  useDismiss(open, setOpen, rootRef, buttonRef);
  if (!user) return null;
  const rowCls =
    "flex h-8 w-full items-center gap-3 px-4 text-left text-base text-muted transition-colors hover:text-fg focus-visible:-outline-offset-2";
  return (
    <div ref={rootRef}>
      {open ? (
        <div id={panelId} className="border-b border-line py-2">
          {user.email ? (
            <p className="meta truncate px-4 pb-2 pl-11 text-subtle">{user.email}</p>
          ) : null}
          {onSignOut ? (
            <button type="button" onClick={onSignOut} className={rowCls}>
              <Icon name="logout" className="w-4 shrink-0" />
              Logga ut
            </button>
          ) : (
            <a href={signOutHref} className={rowCls}>
              <Icon name="logout" className="w-4 shrink-0" />
              Logga ut
            </a>
          )}
        </div>
      ) : null}
      <button
        ref={buttonRef}
        type="button"
        aria-expanded={open}
        aria-controls={panelId}
        onClick={() => setOpen((o) => !o)}
        className="group flex w-full items-center gap-3 px-4 py-3 text-left focus-visible:-outline-offset-2"
      >
        <span className="min-w-0 flex-1">
          <span className="block truncate text-base text-fg">{user.name}</span>
          <span className="label mt-0.5 block text-subtle">{roleLabel[role]}</span>
        </span>
        <Icon
          name="chevronDown"
          size={12}
          className={cn(
            "shrink-0 text-subtle transition-transform group-hover:text-fg",
            !open && "rotate-180",
          )}
        />
        <span className="sr-only">, kontomeny</span>
      </button>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Sidomeny                                                            */
/* ------------------------------------------------------------------ */

export type SidebarProps = ShellNavProps & { className?: string };

/** Fast sidomeny från lg och uppåt. Mobil: se MobileNav i ./mobile-nav. */
export function Sidebar({ className, ...props }: SidebarProps) {
  const pathname = usePathname();
  const role = props.role ?? "owner";
  const routes = routesForRole(role);
  const numbering = numberRoutes(routes);
  const activeId = activeRouteId(props.activeHref ?? pathname);
  const main = routes.filter((r) => r.section === "main");
  const system = routes.filter((r) => r.section === "system");

  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-dvh w-[248px] shrink-0 flex-col border-r border-line bg-bg lg:flex",
        className,
      )}
    >
      <div className="flex h-14 shrink-0 items-center border-b border-line px-4">
        <Link href={homeHref(role)} className="rounded-xs" aria-label="Binderlab, till startsidan">
          <Logo />
        </Link>
      </div>

      {props.organizations?.length ? (
        <div className="shrink-0 border-b border-line">
          <OrgSwitcher
            organizations={props.organizations}
            activeOrganizationId={props.activeOrganizationId}
            onOrganizationChange={props.onOrganizationChange}
          />
        </div>
      ) : null}

      <WithCarriedQuery>
        {(query) => (
          <>
            <nav aria-label="Huvudmeny" className="min-h-0 flex-1 overflow-y-auto py-4">
              <NavList
                routes={main}
                numbering={numbering}
                activeId={activeId}
                query={query}
                todoCount={props.todoCount}
                dense
              />
            </nav>
            {system.length ? (
              <nav aria-label="System" className="shrink-0 border-t border-line py-2">
                <NavList
                  routes={system}
                  numbering={numbering}
                  activeId={activeId}
                  query={query}
                  dense
                />
              </nav>
            ) : null}
          </>
        )}
      </WithCarriedQuery>

      <div className="shrink-0 border-t border-line">
        <SyncStatus
          syncedAt={props.syncedAt}
          syncState={props.syncState}
          timeZone={props.timeZone}
          href={syncHref(role)}
          className="px-4 py-3"
        />
        {props.user ? (
          <div className="border-t border-line">
            <UserMenu
              user={props.user}
              role={role}
              onSignOut={props.onSignOut}
              signOutHref={props.signOutHref}
            />
          </div>
        ) : null}
      </div>
    </aside>
  );
}
