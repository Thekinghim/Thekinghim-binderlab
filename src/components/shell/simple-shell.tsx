"use client";

/**
 * Skalet för Enkel vy: fyra stora flikar nedtill (Fyll på, Försäljning, Lager, Mystery) och en
 * liten meny uppe till höger med bara språk, veckosammanfattningen, Uppdatera appen och Logga ut. Ingen sidomeny, ingen sökning,
 * ingen AI, ingen knapp för "Fyll på" ovanpå sidan. Reglerna (vilka sökvägar, vilka flikar)
 * finns i ./simple-view och gäller också på servern.
 */

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { createContext, useContext, useState, useTransition, type ReactNode } from "react";

import { Sheet } from "@/app/(app)/lager/_components/sheet";
import { Wordmark } from "@/components/brand/wordmark";
import { useAppRefresh } from "@/components/pwa/app-refresh-button";
import { Icon } from "@/components/ui/icon";
import { WeeklySwitch } from "@/components/weekly/weekly-switch";
import { useToast } from "@/components/ui/toast";
import type { MemberRole } from "@/db/schema";
import { useLocale, useT } from "@/i18n/client";
import { LOCALES, LOCALE_NAME, type Locale } from "@/i18n/locale";
import { cn } from "@/lib/cn";
import { logout } from "@/server/actions/auth";
import { setMyLocale } from "@/server/actions/locale";

import { clearAllRecent } from "./command-recent";
import { simpleHomeFor, simpleTabActive, simpleTabsFor, type SimpleTabId } from "./simple-view";

/** Höjden på bottenraden, utan säkerhetsmarginal. */
export const SIMPLE_NAV_HEIGHT = 64;

interface SimpleShellValue {
  readonly email: string;
  readonly role: MemberRole;
}

const SimpleShellContext = createContext<SimpleShellValue | null>(null);

/** Sant inne i den enkla vyns skal (t.ex. Fyll på visar då menyknappen i stället för "Binderlab"). */
export function useSimpleShell(): SimpleShellValue | null {
  return useContext(SimpleShellContext);
}

/** "Svenska / English": två stora knappar. Sparar i profilen och kakan, läser om sidan. */
export function LanguageChoice({ className }: { className?: string }) {
  const t = useT();
  const locale = useLocale();
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [chosen, setChosen] = useState<Locale>(locale);
  // Ny sida med ett annat språk (t.ex. efter router.refresh): följ den.
  const [seen, setSeen] = useState(locale);
  if (seen !== locale) {
    setSeen(locale);
    setChosen(locale);
  }
  return (
    <div
      role="radiogroup"
      aria-label={t.lang.title}
      className={cn("grid grid-cols-2 gap-2", className)}
    >
      {LOCALES.map((l) => {
        const on = chosen === l;
        return (
          <button
            key={l}
            type="button"
            role="radio"
            aria-checked={on}
            lang={l}
            disabled={pending}
            onClick={() => {
              if (l === chosen) return;
              setChosen(l);
              start(async () => {
                const res = await setMyLocale(l).catch(() => ({
                  ok: false as const,
                  error: t.common.offlineRetry,
                }));
                if (!res.ok) {
                  setChosen(locale);
                  toast({
                    title: t.lang.failed,
                    description: t.serverError(res.error ?? ""),
                    tone: "critical",
                  });
                  return;
                }
                router.refresh();
              });
            }}
            className={cn(
              "min-h-12 rounded-md border px-4 text-lg font-medium transition-colors",
              on
                ? "border-inverse bg-inverse text-on-inverse"
                : "border-line-strong bg-surface text-fg active:bg-hover",
            )}
          >
            {LOCALE_NAME[l]}
          </button>
        );
      })}
    </div>
  );
}

/** "Update app" i menyn: hämtar senaste versionen och laddar om (som Mer i hela appen). */
function UpdateAppButton() {
  const t = useT().appUpdate;
  const { busy, error, run } = useAppRefresh();
  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        disabled={busy}
        onClick={() => void run()}
        className="flex min-h-12 w-full items-center justify-center gap-2 rounded-md border border-line-strong bg-surface text-lg font-medium text-fg active:bg-hover disabled:text-disabled"
      >
        <Icon name="refresh" size={18} />
        {busy ? t.updating : t.refreshApp}
      </button>
      <p role={error ? "alert" : undefined} className="meta text-center text-subtle">
        {error ?? t.refreshHint}
      </p>
    </div>
  );
}

/** Menyknappen (⋯) med språk, Uppdatera appen och Logga ut. */
export function SimpleMenuButton({ className }: { className?: string }) {
  const t = useT();
  const shell = useSimpleShell();
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [leaving, startLeave] = useTransition();
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        aria-haspopup="dialog"
        className={cn(
          "inline-flex min-h-11 min-w-11 items-center justify-center gap-2 rounded-full border border-line-strong bg-surface px-3 text-md font-medium text-fg active:bg-hover",
          className,
        )}
      >
        <Icon name="menu" size={18} />
        {t.simple.menu}
      </button>
      <Sheet
        open={open}
        onClose={() => setOpen(false)}
        title={t.simple.menuTitle}
        closeLabel={t.common.close}
      >
        <div className="flex flex-col gap-6 px-5 pb-5">
          <section className="flex flex-col gap-2" aria-label={t.lang.title}>
            <p className="label text-subtle">{t.lang.title}</p>
            <LanguageChoice />
          </section>
          {shell && (shell.role === "owner" || shell.role === "admin") ? (
            <section
              className="flex flex-col gap-2 border-t border-line pt-5"
              aria-label={t.week.switchTitle}
            >
              <WeeklySwitch />
            </section>
          ) : null}
          <section className="flex flex-col gap-2 border-t border-line pt-5">
            <UpdateAppButton />
          </section>
          <section className="flex flex-col gap-2 border-t border-line pt-5">
            {shell ? (
              <p className="meta wrap-anywhere text-subtle">{t.simple.signedInAs(shell.email)}</p>
            ) : null}
            <button
              type="button"
              disabled={leaving}
              onClick={() =>
                startLeave(async () => {
                  clearAllRecent();
                  const res = await logout().catch(() => ({
                    ok: false as const,
                    error: t.common.offlineRetry,
                  }));
                  if (res.ok) router.replace("/logga-in");
                  else
                    toast({
                      title: t.common.logoutFailed,
                      description: t.serverError(res.error ?? ""),
                      tone: "critical",
                    });
                })
              }
              className="flex min-h-12 w-full items-center justify-center gap-2 rounded-md border border-line-strong bg-surface text-lg font-medium text-fg active:bg-hover disabled:text-disabled"
            >
              <Icon name="logout" size={18} />
              {leaving ? t.common.loggingOut : t.common.logout}
            </button>
          </section>
        </div>
      </Sheet>
    </>
  );
}

function tabLabel(t: ReturnType<typeof useT>, id: SimpleTabId): string {
  const labels: Record<SimpleTabId, string> = {
    refill: t.simple.tabRefill,
    sales: t.simple.tabSales,
    stock: t.simple.tabStock,
    mystery: t.simple.tabMystery,
  };
  return labels[id];
}

/** Fyll på för en automat har Klar nedtill: där visas ingen bottenrad. */
export function showsSimpleTabs(pathname: string): boolean {
  return !/^\/fyll-pa\/[0-9a-f-]{36}/i.test(pathname);
}

/** Bottenraden: fyra stora flikar (färre för påfyllaren och läsaren). */
export function SimpleTabs({ role }: { role: MemberRole }) {
  const t = useT();
  const pathname = usePathname() ?? "/";
  const tabs = simpleTabsFor(role);
  if (!showsSimpleTabs(pathname)) return null;
  return (
    <nav
      aria-label={t.simple.nav}
      className="fixed inset-x-0 bottom-0 z-40 border-t border-line bg-bg/95 pb-[env(safe-area-inset-bottom)] backdrop-blur"
    >
      <ul
        className="mx-auto grid max-w-[560px]"
        style={{ gridTemplateColumns: `repeat(${tabs.length}, minmax(0, 1fr))` }}
      >
        {tabs.map((tab) => {
          const on = simpleTabActive(tab, pathname);
          return (
            <li key={tab.id}>
              <Link
                href={tab.href}
                aria-current={on ? "page" : undefined}
                className={cn(
                  "flex flex-col items-center justify-center gap-1 text-md font-medium",
                  on ? "text-fg" : "text-subtle active:text-fg",
                )}
                style={{ minHeight: SIMPLE_NAV_HEIGHT }}
              >
                <span
                  className={cn(
                    "flex h-8 w-14 items-center justify-center rounded-full",
                    on && "bg-inverse text-on-inverse",
                  )}
                >
                  <Icon name={tab.icon} size={20} />
                </span>
                {tabLabel(t, tab.id)}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * Skalet: `topBar` ger en smal rad med ordmärket och menyknappen (appens sidor). Fyll på
 * har en egen rubrikrad och visar menyknappen där (useSimpleShell).
 */
export function SimpleShell({
  role,
  email,
  topBar = true,
  children,
}: {
  role: MemberRole;
  email: string;
  topBar?: boolean;
  children: ReactNode;
}) {
  // Allt utanför den enkla vyn skickas till startsidan av servern (@/server/data/core,
  // loadViewer), även vid navigering i webbläsaren: varje sida läser sin data där.
  const pathname = usePathname() ?? "/";
  return (
    <SimpleShellContext.Provider value={{ email, role }}>
      <div className="min-h-dvh bg-bg text-fg">
        {topBar ? (
          <header className="mx-auto flex w-full max-w-[1080px] items-center justify-between gap-3 px-4 pt-[calc(8px+env(safe-area-inset-top))] pb-2 md:px-8">
            <Link href={simpleHomeFor(role)} className="inline-flex min-h-11 items-center">
              <Wordmark size="sm" />
            </Link>
            <SimpleMenuButton />
          </header>
        ) : null}
        <main
          id="main"
          style={
            showsSimpleTabs(pathname)
              ? { paddingBottom: `calc(${SIMPLE_NAV_HEIGHT + 16}px + env(safe-area-inset-bottom))` }
              : undefined
          }
        >
          {children}
        </main>
        <SimpleTabs role={role} />
      </div>
    </SimpleShellContext.Provider>
  );
}
