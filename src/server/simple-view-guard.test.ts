/**
 * Enkel vy: spärren gäller allt som läser den aktiva organisationen, inte bara laddarna i
 * @/server/data/core. Route handlers som /sok (sökningen), /assistent/fraga (assistenten),
 * /installningar/export (all data) och avtals- och bokföringsfilerna läser organisationen
 * via getActiveOrganization (eller currentViewer, som använder den). En medlem med enkel
 * vy som skriver in en sådan adress ska skickas till sin startsida, inte få datan.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

import type * as Access from "./access";

const state = vi.hoisted(() => ({
  pathname: null as string | null,
  viewMode: "simple" as "simple" | "full",
  role: "owner" as "owner" | "admin" | "refiller" | "viewer",
}));

vi.mock("server-only", () => ({}));
vi.mock("react", () => ({ cache: <F>(fn: F) => fn }));
vi.mock("next/headers", () => ({
  headers: async () =>
    new Headers(state.pathname === null ? {} : { "x-bl-pathname": state.pathname }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
}));
vi.mock("./auth", () => ({
  getAuthProvider: async () => ({
    getSession: async () => ({ userId: "22222222-2222-4222-8222-222222222222", email: "d@x.se" }),
  }),
}));
vi.mock("./auth/next-cookies", () => ({ nextCookieJar: async () => ({ get: () => undefined }) }));
vi.mock("./access", async (importOriginal) => ({
  ...(await importOriginal<typeof Access>()),
  resolveActiveOrganization: async () => ({
    id: "11111111-1111-4111-8111-111111111111",
    name: "Binderlab",
    slug: "binderlab",
    timezone: "Europe/Stockholm",
    role: state.role,
    viewMode: state.viewMode,
  }),
}));

async function activeAt(pathname: string | null) {
  state.pathname = pathname;
  const { getActiveOrganization } = await import("./session");
  return getActiveOrganization();
}

describe("Enkel vy i getActiveOrganization (route handlers, server actions)", () => {
  beforeEach(() => {
    state.viewMode = "simple";
    state.role = "owner";
  });

  it.each([
    "/sok",
    "/assistent/fraga",
    "/installningar/export",
    "/avtal/x/fil",
    "/ekonomi",
    // Utbetalningen till butikerna (/butiker?vy=utbetalning: proxyn skickar /butiker).
    "/butiker",
    "/butiker/3f1c9a2e-0b7d-4c55-9e8a-1a2b3c4d5e6f",
    "/installningar/anvandare",
    // Lagret är tillåtet, men bara exakt Lager, Inköpslistan och Inköpspriserna.
    "/vart-lager/flytta",
    "/inkopspriser/ny-produkt",
    "/inkopspriser/ny-produkt/bild",
    "/lonsamhet",
    "/avtal",
    "/rapporter",
  ])("%s skickas till den enkla vyns startsida", async (path) => {
    await expect(activeAt(path)).rejects.toThrow("REDIRECT:/");
  });

  it("påfyllaren med enkel vy skickas till Fyll på", async () => {
    state.role = "refiller";
    await expect(activeAt("/sok")).rejects.toThrow("REDIRECT:/fyll-pa");
  });

  it.each([
    "/",
    "/fyll-pa",
    "/fyll-pa/abc",
    "/vart-lager/mystery",
    "/forsaljning",
    // Delägaren köper in: Lager (antal, leverans in), Inköpslistan och Inköpspriserna. Server
    // actions på de sidorna (setHomeCount, addReceipt, addPurchasePrice …) har sidans sökväg.
    "/vart-lager",
    "/prognos",
    "/inkopspriser",
  ])("%s är tillåten", async (path) => {
    expect((await activeAt(path))?.viewMode).toBe("simple");
  });

  it("full vy och anrop utan sökväg (cron, skript) påverkas inte", async () => {
    expect((await activeAt(null))?.id).toBeDefined();
    state.viewMode = "full";
    expect((await activeAt("/sok"))?.viewMode).toBe("full");
  });
});
