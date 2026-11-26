"use client";

/**
 * AI-panelens innehåll (rubrik, samtalet, förslagen och frågefältet). Egen fil: skalet
 * (./assistant-panel.tsx) laddar den först när panelen öppnas första gången, så att den
 * inte fördröjer appens start. Samtalet och läget ligger kvar i skalet.
 */

import Link from "next/link";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";

import { AnswerText, Evidence, VerificationLine } from "@/app/(app)/assistent/_components/evidence";
import type { PanelState } from "@/app/(app)/assistent/panel-actions";
import { Button, IconButton } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { formatInt } from "@/lib/format";
import type { PageContext } from "@/server/assistant/page-context";
import { QUESTION_MAX_LENGTH } from "@/server/assistant/protocol";

import { Sparkle } from "./panel-context";
import type { PanelTurn, useAssistantConversation } from "./use-assistant-conversation";

export function AssistantPanelBody({
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
  // Första gången monteras panelen redan öppen (den laddas när den öppnas): en bild i stängt
  // läge först, så att den glider in som vanligt i stället för att bara dyka upp.
  const [entered, setEntered] = useState(false);
  useEffect(() => {
    const frame = requestAnimationFrame(() => setEntered(true));
    return () => cancelAnimationFrame(frame);
  }, []);
  const shown = open && entered;
  const { turns, busy, conversationId } = conversation;
  const last = turns[turns.length - 1];
  const ready = state?.status === "ready";
  const budgetLeft = last?.budgetLeft ?? state?.budgetLeft ?? null;

  // Datorn: sidan ger plats åt panelen (v2.css, :root[data-ai-open]) i stället för att tabeller
  // och kort hamnar under den.
  useEffect(() => {
    const root = document.documentElement;
    root.toggleAttribute("data-ai-open", shown);
    return () => root.removeAttribute("data-ai-open");
  }, [shown]);

  // Fältet i fokus när panelen visas (också första gången, när den just laddats).
  useEffect(() => {
    if (shown) inputRef.current?.focus({ preventScroll: true });
  }, [shown, inputRef]);

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
      aria-hidden={!shown}
      inert={!shown}
      data-testid="ai-panel"
      data-open={shown ? "true" : "false"}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
        }
      }}
      className={cn(
        "shadow-2xl fixed z-50 flex flex-col border-line bg-bg transition-[transform,opacity] duration-300 ease-instrument",
        // Mobil: ark nerifrån. Från sm: panel från höger.
        "rounded-t-lg inset-x-0 bottom-[calc(0px-var(--v2-vp-shift,0px))] h-[88dvh] border-t sm:inset-x-auto sm:top-0 sm:right-0 sm:bottom-auto sm:h-dvh sm:w-[420px] sm:rounded-none sm:border-t-0 sm:border-l",
        shown
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
        {/* Avstängd AI: inga förslag att trycka på (meddelandet står överst i panelen). */}
        {!busy && chips.length > 0 && state?.status !== "off" ? (
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
                  className="rounded-sm border border-line-strong px-2.5 py-1 text-left text-sm text-fg transition-[background-color,border-color,transform] duration-fast ease-instrument enabled:hover:border-line-control enabled:hover:bg-hover enabled:active:scale-[0.97] disabled:cursor-not-allowed disabled:border-dashed disabled:text-disabled max-md:min-h-11 max-md:px-3"
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
            placeholder={ready ? "Skriv en fråga" : state ? "Går inte att fråga nu" : "Laddar…"}
            className="max-h-32 min-h-9 w-full min-w-0 resize-none rounded-sm border border-line-control bg-bg px-3 py-1.5 text-base text-fg placeholder:text-subtle disabled:cursor-not-allowed disabled:border-dashed disabled:border-line-strong disabled:text-disabled max-md:min-h-11"
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
            className="meta ml-auto text-muted underline decoration-line-control underline-offset-4 hover:text-fg max-md:tap max-md:justify-end"
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
                className="inline-flex h-8 items-center gap-1.5 rounded-sm border border-line-strong bg-surface px-3 text-sm text-fg transition-[background-color,border-color] duration-fast hover:border-line-control hover:bg-hover max-md:min-h-11"
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
                <summary className="meta w-fit cursor-pointer text-subtle hover:text-fg max-md:min-h-11">
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
