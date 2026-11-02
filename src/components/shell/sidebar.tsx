"use client";

import Link from "next/link";
import { useEffect, useRef } from "react";
import { cn } from "@/lib/cn";
import { Icon, type IconName } from "@/components/ui/icon";
import { IconButton } from "@/components/ui/button";
import { StatusGlyph } from "@/components/ui/status-tag";
import { Logo } from "./logo";

export type NavItem = {
  href: string;
  label: string;
  icon: IconName;
  /** Antal som kräver åtgärd, visas som signalmarkör + tal */
  alerts?: number;
};

export type NavGroup = { label: string; items: NavItem[] };

export const defaultNav: NavGroup[] = [
  {
    label: "Drift",
    items: [
      { href: "/", label: "Översikt", icon: "overview" },
      { href: "/forsaljning", label: "Försäljning", icon: "sales" },
      { href: "/automater", label: "Automater", icon: "machine", alerts: 2 },
      { href: "/lager", label: "Lager", icon: "inventory", alerts: 5 },
      { href: "/marginal", label: "Marginal", icon: "margin" },
    ],
  },
  {
    label: "System",
    items: [
      { href: "/design", label: "Designsystem", icon: "design" },
      { href: "/installningar", label: "Inställningar", icon: "settings" },
    ],
  },
];

type SidebarProps = {
  activeHref: string;
  nav?: NavGroup[];
  className?: string;
  onNavigate?: () => void;
};

function SidebarContent({ activeHref, nav = defaultNav, onNavigate }: SidebarProps) {
  // Löpnummer över alla grupper: 01, 02 …
  const offsets = nav.map((_, gi) => nav.slice(0, gi).reduce((acc, g) => acc + g.items.length, 0));
  return (
    <div className="flex h-full flex-col">
      <div className="flex h-14 items-center border-b border-line px-4">
        <Link href="/" className="rounded-xs" onClick={onNavigate}>
          <Logo />
        </Link>
      </div>

      <div className="border-b border-line px-4 py-3">
        <p className="label text-subtle">Operatör</p>
        <p className="mt-0.5 flex items-center justify-between text-base">
          <span className="truncate">Egen verksamhet</span>
          <span className="label tnum text-subtle">14 st</span>
        </p>
      </div>

      <nav aria-label="Huvudmeny" className="flex-1 overflow-y-auto px-2 py-4">
        {nav.map((group, gi) => (
          <div key={group.label} className="mb-6 last:mb-0">
            <p className="label px-2 pb-2 text-subtle">{group.label}</p>
            <ul className="flex flex-col gap-px">
              {group.items.map((item, ii) => {
                const n = (offsets[gi] ?? 0) + ii + 1;
                const active = item.href === activeHref;
                return (
                  <li key={item.href}>
                    <Link
                      href={item.href}
                      onClick={onNavigate}
                      aria-current={active ? "page" : undefined}
                      className={cn(
                        "group flex h-8 items-center gap-2.5 rounded-sm px-2 text-base transition-colors duration-[120ms]",
                        active ? "bg-hover text-fg" : "text-muted hover:bg-hover/60 hover:text-fg",
                      )}
                    >
                      <span
                        className={cn(
                          "label tnum w-4 text-[10px]",
                          active ? "text-fg" : "text-faint",
                        )}
                      >
                        {String(n).padStart(2, "0")}
                      </span>
                      <Icon
                        name={item.icon}
                        className={active ? "text-fg" : "text-subtle group-hover:text-fg"}
                      />
                      <span className="flex-1 truncate">{item.label}</span>
                      {item.alerts ? (
                        <span className="label tnum flex items-center gap-1.5 text-signal-fg">
                          <span aria-hidden className="size-1.5 bg-signal" />
                          {item.alerts}
                          <span className="sr-only"> kräver åtgärd</span>
                        </span>
                      ) : null}
                    </Link>
                  </li>
                );
              })}
            </ul>
          </div>
        ))}
      </nav>

      <div className="border-t border-line px-4 py-3">
        <div className="flex items-center justify-between">
          <span className="label text-subtle">Flotta</span>
          <span className="label tnum text-muted">12 / 14</span>
        </div>
        <div className="mt-2 flex gap-0.5" aria-hidden>
          {Array.from({ length: 14 }, (_, i) => (
            <span
              key={i}
              className={cn(
                "h-3 flex-1",
                i === 9
                  ? "bg-signal"
                  : i === 13
                    ? "border border-dashed border-line-control"
                    : "bg-data-3",
              )}
            />
          ))}
        </div>
        <p className="mt-2 flex items-center gap-3 text-xs text-subtle">
          <span className="flex items-center gap-1.5">
            <StatusGlyph status="ok" /> 12 i drift
          </span>
          <span className="flex items-center gap-1.5">
            <StatusGlyph status="critical" /> 1 kritisk
          </span>
          <span className="flex items-center gap-1.5">
            <StatusGlyph status="offline" /> 1 offline
          </span>
        </p>
      </div>
    </div>
  );
}

/** Fast sidomeny från lg och uppåt. */
export function Sidebar(props: SidebarProps) {
  return (
    <aside
      className={cn(
        "sticky top-0 hidden h-dvh w-[248px] shrink-0 border-r border-line bg-bg lg:block",
        props.className,
      )}
    >
      <SidebarContent {...props} />
    </aside>
  );
}

/** Mobil: samma meny i en låda från vänster. */
export function MobileSidebar({
  open,
  onClose,
  ...props
}: SidebarProps & { open: boolean; onClose: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog
      ref={ref}
      aria-label="Meny"
      onClose={onClose}
      onCancel={(e) => {
        e.preventDefault();
        onClose();
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
      className="m-0 h-dvh max-h-none w-[280px] max-w-[85vw] border-0 border-r border-line bg-bg p-0 text-fg"
    >
      <div
        className="relative h-full"
        style={{ animation: "bl-fade var(--bl-dur-slow) var(--bl-ease)" }}
      >
        <div className="absolute top-3.5 right-3 z-10">
          <IconButton icon="close" label="Stäng meny" size="sm" onClick={onClose} />
        </div>
        <SidebarContent {...props} onNavigate={onClose} />
      </div>
    </dialog>
  );
}
