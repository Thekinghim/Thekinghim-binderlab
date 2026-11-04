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

import Link from "next/link";
import { usePathname, useSearchParams } from "next/navigation";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { AnswerText, Evidence, VerificationLine } from "@/app/(app)/assistent/_components/evidence";
import {
  assistantPanelState,
  pageTips,
  type PanelState,
} from "@/app/(app)/assistent/panel-actions";
import { fabLayout, fabVisibleAfterScroll, showsRefillShortcut } from "@/components/shell/fab";
import type { Role } from "@/components/shell/nav";
import { Button, IconButton } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatInt } from "@/lib/format";
import {
  canUseAssistant,
  pageContextFromUrl,
  pageInfo,
  suggestionsFor,
  type PageContext,
} from "@/server/assistant/page-context";
import type { PageTip, TipRoute } from "@/server/assistant/page-tips";
import { QUESTION_MAX_LENGTH } from "@/server/assistant/protocol";

import { PanelContext, Sparkle, type PanelApi } from "./panel-context";
import { useAssistantConversation, type PanelTurn } from "./use-assistant-conversation";

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
  const [input, setInput] = useState("");
  const [state, setState] = useState<PanelState | null>(null);
  const [tips, setTips] = useState<Partial<Record<TipRoute, PageTip>>>({});
  const [dismissed, setDismissed] = useState<string[]>([]);
  const conversation = useAssistantConversation();
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // En fråga som ska skickas direkt (tips), även när panelen redan är öppen.
  const pendingSend = useRef<string | null>(null);
  const [sendTick, setSendTick] = useState(0);

  // Rådgivarens förslag (ägare och admin) en gång per inloggning i skalet.
  useEffect(() => {
    if (role !== "owner" && role !== "admin") return;
    let live = true;
    pageTips()
      .then((t) => {
        if (!live) return;
        setDismissed(readDismissed());
        setTips(t);
      })
      .catch(() => {});
    return () => {
      live = false;
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
          "fixed inset-0 z-40 bg-[var(--bl-overlay)] transition-opacity duration-300 sm:hidden",
          isOpen ? "opacity-100" : "pointer-events-none opacity-0",
        )}
      />
      <Panel
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
    </PanelContext.Provider>
  );
}

function Panel({
  open,
  onClose,
  page,
  pageName,
  chips,
  state,
  input,
  setInput,
  inputRef,
  send,
  conversation,
}: {
  open: boolean;
  onClose: () => void;
  page: PageContext;
  pageName: string;
  chips: string[];
  state: PanelState | null;
  input: string;
  setInput: (v: string) => void;
  inputRef: React.RefObject<HTMLTextAreaElement | null>;
  send: (q: string) => void;
  conversation: ReturnType<typeof useAssistantConversation>;
}) {
  const titleId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const { turns, busy, conversationId } = conversation;
  const last = turns[turns.length - 1];
  const ready = state?.status === "ready";
  const budgetLeft = last?.budgetLeft ?? state?.budgetLeft ?? null;

  // Rulla bara panelen (inte sidan bakom) till det senaste.
  useEffect(() => {
    const el = scrollRef.current;
    if (open && el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [open, turns.length, last?.draft, last?.state]);

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (ready) send(input);
    }
  };

  return (
    <aside
      role="dialog"
      aria-modal={false}
      aria-labelledby={titleId}
      aria-hidden={!open}
      inert={!open}
      data-testid="ai-panel"
      data-open={open ? "true" : "false"}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className={cn(
        "shadow-2xl fixed z-50 flex flex-col border-line bg-bg transition-[transform,opacity] duration-300 ease-instrument",
        // Mobil: ark nerifrån. Från sm: panel från höger.
        "rounded-t-lg inset-x-0 bottom-0 h-[88dvh] border-t sm:inset-x-auto sm:top-0 sm:right-0 sm:h-dvh sm:w-[420px] sm:rounded-none sm:border-t-0 sm:border-l",
        open
          ? "translate-y-0 opacity-100 sm:translate-x-0"
          : "pointer-events-none translate-y-full opacity-0 sm:translate-x-full sm:translate-y-0",
      )}
    >
      <header className="flex items-center gap-2 border-b border-line px-4 py-3">
        <span className="flex size-7 items-center justify-center rounded-full bg-inverse text-on-inverse">
          <Sparkle className={cn(busy && "animate-spin [animation-duration:2.4s]")} />
        </span>
        <div className="min-w-0 flex-1">
          <h2 id={titleId} className="text-base font-medium text-fg">
            Fråga AI
          </h2>
          <p className="meta truncate text-subtle">
            Ser {pageName}
            {page.vmb ? " · Med VMB" : ""}
          </p>
        </div>
        {turns.length > 0 ? (
          <Button variant="ghost" size="sm" onClick={conversation.reset} disabled={busy}>
            Nytt
          </Button>
        ) : null}
        <IconButton icon="close" label="Stäng (Esc)" size="sm" onClick={onClose} />
      </header>

      {state && state.status !== "ready" ? (
        <p className="border-b border-line bg-hover px-4 py-2 text-sm text-fg" data-testid="ai-off">
          {state.message}
        </p>
      ) : budgetLeft !== null && budgetLeft < 0.2 ? (
        <p className="meta border-b border-line px-4 py-2 text-subtle">
          {formatInt(Math.round(budgetLeft * 100))} % av månadens AI-budget kvar.
        </p>
      ) : null}

      <div
        ref={scrollRef}
        className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto overscroll-contain px-4 py-4"
      >
        {turns.length === 0 ? (
          <div className="flex animate-[bl-rise_0.4s_ease-out] flex-col gap-2 pt-2">
            <p className="text-md text-fg">Vad undrar du?</p>
            <p className="text-sm text-muted">Jag ser samma siffror som sidan.</p>
          </div>
        ) : (
          <ol className="flex flex-col gap-6" aria-label="Samtalet">
            {turns.map((t) => (
              <TurnView
                key={t.key}
                turn={t}
                onRetry={() => send(t.question)}
                canRetry={ready && !busy}
                onNavigate={onClose}
              />
            ))}
          </ol>
        )}
      </div>

      <form
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (ready) send(input);
        }}
        className="flex flex-col gap-2 border-t border-line px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))]"
      >
        {!busy && chips.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="Förslag">
            {chips.map((c, i) => (
              <li
                key={c}
                style={{ animationDelay: `${i * 60}ms` }}
                className="animate-[bl-rise_0.35s_ease-out_both]"
              >
                <button
                  type="button"
                  disabled={!ready}
                  onClick={() => send(c)}
                  className="rounded-full border border-line-strong px-2.5 py-1 text-left text-sm text-fg transition-[background-color,border-color,transform] duration-fast ease-instrument enabled:hover:border-line-control enabled:hover:bg-hover enabled:active:scale-[0.97] disabled:cursor-not-allowed disabled:border-dashed disabled:text-disabled"
                >
                  {c}
                </button>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="flex items-end gap-2">
          <label htmlFor={`${titleId}-q`} className="sr-only">
            Fråga
          </label>
          <textarea
            id={`${titleId}-q`}
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={1}
            maxLength={QUESTION_MAX_LENGTH}
            disabled={!ready}
            placeholder={ready ? "Skriv en fråga" : (state?.message ?? "Laddar…")}
            className="max-h-32 min-h-9 w-full min-w-0 resize-none rounded-sm border border-line-control bg-bg px-3 py-1.5 text-base text-fg placeholder:text-subtle disabled:cursor-not-allowed disabled:border-dashed disabled:border-line-strong disabled:text-disabled"
          />
          {busy ? (
            <Button type="button" variant="secondary" onClick={conversation.stop}>
              Stopp
            </Button>
          ) : (
            <Button type="submit" variant="primary" disabled={!ready || !input.trim()}>
              Fråga
            </Button>
          )}
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="meta hidden text-subtle sm:inline">Enter skickar · ⌘J</span>
          <Link
            href={conversationId ? `/assistent?samtal=${conversationId}` : "/assistent"}
            onClick={onClose}
            className="meta ml-auto text-muted underline decoration-line-control underline-offset-4 hover:text-fg"
          >
            Öppna i Assistent
          </Link>
        </div>
      </form>
    </aside>
  );
}

function TurnView({
  turn: t,
  onRetry,
  canRetry,
  onNavigate,
}: {
  turn: PanelTurn;
  onRetry: () => void;
  canRetry: boolean;
  onNavigate: () => void;
}) {
  const running = t.calls.find((c) => !c.done);
  const modelCalls = t.calls.filter((c) => !c.done?.prefetched);
  return (
    <li className="flex min-w-0 animate-[bl-rise_0.3s_ease-out] flex-col gap-3">
      <p className="ml-8 self-end rounded-md bg-hover px-3 py-2 text-base break-words text-fg">
        {t.question}
      </p>
      <div
        className="flex min-w-0 flex-col gap-2"
        aria-busy={t.state === "streaming"}
        aria-live="polite"
      >
        {t.answer !== null ? (
          <div className="animate-[bl-fade_0.4s_ease-out]">
            <AnswerText text={t.answer} unverified={t.verification?.unverified ?? []} />
          </div>
        ) : t.draft ? (
          <p className="text-base break-words whitespace-pre-wrap text-fg">
            {t.draft}
            <span
              aria-hidden
              className="ml-0.5 inline-block h-4 w-1.5 translate-y-0.5 animate-[bl-shimmer_0.9s_steps(2)_infinite] bg-fg"
            />
          </p>
        ) : t.state === "streaming" ? (
          <p className="meta flex items-center gap-2 text-subtle">
            <Sparkle className="animate-spin [animation-duration:1.6s]" />
            {running ? `Räknar: ${running.label.toLowerCase()}…` : "Tänker…"}
          </p>
        ) : null}

        {t.error ? (
          <div className="flex flex-wrap items-center gap-2 text-sm text-signal-fg">
            <span>{t.error}</span>
            {canRetry && t.errorCode !== "budget" && t.errorCode !== "not-configured" ? (
              <Button variant="ghost" size="sm" onClick={onRetry}>
                Fråga igen
              </Button>
            ) : null}
          </div>
        ) : null}

        {t.actions.length > 0 ? (
          <div
            className="flex animate-[bl-rise_0.35s_ease-out] flex-wrap gap-2"
            data-testid="ai-actions"
          >
            {t.actions.map((a) => (
              <Link
                key={a.href}
                href={a.href}
                onClick={() => {
                  if (window.matchMedia("(max-width: 639px)").matches) onNavigate();
                }}
                className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-line-strong bg-surface px-3 text-sm text-fg transition-[background-color,border-color] duration-fast hover:border-line-control hover:bg-hover"
              >
                {a.label} <span aria-hidden>→</span>
              </Link>
            ))}
          </div>
        ) : null}

        {t.state === "done" && t.verification ? (
          <div className="flex flex-col gap-1 [&_p]:text-xs">
            <VerificationLine verification={t.verification} />
            {t.calls.length > 0 ? (
              <details className="text-sm">
                <summary className="meta w-fit cursor-pointer text-subtle hover:text-fg">
                  Underlag · {formatInt(modelCalls.length)}{" "}
                  {modelCalls.length === 1 ? "verktyg" : "verktyg"}
                  {t.pageName ? ` · från ${t.pageName}` : ""}
                </summary>
                <Evidence calls={t.calls} />
              </details>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
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
      style={{ bottom: `calc(${layout.assistantBottom}px + env(safe-area-inset-bottom))` }}
      className={cn(
        "shadow-lg fixed right-4 z-30 flex size-11 items-center justify-center rounded-full border border-line-strong bg-inverse text-on-inverse transition-[transform,opacity] duration-300 ease-instrument active:scale-95 motion-reduce:transition-none max-md:hidden lg:hidden",
        shown ? "scale-100 opacity-100" : "pointer-events-none translate-y-4 scale-75 opacity-0",
      )}
    >
      <Sparkle size={18} className="animate-[bl-shimmer_2.4s_ease-in-out_infinite]" />
    </button>
  );
}
