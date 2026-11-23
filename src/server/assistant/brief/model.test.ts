import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

import { BRIEF_TOOL_NAME } from "./check";
import { createAnthropicBrief } from "./model";

function fakeClient(content: unknown[], stopReason = "tool_use") {
  const create = vi.fn(async (_params: Record<string, unknown>) => ({
    model: "claude-sonnet-5-5",
    stop_reason: stopReason,
    content,
    usage: { input_tokens: 10, output_tokens: 5 },
  }));
  return { create, client: { beta: { messages: { create } } } as unknown as Anthropic };
}

const REQUEST = { instructions: "Instruktioner", message: "Underlag" };

describe("createAnthropicBrief", () => {
  it("tvingar inte verktyget: tool_choice auto (modellen avvisar tool/any)", async () => {
    const { create, client } = fakeClient([]);
    await createAnthropicBrief({ apiKey: "x", model: "claude-sonnet-5-5", client }).write(REQUEST);
    const params = create.mock.calls[0]![0];
    expect(params.tool_choice).toEqual({ type: "auto" });
    expect((params.tools as { name: string }[]).map((t) => t.name)).toEqual([BRIEF_TOOL_NAME]);
  });

  it("läser indata från spara_brief", async () => {
    const input = { igar: "a", vecka: "b", gora: "c" };
    const { client } = fakeClient([
      { type: "text", text: "Här är briefen." },
      { type: "tool_use", id: "t1", name: BRIEF_TOOL_NAME, input },
    ]);
    const res = await createAnthropicBrief({ apiKey: "x", model: "m", client }).write(REQUEST);
    expect(res.toolInput).toEqual(input);
    expect(res.stopReason).toBe("tool_use");
  });

  it("ger null när modellen svarar med text utan verktygsanrop", async () => {
    const { client } = fakeClient([{ type: "text", text: "Hej" }], "end_turn");
    const res = await createAnthropicBrief({ apiKey: "x", model: "m", client }).write(REQUEST);
    expect(res.toolInput).toBeNull();
  });

  it("ger null när svaret kapades vid max_tokens", async () => {
    const { client } = fakeClient(
      [{ type: "tool_use", id: "t1", name: BRIEF_TOOL_NAME, input: { igar: "a" } }],
      "max_tokens",
    );
    const res = await createAnthropicBrief({ apiKey: "x", model: "m", client }).write(REQUEST);
    expect(res.toolInput).toBeNull();
  });
});
