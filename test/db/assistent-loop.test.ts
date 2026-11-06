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
import { MAX_OUTPUT_TOKENS_PER_QUESTION, MAX_TURNS } from "@/server/assistant/loop";
import { getServiceDb } from "@/db/client";
import { sql } from "drizzle-orm";
import { pageContextFromUrl } from "@/server/assistant/page-context";
import { askAssistant } from "@/server/assistant/service";
import { chooseTool, createLocalModelClient } from "@/server/assistant/local-model";
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
  it("svaret skrivet före foresla_knapp blir svaret när slutvarvet är tomt", async () => {
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
      if (turn === 2) {
        const top = firstRow(request);
        return scriptedMessage("claude-opus-5-5", [
          textBlock(`${top.namn} tjänade mest i mars 2025: ${top.vinst} i vinst.`),
          toolUseBlock("foresla_knapp", { sida: "lonsamhet" }, "toolu_b"),
        ]);
      }
      return scriptedMessage("claude-opus-5-5", []);
    });
    const { events } = await collect({
      viewer: owner,
      question: "Vilken automat tjänade mest i mars?",
      conversationId: randomUUID(),
      now: NOW,
      config: READY,
      client,
    });
    const done = events.at(-1) as Extract<AssistantEvent, { type: "done" }>;
    expect(done.answer).toMatch(/tjänade mest i mars 2025/);
    expect(done.answer).not.toBe("");
  });

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
      [
        "att_gora",
        "automat_status",
        "besoksplan",
        "foresla_knapp",
        "hitta",
        "lager",
        "rackvidd",
        "salda_pack",
        "vart_lager",
      ].sort(),
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

  it("stannar efter högst MAX_TURNS varv", async () => {
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
    expect(client.requests).toHaveLength(MAX_TURNS);
    expect((events.at(-1) as Extract<AssistantEvent, { type: "done" }>).status).toBe("limit");
  });

  it("en fråga som avbryts mitt i loggas med det den kostade (räknas mot taket)", async () => {
    let turns = 0;
    const client: ModelClient = {
      provider: "anthropic",
      model: "claude-opus-5-5",
      async turn() {
        turns += 1;
        if (turns > 1) throw new Error("avbruten");
        const m = scriptedMessage("claude-opus-5-5", [toolUseBlock("hitta", { typ: "automater" })]);
        return { ...m, usage: { ...m.usage, input_tokens: 1200, output_tokens: 3400 } };
      },
    };
    const { events } = await collect({
      viewer: owner,
      question: "Avbryt mig",
      conversationId: randomUUID(),
      now: NOW,
      config: READY,
      client,
    });
    const error = events.at(-1) as Extract<AssistantEvent, { type: "error" }>;
    expect(error.type).toBe("error");
    const [row] = Array.from(
      await getServiceDb().execute(
        sql`select usage from public.assistant_logs where id = ${error.logId!}::uuid`,
      ),
    ) as Array<{ usage: { inputTokens: number; outputTokens: number; turns: number } }>;
    expect(row?.usage).toMatchObject({ inputTokens: 1200, outputTokens: 3400, turns: 1 });
  });

  it("stannar när en fråga har använt utdatataket, även före MAX_TURNS", async () => {
    const client = mockClient(() => {
      const m = scriptedMessage("claude-opus-5-5", [toolUseBlock("hitta", { typ: "automater" })]);
      return {
        ...m,
        usage: { ...m.usage, output_tokens: Math.ceil(MAX_OUTPUT_TOKENS_PER_QUESTION / 2) },
      };
    });
    const { events } = await collect({
      viewer: owner,
      question: "Tänk länge",
      conversationId: randomUUID(),
      now: NOW,
      config: READY,
      client,
    });
    expect(client.requests).toHaveLength(2);
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

  it("loggar modellen som faktiskt svarade när API:t använder en reservmodell", async () => {
    const client = mockClient(() =>
      scriptedMessage("claude-sonnet-5-5", [textBlock("Det finns inget tal här.")]),
    );
    const { events } = await collect({
      viewer: owner,
      question: "Hej",
      conversationId: randomUUID(),
      now: NOW,
      config: READY,
      client,
    });
    const done = events.at(-1) as Extract<AssistantEvent, { type: "done" }>;
    const log = await getLogFor(owner.user, fx.orgId, done.logId!);
    expect(client.model).toBe("claude-opus-5-5");
    expect(log?.model).toBe("claude-sonnet-5-5");
  });

  it("ett varv som inte gick att tolka görs om, och utkastet töms innan det strömmas igen", async () => {
    let calls = 0;
    const client: ModelClient = {
      provider: "anthropic",
      model: "claude-opus-5-5",
      async turn(_request, onText) {
        calls += 1;
        if (calls === 1) {
          onText("Halvt svar ");
          throw new SyntaxError("Ogiltig JSON i verktygsparametrarna");
        }
        onText("Klart.");
        return scriptedMessage("claude-opus-5-5", [textBlock("Klart.")]);
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
    const types = events.map((e) => (e.type === "text" ? `text:${e.text}` : e.type));
    expect(types).toEqual(["start", "text:Halvt svar ", "turn", "text:Klart.", "done"]);
    const done = events.at(-1) as Extract<AssistantEvent, { type: "done" }>;
    expect(done.answer).toBe("Klart.");
  });

  it("perioden som är vald i panelen följer med i systemprompten", async () => {
    const client = mockClient(() => scriptedMessage("claude-opus-5-5", [textBlock("Ok.")]));
    await collect({
      viewer: owner,
      question: "Hur gick det?",
      conversationId: randomUUID(),
      now: NOW,
      config: READY,
      client,
      shellParams: { period: "7d" },
    });
    const system = client.requests[0]!.system.map((b) => b.text).join("\n");
    expect(system).toMatch(/Vald period i panelen: 7 dagar, 2025-03-\d{2} till 2025-03-1\d\./);

    const without = mockClient(() => scriptedMessage("claude-opus-5-5", [textBlock("Ok.")]));
    await collect({
      viewer: owner,
      question: "Hur gick det?",
      conversationId: randomUUID(),
      now: NOW,
      config: READY,
      client: without,
    });
    expect(without.requests[0]!.system.map((b) => b.text).join("\n")).not.toContain(
      "Vald period i panelen",
    );
  });

  it("vyknappen Visa butikernas andel: AI:n räknar som sidan, ?andel i adressen före kakan", async () => {
    // Sidans sammanfattning (nyckeltal på Lönsamhet) och systemprompten för en sida i ett läge.
    async function ask(search: string, cookie: boolean) {
      const client = mockClient(() => scriptedMessage("claude-opus-5-5", [textBlock("Ok.")]));
      const { events } = await collect({
        viewer: owner,
        question: "Hur gick det?",
        conversationId: randomUUID(),
        now: NOW,
        config: READY,
        client,
        page: pageContextFromUrl("/lonsamhet", `?period=manad${search}`),
        storeShare: cookie,
      });
      const call = events.find((e) => e.type === "tool_result") as Extract<
        AssistantEvent,
        { type: "tool_result" }
      >;
      const profit = call.call.figures.find((f) => f.label === "Vinst")?.value;
      const system = client.requests[0]!.system.map((b) => b.text).join("\n");
      return { profit, shown: system.includes("Butikernas andel visas") };
    }
    const off = await ask("", false);
    const on = await ask("&andel=1", false);
    // Fixturens butik har 10 % provision: vår del är mindre än vinsten före andelen.
    expect(on.profit).not.toBe(off.profit);
    expect(off.shown).toBe(false);
    expect(on.shown).toBe(true);
    // Kakan utan ?andel (t.ex. via logotypen): sidan visar andelen, och AI:n likaså.
    expect(await ask("", true)).toEqual(on);
    // ?andel=0 i adressen går före kakan, som på sidan (storeShareViewOf).
    expect(await ask("&andel=0", true)).toEqual(off);
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

  it("den lokala testmodellen väljer verktyg med nyckelord, bland rollens verktyg", () => {
    const all = new Set([
      "nyckeltal",
      "lonsamhet",
      "inkopsforslag",
      "rackvidd",
      "salda_pack",
      "lager",
    ]);
    const stock = new Set(["rackvidd", "salda_pack", "lager", "att_gora", "hitta"]);
    expect(chooseTool("Vad ska jag beställa inför nästa vecka?", "2025-03-12", all)?.name).toBe(
      "inkopsforslag",
    );
    expect(chooseTool("Vad ska jag beställa inför nästa vecka?", "2025-03-12", stock)?.name).toBe(
      "rackvidd",
    );
    expect(chooseTool("Hur gick oktober?", "2025-03-12", all)).toEqual({
      name: "nyckeltal",
      input: { fran: "2024-10-01", till: "2024-10-31" },
    });
  });
});
