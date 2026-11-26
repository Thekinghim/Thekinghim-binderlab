"use client";

/**
 * AI-panelen: "Fråga AI" på varje inloggad sida. En sidopanel (mobil: ett ark nerifrån)
 * med samtalet, som ligger i skalet och därför finns kvar när man byter sida. Frågorna
 * går till samma route som sidan Assistent (POST /assistent/fraga: samma verktyg,
 * kontroll av talen, månadstak och roller), med sidans sammanhang (rutt, period, filter,
 * VMB, detaljsida) så att assistenten vet vad användaren tittar på.
 *
 * Monteras en gång i AppFrame. Knappen i toppraden, gnistorna vid nyckeltalen och
 * tipsraden (panel-context.tsx) öppnar den via useAssistantPanel.
 */

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import { assistantPanelState, type PanelState } from "@/app/(app)/assistent/panel-actions";
import { fabLayout, fabVisibleAfterScroll, showsRefillShortcut } from "@/components/shell/fab";
import type { Role } from "@/components/shell/nav";
import { cn } from "@/lib/cn";
import { lazyPart } from "@/lib/lazy-part";
import {
  canUseAssistant,
  pageContextFromUrl,
  pageInfo,
  suggestionsFor,
} from "@/server/assistant/page-context";
import type { PageTip, TipRoute } from "@/server/assistant/page-tips";
import { QUESTION_MAX_LENGTH } from "@/server/assistant/protocol";

import { PanelContext, Sparkle, type PanelApi } from "./panel-context";
import { fetchPageTips, whenIdleAfterInteraction } from "./page-tips-client";
import { useAssistantConversation } from "./use-assistant-conversation";

/**
 * Panelens innehåll laddas först när panelen öppnas första gången (det mesta av koden:
 * samtalet, underlaget, frågefältet). Sedan ligger det kvar, så att samtalet och stängningen
 * fungerar som förut.
 */
const assistantPanelBody = lazyPart(() =>
  import("./assistant-panel-body").then((m) => m.AssistantPanelBody),
);
const AssistantPanelBody = assistantPanelBody.Component;

export { AiPageLine, AskAiButton, AskAiSparkle, PageTip, useAssistantPanel } from "./panel-context";

const DISMISSED_KEY = "bl-ai-tips-dolda";

function readDismissed(): string[] {
  try {
    const raw = window.localStorage.getItem(DISMISSED_KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function writeDismissed(ids: string[]): void {
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify(ids.slice(-50)));
  } catch {
    // Privat läge: tipset döljs bara tills sidan laddas om.
  }
}

export function AssistantPanelProvider({
  role,
  stores = [],
  children,
}: {
  role: Role;
  stores?: ReadonlyArray<{ id: string; name: string }>;
  children: ReactNode;
}) {
  const allowed = canUseAssistant(role);
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const search = searchParams.toString();
  const page = useMemo(
    () => pageContextFromUrl(pathname, search ? `?${search}` : ""),
    [pathname, search],
  );
  const [isOpen, setIsOpen] = useState(false);
  // Innehållet monteras vid första öppningen och ligger sedan kvar.
  const [used, setUsed] = useState(false);
  if (isOpen && !used) setUsed(true);
  const [input, setInput] = useState("");
  const [state, setState] = useState<PanelState | null>(null);
  const [tips, setTips] = useState<Partial<Record<TipRoute, PageTip>>>({});
  const [dismissed, setDismissed] = useState<string[]>([]);
  const conversation = useAssistantConversation();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // En fråga som ska skickas direkt (tips), även när panelen redan är öppen.
  const pendingSend = useRef<string | null>(null);
  const [sendTick, setSendTick] = useState(0);

  // Rådgivarens förslag (ägare och admin) en gång per inloggning i skalet. Hämtas med GET
  // (/assistent/tips) först efter första trycket och när webbläsaren har tid över: en server
  // action här köade bakom sig sidans egna anrop vid start.
  useEffect(() => {
    if (role !== "owner" && role !== "admin") return;
    const ac = new AbortController();
    const stop = whenIdleAfterInteraction(() => {
      void fetchPageTips(ac.signal).then((t) => {
        if (ac.signal.aborted) return;
        setDismissed(readDismissed());
        setTips(t);
      });
    });
    return () => {
      ac.abort();
      stop();
    };
  }, [role]);

  // Läget (nyckel, budget) läses när panelen öppnas.
  useEffect(() => {
    if (!isOpen || !allowed) return;
    let live = true;
    assistantPanelState()
      .then((s) => live && setState(s))
      .catch(
        () =>
          live &&
          setState({
            status: "off",
            message: "AI svarar inte just nu.",
            local: false,
            budgetLeft: null,
          }),
      );
    requestAnimationFrame(() => inputRef.current?.focus());
    return () => {
      live = false;
    };
  }, [isOpen, allowed]);

  const detailName =
    page.detail?.kind === "butik"
      ? (stores.find((s) => s.id === page.detail!.ref)?.name ?? null)
      : null;
  const info = pageInfo(page.route);

  const send = useCallback(
    (text: string) => {
      const q = text.trim();
      if (!q || conversation.busy) return;
      setInput("");
      void conversation.ask(q, page, info.name);
    },
    [conversation, page, info.name],
  );

  // En fråga som skickas direkt när panelen öppnas (chips, tips) väntar tills läget är känt.
  useEffect(() => {
    if (!isOpen || !pendingSend.current || !state || conversation.busy) return;
    const q = pendingSend.current;
    pendingSend.current = null;
    if (state.status === "ready") send(q);
    else setInput(q);
  }, [isOpen, state, send, sendTick, conversation.busy]);

  const api = useMemo<PanelApi>(
    () => ({
      isOpen,
      open(prefill, options) {
        if (prefill) {
          if (options?.send) {
            pendingSend.current = prefill;
            setSendTick((n) => n + 1);
          } else setInput(prefill.slice(0, QUESTION_MAX_LENGTH));
        }
        setIsOpen(true);
        requestAnimationFrame(() => inputRef.current?.focus());
      },
      close: () => setIsOpen(false),
      tipFor: (route) => {
        const tip = tips[route];
        return tip && !dismissed.includes(tip.id) ? tip : null;
      },
      dismissTip(id) {
        setDismissed((all) => {
          const next = [...all, id];
          writeDismissed(next);
          return next;
        });
      },
    }),
    [isOpen, tips, dismissed],
  );

  // ⌘J / Ctrl J öppnar och stänger panelen.
  useEffect(() => {
    if (!allowed) return;
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const mac = /Mac|iPhone|iPad/.test(navigator.platform);
      const primary = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (primary && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "j") {
        e.preventDefault();
        setIsOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [allowed]);

  if (!allowed) return <>{children}</>;

  return (
    <PanelContext.Provider value={api}>
      {children}
      <FloatingAskButton
        role={role}
        pathname={pathname}
        hidden={isOpen}
        onOpen={() => api.open()}
      />
      {/* Mobil: mörk bakgrund bakom arket; ett tryck stänger. */}
      <div
        aria-hidden
        onClick={() => setIsOpen(false)}
        className={cn(
          "fixed inset-0 bottom-[calc(0px-var(--v2-vp-shift,0px))] z-40 bg-[var(--bl-overlay)] transition-opacity duration-300 sm:hidden",
          isOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      {used ? (
        <AssistantPanelBody
          open={isOpen}
          onClose={() => setIsOpen(false)}
          page={page}
          pageName={info.name}
          chips={suggestionsFor(page, role, detailName)}
          state={state}
          input={input}
          setInput={setInput}
          inputRef={inputRef}
          send={send}
          conversation={conversation}
        />
      ) : null}
    </PanelContext.Provider>
  );
}

/**
 * Mobil: liten flytande knapp ovanför bottenraden (täcker den aldrig). Skalet ger sidan luft
 * under sig (@/components/shell/fab), så att sista raden går att rulla fram ovanför knappen,
 * och knappen glider undan medan man rullar nedåt och läser. Påfyllarens "Fyll på" tar
 * platsen där den visas (AI finns i toppraden).
 */
function FloatingAskButton({
  role,
  pathname,
  hidden,
  onOpen,
}: {
  role: Role;
  pathname: string;
  hidden: boolean;
  onOpen: () => void;
}) {
  const layout = fabLayout({ refill: showsRefillShortcut(role, pathname), assistant: true });
  const [visible, setVisible] = useState(true);
  const lastY = useRef(0);

  useEffect(() => {
    if (layout.assistantBottom === null) return;
    lastY.current = window.scrollY;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const y = window.scrollY;
        const atEnd = window.innerHeight + y >= document.documentElement.scrollHeight - 4;
        // Förra läget läses nu: uppdateringen kan köras först vid nästa rendering.
        const prev = lastY.current;
        lastY.current = y;
        setVisible((v) => fabVisibleAfterScroll(v, prev, y, atEnd));
      });
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener("scroll", onScroll);
    };
  }, [layout.assistantBottom]);

  // Ny sida: knappen syns igen.
  const [lastPath, setLastPath] = useState(pathname);
  if (lastPath !== pathname) {
    setLastPath(pathname);
    setVisible(true);
  }

  if (layout.assistantBottom === null) return null;
  const shown = visible && !hidden;
  return (
    <button
      type="button"
      onClick={onOpen}
      aria-label="Fråga AI"
      data-testid="ai-fab"
      tabIndex={shown ? undefined : -1}
      style={{
        bottom: `calc(${layout.assistantBottom}px + env(safe-area-inset-bottom) - var(--v2-vp-shift, 0px))`,
      }}
      className={cn(
        "shadow-lg fixed right-4 z-30 flex size-11 items-center justify-center rounded-full border border-line-strong bg-inverse text-on-inverse transition-[transform,opacity] duration-300 ease-instrument active:scale-95 motion-reduce:transition-none max-md:hidden lg:hidden",
        shown ? "scale-100 opacity-100" : "pointer-events-none translate-y-4 scale-75 opacity-0",
      )}
    >
      <Sparkle size={18} className="animate-[bl-shimmer_2.4s_ease-in-out_infinite]" />
    </button>
  );
}
