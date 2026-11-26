/**
 * Delar som laddas vid behov (./lazy-part.ts): koden hämtas en gång, ett misslyckat försök
 * görs om, och en redan hämtad del ritas direkt (ingen Suspense, ingen väntan).
 */

import { createElement } from "react";
import { renderToString } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { lazyPart } from "./lazy-part";

function Hello({ name }: { name: string }) {
  return createElement("p", null, `Hej ${name}`);
}

describe("lazyPart", () => {
  it("hämtar koden en gång, även vid flera samtidiga anrop", async () => {
    const loader = vi.fn(async () => Hello);
    const part = lazyPart(loader);
    const [a, b] = await Promise.all([part.load(), part.load()]);
    expect(a).toBe(Hello);
    expect(b).toBe(Hello);
    await part.load();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("försöker igen efter ett misslyckat försök", async () => {
    const loader = vi
      .fn<() => Promise<typeof Hello>>()
      .mockRejectedValueOnce(new Error("nätet"))
      .mockResolvedValue(Hello);
    const part = lazyPart(loader);
    await expect(part.load()).rejects.toThrow("nätet");
    await expect(part.load()).resolves.toBe(Hello);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("ritar ingenting innan koden finns och delen direkt när den är hämtad", async () => {
    const part = lazyPart(async () => Hello);
    expect(renderToString(createElement(part.Component, { name: "Ada" }))).toBe("");
    await part.load();
    expect(renderToString(createElement(part.Component, { name: "Ada" }))).toBe("<p>Hej Ada</p>");
  });
});
