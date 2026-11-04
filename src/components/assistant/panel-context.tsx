"use client";

/**
 * Det lätta i AI-panelen: sammanhanget (useAssistantPanel), gnistan och knapparna som
 * öppnar panelen ("Fråga AI" i toppraden, "Förklara …" under rubriken, tipsraden). Utan
 * serverkod, så att toppraden och sidorna inte drar in panelens laddning. Själva panelen
 * ligger i assistant-panel.tsx.
 */

import Link from "next/link";
import { createContext, useContext } from "react";

import { IconButton } from "@/components/ui/button";
import { MOBILE_MENU_ITEM } from "@/components/ui/more-menu";
import { cn } from "@/lib/cn";
import { explainQuestion } from "@/server/assistant/page-context";
import {
  tipQuestion,
  type PageTip as PageTipData,
  type TipRoute,
} from "@/server/assistant/page-tips";

export interface PanelApi {
  /** Öppnar panelen. `prefill` fylls i; med `send` skickas frågan direkt. */
  open(prefill?: string, options?: { send?: boolean }): void;
  close(): void;
  readonly isOpen: boolean;
  /** Rådgivarens förslag för sidan, eller null. */
  tipFor(route: TipRoute): PageTipData | null;
  dismissTip(id: string): void;
}

export const PanelContext = createContext<PanelApi | null>(null);

/** Panelens API, eller null utanför skalet (eller för en roll utan assistent). */
export function useAssistantPanel(): PanelApi | null {
  return useContext(PanelContext);
}

/** Fyrspetsig gnista (egen ritning, samma linjebredd som ikonerna). */
export function Sparkle({ className, size = 14 }: { className?: string; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.25}
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <path d="M7 2.5l1.2 3.8L12 7.5 8.2 8.7 7 12.5 5.8 8.7 2 7.5l3.8-1.2z" />
      <path d="M12.5 1.5v3M11 3h3" strokeLinecap="square" />
    </svg>
  );
}

/** Knappen "Fråga AI" i toppraden. Utan panel (roll utan assistent): länken till sidan. */
export function AskAiButton({ fallbackHref }: { fallbackHref?: string }) {
  const panel = useAssistantPanel();
  if (!panel) {
    return fallbackHref ? (
      <Link
        href={fallbackHref}
        prefetch={false}
        aria-label="Assistent"
        className="group flex h-8 items-center gap-2 rounded-sm px-2 text-subtle transition-colors hover:text-fg"
      >
        <Sparkle />
        <span className="hidden text-sm sm:inline">Assistent</span>
      </Link>
    ) : null;
  }
  return (
    <button
      type="button"
      onClick={() => (panel.isOpen ? panel.close() : panel.open())}
      aria-label="Fråga AI"
      aria-expanded={panel.isOpen}
      aria-keyshortcuts="Meta+J Control+J"
      data-testid="ai-open"
      className={cn(
        // Under md: tryckytan växer till 44 px utan att knappen ser större ut.
        "group relative flex h-8 items-center gap-1.5 rounded-sm border px-2 text-sm transition-colors max-md:before:absolute max-md:before:-inset-1.5 max-md:before:content-['']",
        panel.isOpen
          ? "border-inverse bg-inverse text-on-inverse"
          : "border-line-strong text-fg hover:border-line-control hover:bg-hover",
      )}
    >
      {/* Under md finns ingen flytande AI-knapp: gnistan här skimrar i stället. */}
      <Sparkle className="transition-transform duration-300 group-hover:scale-110 group-hover:rotate-12 max-md:animate-[bl-shimmer_2.4s_ease-in-out_infinite]" />
      <span className="hidden sm:inline">Fråga AI</span>
    </button>
  );
}

/**
 * Liten gnista vid ett nyckeltal: öppnar panelen med "Förklara <nyckeltal>" ifyllt.
 * Syns inte utan panel (roll utan assistent).
 */
export function AskAiSparkle({ metric, className }: { metric: string; className?: string }) {
  const panel = useAssistantPanel();
  if (!panel) return null;
  const q = explainQuestion(metric);
  return (
    <button
      type="button"
      onClick={() => panel.open(q)}
      aria-label={`Fråga AI: ${q}`}
      title={q}
      data-testid="ai-sparkle"
      className={cn(
        "inline-flex size-6 shrink-0 items-center justify-center rounded-full align-middle text-subtle transition-[color,background-color,transform] duration-fast hover:scale-110 hover:bg-hover hover:text-fg",
        className,
      )}
    >
      <Sparkle size={13} />
    </button>
  );
}

/** En rad med rådgivarens förslag för sidan: kan döljas, och öppnar panelen om det. */
export function PageTip({ route, className }: { route: TipRoute; className?: string }) {
  const panel = useAssistantPanel();
  const tip = panel?.tipFor(route) ?? null;
  if (!panel || !tip) return null;
  return (
    <div
      data-testid="ai-tip"
      className={cn(
        "flex min-w-0 animate-[bl-rise_0.4s_ease-out] items-center gap-2 rounded-sm border border-line px-3 py-2 text-sm",
        className,
      )}
    >
      <Sparkle className="shrink-0 text-muted" />
      <button
        type="button"
        onClick={() => panel.open(tipQuestion(tip), { send: true })}
        className="min-w-0 flex-1 truncate text-left text-fg hover:underline"
        title={tip.why}
      >
        <span className="text-muted">Tips:</span> {tip.title}
      </button>
      <IconButton
        icon="close"
        label="Dölj tipset"
        size="sm"
        onClick={() => panel.dismissTip(tip.id)}
      />
    </div>
  );
}

/**
 * Raden under sidans rubrik: gnistan "Förklara <nyckeltal>" och rådgivarens tips för
 * sidan. Ingenting utan panel (roll utan assistent).
 */
export function AiPageLine({
  metric,
  route,
  className,
  menuItem = false,
}: {
  metric: string;
  route: TipRoute;
  className?: string;
  /** Står i en MobileMore-meny: under md en hel rad på 44 px (från md oförändrad). */
  menuItem?: boolean;
}) {
  const panel = useAssistantPanel();
  if (!panel) return null;
  const q = explainQuestion(metric);
  return (
    <div
      className={cn(
        "flex min-w-0 flex-wrap items-center gap-2",
        menuItem && "max-md:flex-col max-md:items-stretch max-md:gap-1",
        className,
      )}
    >
      <button
        type="button"
        onClick={() => panel.open(q)}
        title={q}
        data-testid="ai-sparkle"
        className={cn(
          "group inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full border border-line px-2.5 text-sm text-muted transition-[color,background-color,border-color] duration-fast hover:border-line-control hover:bg-hover hover:text-fg",
          menuItem && cn(MOBILE_MENU_ITEM, "max-md:gap-2 max-md:text-base max-md:text-fg"),
        )}
      >
        <Sparkle size={13} className="transition-transform duration-300 group-hover:rotate-12" />
        {q}
      </button>
      <PageTip route={route} className="min-w-[min(100%,16rem)] flex-1" />
    </div>
  );
}
