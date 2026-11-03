import { describe, expect, it } from "vitest";

import { assistantConfigFrom } from "./config";
import { contextBlock, systemBlocks, SYSTEM_INSTRUCTIONS } from "./prompt";

describe("assistantConfigFrom", () => {
  it("utan nyckel: inte konfigurerad, med vad som saknas", () => {
    expect(assistantConfigFrom({})).toEqual({
      status: "not-configured",
      message: "Assistenten kräver ANTHROPIC_API_KEY.",
      missing: ["ANTHROPIC_API_KEY"],
    });
    expect(assistantConfigFrom({ ANTHROPIC_API_KEY: "   " }).status).toBe("not-configured");
  });

  it("med nyckel: Claude API med claude-opus-5-5 som standard", () => {
    expect(assistantConfigFrom({ ANTHROPIC_API_KEY: "sk-ant-test" })).toEqual({
      status: "ready",
      provider: "anthropic",
      model: "claude-opus-5-5",
      apiKey: "sk-ant-test",
      effort: "high",
    });
  });

  it("ANTHROPIC_MODEL_CHAT går före ANTHROPIC_MODEL, och insatsen kan sänkas", () => {
    expect(
      assistantConfigFrom({
        ANTHROPIC_API_KEY: "k",
        ANTHROPIC_MODEL: "claude-opus-5-5",
        ANTHROPIC_MODEL_CHAT: "claude-sonnet-5-5",
        ANTHROPIC_EFFORT_CHAT: "medium",
      }),
    ).toMatchObject({ status: "ready", model: "claude-sonnet-5-5", effort: "medium" });
    expect(
      assistantConfigFrom({ ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL_CHAT: "claude-x" }),
    ).toMatchObject({ status: "invalid", variable: "ANTHROPIC_MODEL_CHAT" });
    expect(
      assistantConfigFrom({ ANTHROPIC_API_KEY: "k", ANTHROPIC_EFFORT_CHAT: "max" }),
    ).toMatchObject({ status: "invalid", variable: "ANTHROPIC_EFFORT_CHAT" });
  });

  it("ANTHROPIC_MODEL kan vara claude-sonnet-5-5 men inget annat", () => {
    expect(
      assistantConfigFrom({ ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "claude-sonnet-5-5" }),
    ).toMatchObject({ status: "ready", model: "claude-sonnet-5-5" });
    expect(assistantConfigFrom({ ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "gpt-4" })).toMatchObject(
      {
        status: "invalid",
        variable: "ANTHROPIC_MODEL",
      },
    );
  });

  it("den lokala testmodellen bara i development och tester", () => {
    expect(
      assistantConfigFrom({ ASSISTANT_PROVIDER: "local", APP_ENV: "development" }),
    ).toMatchObject({
      status: "ready",
      provider: "local",
    });
    expect(
      assistantConfigFrom({ ASSISTANT_PROVIDER: "local", NODE_ENV: "test", APP_ENV: "preview" })
        .status,
    ).toBe("ready");
    expect(
      assistantConfigFrom({ ASSISTANT_PROVIDER: "local", APP_ENV: "production" }),
    ).toMatchObject({
      status: "invalid",
      variable: "ASSISTANT_PROVIDER",
    });
    expect(
      assistantConfigFrom({
        ASSISTANT_PROVIDER: "local",
        APP_ENV: "development",
        NODE_ENV: "production",
      }).status,
    ).toBe("invalid");
    expect(assistantConfigFrom({ ASSISTANT_PROVIDER: "openai" }).status).toBe("invalid");
  });
});

describe("systemprompten", () => {
  it("kräver att alla tal kommer från verktygen", () => {
    expect(SYSTEM_INSTRUCTIONS).toContain("Varje tal i ditt svar ska stå i ett verktygsresultat");
    expect(SYSTEM_INSTRUCTIONS).toContain("Räkna inte själv");
  });

  it("sammanhanget har organisation, roll, veckodag och datum", () => {
    const text = contextBlock({
      organizationName: "Binderlab",
      role: "refiller",
      today: "2026-11-02",
      timeZone: "Europe/Stockholm",
      dataStart: "2026-10-13",
    });
    expect(text).toContain("Organisation: Binderlab.");
    expect(text).toContain("måndag 2026-11-02");
    expect(text).toContain("påfyllare");
    expect(text).toContain("Du har bara lagerverktyg");
  });

  it("första blocket är detsamma för alla (cachas)", () => {
    const a = systemBlocks({
      organizationName: "A",
      role: "owner",
      today: "2026-11-02",
      timeZone: "UTC",
      dataStart: null,
    });
    const b = systemBlocks({
      organizationName: "B",
      role: "viewer",
      today: "2026-11-03",
      timeZone: "UTC",
      dataStart: null,
    });
    expect(a[0]).toEqual(b[0]);
    expect(a[1]).not.toEqual(b[1]);
  });
});
