"use client";

/**
 * Samtalet med assistenten: frågefält, exempelfrågor och svaren som strömmas från
 * /assistent/fraga (NDJSON). Varje svar visar texten medan den kommer, verktygen som
 * anropas (med parametrar och resultat) och till sist kontrollen av talen.
 */

import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";

import { FROM_PARAM, PERIOD_PARAM, TO_PARAM } from "@/components/shell/period-state";
import { Button } from "@/components/ui/button";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag } from "@/components/ui/status-tag";
import { cn } from "@/lib/cn";
import { formatDuration, formatInt } from "@/lib/format";
import {
  QUESTION_MAX_LENGTH,
  type AssistantEvent,
  type AssistantStatus,
  type Verification,
} from "@/server/assistant/protocol";

import { AnswerText, Evidence, VerificationLine, type PendingCall } from "./evidence";

/**
 * Periodvalet i panelen (skalets URL: period, from, to), som skickas med frågan. Servern
 * tolkar det som sidorna gör och ger modellen perioden när frågan inte anger någon.
 */
function shellParams(): Record<string, string> {
  const out: Record<string, string> = {};
  const sp = new URLSearchParams(window.location.search);
  for (const key of [PERIOD_PARAM, FROM_PARAM, TO_PARAM]) {
    const value = sp.get(key);
    if (value) out[key] = value;
  }
  return out;
}

type Turn = {
  key: string;
  question: string;
  /** Texten i det pågående varvet. */
  draft: string;
  answer: string | null;
  calls: PendingCall[];
  state: "streaming" | "done" | "error";
  status: AssistantStatus | null;
  verification: Verification | null;
  error: string | null;
  durationMs: number | null;
};

export type AssistantChatProps = {
  ready: boolean;
  /** "Lokal testmodell" eller modellens namn. */
  modelLabel: string;
  local: boolean;
  examples: readonly string[];
  /** När assistenten inte är konfigurerad: meningen och vad som behövs. */
  notConfigured: { message: string; detail: string } | null;
  /** Ifylld fråga (från "Fråga assistenten" på ett förslag). Skickas inte automatiskt. */
  initialQuestion?: string;
  /** Samtalet från AI-panelen ("Öppna i Assistent"): fortsätter i samma samtal. */
  initialConversationId?: string | null;
  /** Tidigare frågor och svar i samtalet (visas som klara). */
  initialTurns?: ReadonlyArray<{ question: string; answer: string }>;
};

const STATUS_TEXT: Partial<Record<AssistantStatus, string>> = {
  refused: "Modellen avböjde",
  limit: "Avbrutet: för många steg",
  error: "Fel",
};

let turnCounter = 0;

export function AssistantChat({
  ready,
  modelLabel,
  local,
  examples,
  notConfigured,
  initialQuestion = "",
  initialConversationId = null,
  initialTurns = [],
}: AssistantChatProps) {
  const [turns, setTurns] = useState<Turn[]>(() =>
    initialTurns.map((t) => ({
      key: `t${++turnCounter}`,
      question: t.question,
      draft: "",
      answer: t.answer,
      calls: [],
      state: "done" as const,
      status: null,
      verification: null,
      error: null,
      durationMs: null,
    })),
  );
  const [question, setQuestion] = useState(initialQuestion);
  const [conversationId, setConversationId] = useState<string | null>(initialConversationId);
  const [busy, setBusy] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const endRef = useRef<HTMLDivElement>(null);
  const inputId = useId();
  const hintId = useId();

  useEffect(() => () => abortRef.current?.abort(), []);
  useEffect(() => {
    if (initialQuestion) inputRef.current?.focus();
  }, [initialQuestion]);

  const update = useCallback((key: string, fn: (t: Turn) => Turn) => {
    setTurns((all) => all.map((t) => (t.key === key ? fn(t) : t)));
  }, []);

  const handleEvent = useCallback(
    (key: string, event: AssistantEvent) => {
      switch (event.type) {
        case "start":
          setConversationId(event.conversationId);
          break;
        case "text":
          update(key, (t) => ({ ...t, draft: t.draft + event.text }));
          break;
        case "turn":
          update(key, (t) => ({ ...t, draft: "" }));
          break;
        case "tool_call":
          update(key, (t) => ({
            ...t,
            draft: "",
            calls: [
              ...t.calls,
              { id: event.id, name: event.name, label: event.label, input: event.input },
            ],
          }));
          break;
        case "tool_result":
          update(key, (t) => ({
            ...t,
            calls: t.calls.map((c) => (c.id === event.call.id ? { ...c, done: event.call } : c)),
          }));
          break;
        case "done":
          update(key, (t) => ({
            ...t,
            state: "done",
            draft: "",
            answer: event.answer,
            status: event.status,
            verification: event.verification,
            durationMs: event.durationMs,
          }));
          setAnnouncement(
            event.verification.unverified.length > 0
              ? `Svaret är klart. ${event.verification.unverified.length} tal finns inte i underlaget.`
              : "Svaret är klart.",
          );
          break;
        case "error":
          update(key, (t) => ({ ...t, state: "error", error: event.message }));
          setAnnouncement(`Fel: ${event.message}`);
          break;
      }
    },
    [update],
  );

  const ask = useCallback(
    async (text: string) => {
      const q = text.replace(/\s+/g, " ").trim();
      if (!q || busy || !ready) return;
      const key = `t${++turnCounter}`;
      setTurns((all) => [
        ...all,
        {
          key,
          question: q,
          draft: "",
          answer: null,
          calls: [],
          state: "streaming",
          status: null,
          verification: null,
          error: null,
          durationMs: null,
        },
      ]);
      setQuestion("");
      setBusy(true);
      setAnnouncement("Assistenten räknar.");
      const controller = new AbortController();
      abortRef.current = controller;
      requestAnimationFrame(() => endRef.current?.scrollIntoView({ block: "nearest" }));

      try {
        const response = await fetch("/assistent/fraga", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question: q, conversationId, shell: shellParams() }),
          signal: controller.signal,
        });
        if (!response.body) throw new Error("Inget svar från servern.");
        const reader = response.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        let finished = false;
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let newline = buffer.indexOf("\n");
          while (newline >= 0) {
            const line = buffer.slice(0, newline).trim();
            buffer = buffer.slice(newline + 1);
            if (line) {
              const event = JSON.parse(line) as AssistantEvent;
              if (event.type === "done" || event.type === "error") finished = true;
              handleEvent(key, event);
            }
            newline = buffer.indexOf("\n");
          }
        }
        if (!finished) {
          handleEvent(key, {
            type: "error",
            code: "internal",
            message: "Svaret avbröts innan det var klart.",
          });
        }
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === "AbortError";
        handleEvent(key, {
          type: "error",
          code: "internal",
          message: aborted
            ? "Du avbröt frågan."
            : "Kunde inte nå assistenten. Kontrollera anslutningen och försök igen.",
        });
      } finally {
        abortRef.current = null;
        setBusy(false);
        inputRef.current?.focus();
      }
    },
    [busy, conversationId, handleEvent, ready],
  );

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void ask(question);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void ask(question);
    }
  };

  const newConversation = () => {
    abortRef.current?.abort();
    setTurns([]);
    setConversationId(null);
    setAnnouncement("Nytt samtal.");
    inputRef.current?.focus();
  };

  const tooLong = question.length > QUESTION_MAX_LENGTH;

  return (
    <div className="flex min-w-0 flex-col gap-8">
      {notConfigured ? (
        <StateMessage
          kind="not-configured"
          message={notConfigured.message}
          detail={notConfigured.detail}
        />
      ) : null}

      {turns.length > 0 ? (
        <ol className="flex flex-col gap-12" aria-label="Samtalet">
          {turns.map((t, i) => (
            <li key={t.key} className="flex min-w-0 flex-col gap-5 border-t border-line pt-6">
              <div className="flex flex-col gap-2">
                <span className="label text-muted">
                  <span className="tnum text-fg">{String(i + 1).padStart(2, "0")}</span>
                  <span className="text-faint"> / </span>Din fråga
                </span>
                <p className="max-w-3xl text-lg break-words text-fg">{t.question}</p>
              </div>

              <div className="flex flex-col gap-3" aria-busy={t.state === "streaming"}>
                <span className="label flex flex-wrap items-center gap-2 text-muted">
                  Svar
                  {t.state === "streaming" ? (
                    <span className="meta text-subtle normal-case">
                      {t.calls.some((c) => !c.done) ? "räknar med verktygen…" : "skriver…"}
                    </span>
                  ) : null}
                  {t.status && STATUS_TEXT[t.status] ? (
                    <StatusTag status="warning">{STATUS_TEXT[t.status]}</StatusTag>
                  ) : null}
                </span>
                {t.answer !== null ? (
                  <AnswerText text={t.answer} unverified={t.verification?.unverified ?? []} />
                ) : t.draft ? (
                  <AnswerText text={t.draft} className="opacity-80" />
                ) : t.state === "streaming" ? (
                  <p className="meta text-subtle">
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 14 14"
                      className="bl-ticks inline-block"
                      fill="currentColor"
                      aria-hidden
                    >
                      <rect x="1" y="6" width="2" height="2" className="animate-tick" />
                      <rect x="6" y="6" width="2" height="2" className="animate-tick" />
                      <rect x="11" y="6" width="2" height="2" className="animate-tick" />
                    </svg>
                    <span className="sr-only">Väntar på svar</span>
                  </p>
                ) : null}
                {t.error ? (
                  <StateMessage
                    kind="error"
                    compact
                    message={t.error}
                    action={
                      ready
                        ? { label: "Fråga igen", onClick: () => void ask(t.question) }
                        : undefined
                    }
                  />
                ) : null}
                {t.verification && t.state === "done" ? (
                  <VerificationLine verification={t.verification} />
                ) : null}
              </div>

              {t.calls.length > 0 || t.state === "done" ? (
                <section
                  className="flex min-w-0 flex-col gap-1"
                  aria-label={`Underlag för fråga ${i + 1}`}
                >
                  <div className="flex flex-wrap items-baseline justify-between gap-2">
                    <span className="label text-muted">Underlag</span>
                    {t.state === "done" ? (
                      <span className="meta tnum text-subtle">
                        {formatInt(t.calls.length)} anrop
                        {t.durationMs !== null ? ` · ${formatDuration(t.durationMs)}` : ""} ·{" "}
                        {modelLabel}
                      </span>
                    ) : null}
                  </div>
                  <Evidence calls={t.calls} pending={t.state === "streaming"} />
                </section>
              ) : null}
            </li>
          ))}
        </ol>
      ) : null}
      <div ref={endRef} />

      <form
        noValidate
        onSubmit={onSubmit}
        className="flex min-w-0 flex-col gap-3"
        aria-label="Ställ en fråga"
      >
        <div className="flex items-baseline justify-between gap-4">
          <label htmlFor={inputId} className="label text-muted">
            {turns.length > 0 ? "Följdfråga" : "Fråga"}
          </label>
          {local ? <span className="label text-subtle">Lokal testmodell · ingen AI</span> : null}
        </div>
        <textarea
          ref={inputRef}
          id={inputId}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
          rows={3}
          disabled={!ready}
          aria-describedby={hintId}
          aria-invalid={tooLong || undefined}
          placeholder={
            ready
              ? (examples[0] ?? "Ställ en fråga om er data")
              : "Assistenten är inte konfigurerad"
          }
          className={cn(
            "w-full min-w-0 resize-y rounded-sm border bg-bg px-3 py-2 text-base text-fg transition-[border-color] duration-fast ease-instrument placeholder:text-subtle enabled:hover:border-muted",
            "disabled:cursor-not-allowed disabled:border-dashed disabled:border-line-strong disabled:bg-transparent disabled:text-disabled disabled:placeholder:text-disabled",
            tooLong ? "border-signal" : "border-line-control",
          )}
        />
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p id={hintId} className={cn("meta", tooLong ? "text-signal-fg" : "text-subtle")}>
            {tooLong
              ? `${formatInt(question.length)} av högst ${formatInt(QUESTION_MAX_LENGTH)} tecken.`
              : "Enter skickar."}
          </p>
          <div className="flex items-center gap-2">
            {turns.length > 0 ? (
              <Button type="button" variant="ghost" size="md" onClick={newConversation}>
                Nytt samtal
              </Button>
            ) : null}
            {busy ? (
              <Button type="button" variant="secondary" onClick={() => abortRef.current?.abort()}>
                Avbryt
              </Button>
            ) : null}
            <Button
              type="submit"
              variant="primary"
              loading={busy}
              disabled={!ready || tooLong || !question.trim()}
            >
              Fråga
            </Button>
          </div>
        </div>
      </form>

      {turns.length === 0 && examples.length > 0 ? (
        <div className="flex flex-col gap-3">
          <span className="label text-muted">Till exempel</span>
          <ul className="flex flex-wrap gap-2">
            {examples.map((ex) => (
              <li key={ex}>
                <button
                  type="button"
                  disabled={!ready || busy}
                  onClick={() => void ask(ex)}
                  className="min-h-7 rounded-sm border border-line-strong bg-surface px-2.5 py-1 text-left text-sm text-fg transition-[background-color,border-color] duration-fast ease-instrument enabled:hover:border-line-control enabled:hover:bg-hover disabled:cursor-not-allowed disabled:border-dashed disabled:bg-transparent disabled:text-disabled"
                >
                  {ex}
                </button>
              </li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="sr-only" role="status" aria-live="polite">
        {announcement}
      </p>
    </div>
  );
}
