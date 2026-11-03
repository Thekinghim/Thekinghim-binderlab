"use client";

/**
 * Samtalet med assistenten i webbläsaren: frågor till POST /assistent/fraga och svaren som
 * strömmas tillbaka (NDJSON, src/server/assistant/protocol.ts). Används av AI-panelen i
 * skalet, som ligger kvar mellan sidbyten, så att samtalet finns kvar när man navigerar.
 */

import { useCallback, useEffect, useRef, useState } from "react";

import type { PageContext } from "@/server/assistant/page-context";
import type {
  AssistantEvent,
  AssistantStatus,
  ToolCallRecord,
  ToolLink,
  Verification,
} from "@/server/assistant/protocol";

export type PanelCall = Pick<ToolCallRecord, "id" | "name" | "label" | "input"> & {
  readonly done?: ToolCallRecord;
};

export interface PanelTurn {
  readonly key: string;
  readonly question: string;
  /** Sidan frågan ställdes från (namn), för raden ovanför frågan. */
  readonly pageName: string | null;
  readonly draft: string;
  readonly answer: string | null;
  readonly calls: readonly PanelCall[];
  readonly state: "streaming" | "done" | "error";
  readonly status: AssistantStatus | null;
  readonly verification: Verification | null;
  readonly actions: readonly ToolLink[];
  readonly error: string | null;
  readonly errorCode: string | null;
  readonly budgetLeft: number | null;
}

let counter = 0;

export function useAssistantConversation() {
  const [turns, setTurns] = useState<PanelTurn[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const conversationRef = useRef<string | null>(null);
  conversationRef.current = conversationId;

  useEffect(() => () => abortRef.current?.abort(), []);

  const update = useCallback((key: string, fn: (t: PanelTurn) => PanelTurn) => {
    setTurns((all) => all.map((t) => (t.key === key ? fn(t) : t)));
  }, []);

  const handle = useCallback(
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
            calls: t.calls.some((c) => c.id === event.call.id)
              ? t.calls.map((c) => (c.id === event.call.id ? { ...c, done: event.call } : c))
              : [...t.calls, { ...event.call, done: event.call }],
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
            actions: event.actions ?? [],
            budgetLeft: event.budgetLeft ?? null,
          }));
          break;
        case "error":
          update(key, (t) => ({
            ...t,
            state: "error",
            error: event.message,
            errorCode: event.code,
          }));
          break;
      }
    },
    [update],
  );

  const ask = useCallback(
    async (text: string, page: PageContext | null, pageName: string | null) => {
      const q = text.replace(/\s+/g, " ").trim();
      if (!q || abortRef.current) return;
      const key = `p${++counter}`;
      setTurns((all) => [
        ...all,
        {
          key,
          question: q,
          pageName,
          draft: "",
          answer: null,
          calls: [],
          state: "streaming",
          status: null,
          verification: null,
          actions: [],
          error: null,
          errorCode: null,
          budgetLeft: null,
        },
      ]);
      setBusy(true);
      const controller = new AbortController();
      abortRef.current = controller;
      try {
        const response = await fetch("/assistent/fraga", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            question: q,
            conversationId: conversationRef.current,
            shell: page?.shell ?? {},
            page,
          }),
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
          let nl = buffer.indexOf("\n");
          while (nl >= 0) {
            const line = buffer.slice(0, nl).trim();
            buffer = buffer.slice(nl + 1);
            if (line) {
              const event = JSON.parse(line) as AssistantEvent;
              if (event.type === "done" || event.type === "error") finished = true;
              handle(key, event);
            }
            nl = buffer.indexOf("\n");
          }
        }
        if (!finished) {
          handle(key, { type: "error", code: "internal", message: "Svaret avbröts. Försök igen." });
        }
      } catch (error) {
        const aborted = error instanceof DOMException && error.name === "AbortError";
        handle(key, {
          type: "error",
          code: "internal",
          message: aborted ? "Du avbröt frågan." : "Kunde inte nå AI. Försök igen.",
        });
      } finally {
        abortRef.current = null;
        setBusy(false);
      }
    },
    [handle],
  );

  const stop = useCallback(() => abortRef.current?.abort(), []);

  const reset = useCallback(() => {
    abortRef.current?.abort();
    setTurns([]);
    setConversationId(null);
  }, []);

  return { turns, conversationId, busy, ask, stop, reset };
}
