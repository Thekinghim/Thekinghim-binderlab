/**
 * Hela assistentloopen (askAssistant) med en mockad modellklient mot testdatabasen:
 * verktygen körs på riktigt (RLS), händelserna strömmas i rätt ordning, talen i svaret
 * kontrolleras mot verktygsresultaten och frågan loggas. Ingen riktig API-trafik.
 */

import { randomUUID } from "node:crypto";

import { beforeAll, describe, expect, it } from "vitest";

import type { ModelClient, ModelTurnRequest } from "@/server/assistant/model-client";
import type { AssistantEvent } from "@/server/assistant/protocol";
import {
  lastToolResults,
  scriptedMessage,
  textBlock,
  toolUseBlock,
} from "@/server/assistant/scripted";
import { getLogFor } from "@/server/assistant/log";
import { askAssistant } from "@/server/assistant/service";
import { createLocalModelClient } from "@/server/assistant/local-model";
import type { Viewer } from "@/server/data/core/loaders";

import { seedAssistantFixture, viewerFor, type AssistantFixture } from "./assistent-fixture";
import { createMember } from "./helpers";

const NOW = new Date("2025-03-12T09:00:00Z");
const READY = { status: "ready", provider: "local", model: "lokal-testmodell" } as const;

/**
 * En mockad klient: varje varv bestäms av `script`, som får förfrågan (system, verktyg,
 * meddelanden). Förfrågningarna sparas för kontroll.
 */
function mockClient(
  script: (request: ModelTurnRequest, turn: number) => ReturnType<typeof scriptedMessage>,
): ModelClient & { requests: ModelTurnRequest[] } {
  const requests: ModelTurnRequest[] = [];
  return {
    provider: "anthropic",
    model: "claude-opus-5-5",
    requests,
    async turn(request, onText) {
      requests.push({ ...request, messages: [...request.messages] });
      const message = script(request, requests.length);
      for (const block of message.content) {
        if (block.type === "text")
          for (const part of block.text.match(/\S+\s*/g) ?? []) onText(part);
      }
      return message;
    },
  };
}

/** Vinsten för första raden ur lonsamhet-resultatet i senaste varvet. */
function firstRow(request: ModelTurnRequest): { namn: string; vinst: string; intakt: string } {
  const [result] = lastToolResults(request.messages);
  const parsed = JSON.parse(result!.content) as {
    data: { rader: Array<{ namn: string; vinst: string; intakt: string }> };
  };
  return parsed.data.rader[0]!;
}

type AskInput = Omit<Parameters<typeof askAssistant>[0], "emit">;

async function collect(args: AskInput) {
  const events: AssistantEvent[] = [];
  const result = await askAssistant({ ...args, emit: (e) => events.push(e) });
  return { events, result };
}

let fx: AssistantFixture;
let owner: Viewer;
let refiller: Viewer;

beforeAll(async () => {
  fx = await seedAssistantFixture();
  owner = await viewerFor(fx.owner, fx.orgId);
  refiller = await viewerFor(await createMember(fx.orgId, "refiller"), fx.orgId);
});

describe("askAssistant med mockad klient", () => {
  it("frågar, kör verktyget, strömmar svaret, kontrollerar talen och loggar", async () => {
    const client = mockClient((request, turn) => {
      if (turn === 1) {
        return scriptedMessage("claude-opus-5-5", [
          toolUseBlock(
            "lonsamhet",
            { fran: "2025-03-01", till: "2025-03-31", per: "automat" },
            "toolu_a",
          ),
        ]);
      }
      const top = firstRow(request);
      return scriptedMessage("claude-opus-5-5", [
        textBlock(
          `${top.namn} tjänade mest i mars 2025: ${top.vinst} i vinst.\n- Intäkt ${top.intakt}.`,
        ),
      ]);
    });
    const conversationId = randomUUID();
    const { events, result } = await collect({
      viewer: owner,
      question: "Vilken automat tjänade mest i mars?",
      conversationId,
      now: NOW,
      config: READY,
      client,
    });

    expect(
      events.map((e) => e.type).filter((t, i, a) => t !== "text" || a[i - 1] !== "text"),
    ).toEqual(["start", "tool_call", "tool_result", "turn", "text", "done"]);
    const start = events[0] as Extract<AssistantEvent, { type: "start" }>;
    expect(start.tools.map((t) => t.name)).toContain("nyckeltal");
    expect(start.conversationId).toBe(conversationId);

    const done = events.at(-1) as Extract<AssistantEvent, { type: "done" }>;
    expect(done.status).toBe("answered");
    expect(done.answer).toMatch(/^Automat 1 \(BL-001\) tjänade mest/);
    expect(done.verification.unverified).toEqual([]);
    expect(done.verification.checked).toBeGreaterThanOrEqual(2);
    expect(result.status).toBe("answered");

    // Systemprompten har dagens datum och rollen; verktygen är rollens.
    const first = client.requests[0]!;
    expect(first.system.map((b) => b.text).join("\n")).toContain("2025-03-12");
    expect(first.tools.map((t) => t.name)).toContain("lonsamhet");
    // Andra varvet skickar tillbaka assistentens innehåll oförändrat och verktygsresultatet.
    const second = client.requests[1]!;
    expect(second.messages).toHaveLength(3);
    expect(second.messages[1]).toEqual({
      role: "assistant",
      content: [expect.objectContaining({ type: "tool_use", id: "toolu_a", name: "lonsamhet" })],
    });

    const log = await getLogFor(owner.user, fx.orgId, done.logId!);
    expect(log?.status).toBe("answered");
    expect(log?.provider).toBe("anthropic");
    expect(log?.toolCalls).toHaveLength(1);
    expect(log?.toolCalls[0]?.input).toEqual({
      fran: "2025-03-01",
      till: "2025-03-31",
      per: "automat",
    });
    expect(log?.answer).toBe(done.answer);
  });

  it("markerar tal som inte finns i underlaget", async () => {
    const client = mockClient((request, turn) =>
      turn === 1
        ? scriptedMessage("claude-opus-5-5", [
            toolUseBlock("nyckeltal", { fran: "2025-03-01", till: "2025-03-31" }),
          ])
        : scriptedMessage("claude-opus-5-5", [
            textBlock("Vinsten blev ungefär 4 321 kr i mars 2025."),
          ]),
    );
    const { events } = await collect({
      viewer: owner,
      question: "Vad blev vinsten i mars?",
      conversationId: randomUUID(),
      now: NOW,
      config: READY,
      client,
    });
    const done = events.at(-1) as Extract<AssistantEvent, { type: "done" }>;
    expect(done.status).toBe("unverified");
    expect(done.verification.unverified).toEqual(["4 321"]);
    const log = await getLogFor(owner.user, fx.orgId, done.logId!);
    expect(log?.status).toBe("unverified");
    expect(log?.verification.unverified).toEqual(["4 321"]);
  });

  it("påfyllaren får bara lagerverktyg, och ett ekonomiverktyg körs aldrig", async () => {
    const client = mockClient((_request, turn) =>
      turn === 1
        ? scriptedMessage("claude-opus-5-5", [
            toolUseBlock("nyckeltal", { fran: "2025-03-01", till: "2025-03-31" }, "toolu_x"),
          ])
        : scriptedMessage("claude-opus-5-5", [textBlock("Din roll ser inte ekonomi.")]),
    );
    const { events } = await collect({
      viewer: refiller,
      question: "Vad blev vinsten i mars?",
      conversationId: randomUUID(),
      now: NOW,
      config: READY,
      client,
    });
    expect(client.requests[0]!.tools.map((t) => t.name).sort()).toEqual(
      ["att_gora", "hitta", "lager", "rackvidd", "salda_pack"].sort(),
    );
    const result = events.find((e) => e.type === "tool_result") as Extract<
      AssistantEvent,
      { type: "tool_result" }
    >;
    expect(result.call.ok).toBe(false);
    expect(result.call.summary).toContain("finns inte för din roll");
    const toolMessage = client.requests[1]!.messages[2]!;
    expect(JSON.stringify(toolMessage)).toContain('"is_error":true');
    const done = events.at(-1) as Extract<AssistantEvent, { type: "done" }>;
    expect(done.status).toBe("answered");
    const log = await getLogFor(refiller.user, fx.orgId, done.logId!);
    expect(log?.role).toBe("refiller");
  });

  it("ogiltiga parametrar blir ett verktygsfel som modellen kan rätta", async () => {
    const client = mockClient((_request, turn) => {
      if (turn === 1) {
        return scriptedMessage("claude-opus-5-5", [
          toolUseBlock("lonsamhet", { fran: "mars", per: "planet" }),
        ]);
      }
      if (turn === 2) {
        return scriptedMessage("claude-opus-5-5", [
          toolUseBlock("lonsamhet", { fran: "2025-03-01", till: "2025-03-12", per: "titel" }),
        ]);
      }
      return scriptedMessage("claude-opus-5-5", [textBlock("Klart.")]);
    });
    const { events } = await collect({
      viewer: owner,
      question: "Bästa titeln?",
      conversationId: randomUUID(),
      now: NOW,
      config: READY,
      client,
    });
    const results = events.filter((e) => e.type === "tool_result") as Array<
      Extract<AssistantEvent, { type: "tool_result" }>
    >;
    expect(results.map((r) => r.call.ok)).toEqual([false, true]);
    expect(results[0]!.call.summary).toBe("Ogiltiga parametrar.");
  });

  it("följdfrågan får tidigare fråga och svar i samtalet som historik", async () => {
    const conversationId = randomUUID();
    const answerOnce = (text: string) =>
      mockClient(() => scriptedMessage("claude-opus-5-5", [textBlock(text)]));
    await collect({
      viewer: owner,
      question: "Hej",
      conversationId,
      now: NOW,
      config: READY,
      client: answerOnce("Hej! Fråga om er data."),
    });
    const second = answerOnce("Ja.");
    await collect({
      viewer: owner,
      question: "Och sedan?",
      conversationId,
      now: NOW,
      config: READY,
      client: second,
    });
    expect(second.requests[0]!.messages).toEqual([
      { role: "user", content: "Hej" },
      { role: "assistant", content: "Hej! Fråga om er data." },
      { role: "user", content: "Och sedan?" },
    ]);
  });

  it("stannar efter högst åtta varv", async () => {
    const client = mockClient(() =>
      scriptedMessage("claude-opus-5-5", [toolUseBlock("hitta", { typ: "automater" })]),
    );
    const { events } = await collect({
      viewer: owner,
      question: "Loopa",
      conversationId: randomUUID(),
      now: NOW,
      config: READY,
      client,
    });
    expect(client.requests).toHaveLength(8);
    expect((events.at(-1) as Extract<AssistantEvent, { type: "done" }>).status).toBe("limit");
  });

  it("utan nyckel: ärligt fel, inget anrop och ingen logg", async () => {
    const client = mockClient(() => scriptedMessage("claude-opus-5-5", [textBlock("x")]));
    const { events, result } = await collect({
      viewer: owner,
      question: "Hej",
      conversationId: randomUUID(),
      now: NOW,
      config: {
        status: "not-configured",
        message: "Assistenten kräver ANTHROPIC_API_KEY.",
        missing: ["ANTHROPIC_API_KEY"],
      },
      client,
    });
    expect(events).toEqual([
      { type: "error", code: "not-configured", message: "Assistenten kräver ANTHROPIC_API_KEY." },
    ]);
    expect(client.requests).toHaveLength(0);
    expect(result).toEqual({ logId: null, status: "not-configured" });
  });

  it("ett API-fel loggas som fel med svenskt meddelande", async () => {
    const client: ModelClient = {
      provider: "anthropic",
      model: "claude-opus-5-5",
      async turn() {
        const { default: Anthropic } = await import("@anthropic-ai/sdk");
        throw new Anthropic.RateLimitError(429, undefined, "rate limited", new Headers());
      },
    };
    const { events } = await collect({
      viewer: owner,
      question: "Hej",
      conversationId: randomUUID(),
      now: NOW,
      config: READY,
      client,
    });
    const error = events.at(-1) as Extract<AssistantEvent, { type: "error" }>;
    expect(error.code).toBe("upstream");
    expect(error.message).toContain("429");
    const log = await getLogFor(owner.user, fx.orgId, error.logId!);
    expect(log?.status).toBe("error");
    expect(log?.error).toContain("429");
  });

  it("den lokala testmodellen svarar med verktygets egen sammanfattning", async () => {
    const { events } = await collect({
      viewer: owner,
      question: "Vilken automat tjänade mest i mars?",
      conversationId: randomUUID(),
      now: NOW,
      config: READY,
      client: createLocalModelClient(),
    });
    const call = events.find((e) => e.type === "tool_call") as Extract<
      AssistantEvent,
      { type: "tool_call" }
    >;
    expect(call.name).toBe("lonsamhet");
    expect(call.input).toEqual({ fran: "2025-03-01", till: "2025-03-31", per: "automat" });
    const done = events.at(-1) as Extract<AssistantEvent, { type: "done" }>;
    expect(done.status).toBe("answered");
    expect(done.answer).toContain("Automat 1 (BL-001)");
  });
});
