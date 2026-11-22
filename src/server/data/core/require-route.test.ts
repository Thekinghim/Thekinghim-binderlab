/**
 * requireRoute för sidor: en butiksanvändare (rollen store, utan approll) som öppnar en
 * appsida utanför appens layout, t.ex. /rapport/varde, skickas till /portal i stället för
 * att få AuthorizationError (HTTP 500). Övriga utan organisation får felet som förut, och
 * en medlem utan behörighet skickas till sin startsida med ?nekad=.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  organizations: [] as Array<Record<string, unknown>>,
  storeUser: false,
}));

vi.mock("server-only", () => ({}));
vi.mock("react", () => ({ cache: <F>(fn: F) => fn }));
vi.mock("next/cache", () => ({ revalidatePath: () => {}, unstable_cache: <F>(fn: F) => fn }));
vi.mock("next/headers", () => ({ headers: async () => new Headers() }));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw new Error(`REDIRECT:${url}`);
  },
  unstable_rethrow: () => {},
}));
vi.mock("@/server/auth/flows", () => ({ ACTIVE_ORG_COOKIE: "bl_org" }));
vi.mock("@/server/auth/next-cookies", () => ({
  nextCookieJar: async () => ({ get: () => undefined }),
}));
vi.mock("@/server/session", () => {
  class AuthorizationError extends Error {
    constructor(
      readonly code: string,
      message?: string,
    ) {
      super(message ?? code);
    }
  }
  return {
    AuthorizationError,
    getSessionUser: async () => ({ userId: "u1", email: "u@example.test" }),
    requireUser: async () => ({ userId: "u1", email: "u@example.test" }),
  };
});
vi.mock("@/server/access", () => ({ withUserDbFor: async () => null }));
vi.mock("@/server/portal/session", () => ({
  redirectStoreUserToPortal: async () => {
    if (state.storeUser) throw new Error("REDIRECT:/portal");
  },
}));
vi.mock("@/server/simple-view-guard", () => ({ guardSimpleView: async () => {} }));
vi.mock("@/server/settlements/cache", () => ({
  cachedUnpaidSettlements: async () => [],
  invalidateUnpaidSettlements: () => {},
}));
vi.mock("@/server/settlements/queries", () => ({ queryUnpaidSettlements: async () => [] }));
vi.mock("./loaders", () => ({
  loadOrganizationsFor: async () => ({ organizations: state.organizations, machineCounts: {} }),
  verifiedViewer: <V>(v: V) => v,
  loadContextFor: async (viewer: { organization: { role: string } }) => ({
    role: viewer.organization.role,
  }),
  loadDataStartFor: async () => null,
}));

async function routeFor(id: "varde" | "hem") {
  const { requireRoute } = await import("./index");
  return requireRoute(id);
}

describe("requireRoute", () => {
  beforeEach(() => {
    vi.resetModules();
    state.organizations = [];
    state.storeUser = false;
  });

  it("skickar en butiksanvändare utan approll till /portal", async () => {
    state.storeUser = true;
    await expect(routeFor("varde")).rejects.toThrow("REDIRECT:/portal");
  });

  it("kastar AuthorizationError för övriga utan organisation, som förut", async () => {
    await expect(routeFor("varde")).rejects.toThrow("Du är inte medlem i någon organisation.");
  });

  it("skickar en medlem utan behörighet till startsidan med ?nekad=", async () => {
    state.organizations = [{ id: "o1", name: "Org", slug: "org", timezone: "UTC", role: "viewer" }];
    await expect(routeFor("varde")).rejects.toThrow("REDIRECT:/?nekad=varde");
  });

  it("släpper in en roll som får se rutten", async () => {
    state.organizations = [{ id: "o1", name: "Org", slug: "org", timezone: "UTC", role: "owner" }];
    await expect(routeFor("varde")).resolves.toEqual({ role: "owner" });
  });
});
