/**
 * Rollen och organisationslistan läses en gång per förfrågan (React cache i
 * serverkomponenter), inte en gång per laddare: varje läsning är en egen transaktion mot
 * databasen. Här står React cache för förfrågans minne och withRls räknas.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const calls = vi.hoisted(() => ({ n: 0 }));
const ORG = "11111111-1111-4111-8111-111111111111";

vi.mock("react", () => ({
  // Som React cache under en förfrågan: samma argument ger samma löfte.
  cache: <A extends unknown[], R>(fn: (...args: A) => R) => {
    const memo = new Map<string, R>();
    return (...args: A): R => {
      const key = JSON.stringify(args);
      if (!memo.has(key)) memo.set(key, fn(...args));
      return memo.get(key) as R;
    };
  },
}));

vi.mock("@/db/client", () => ({
  withRls: async (_claims: unknown, fn: (tx: unknown) => Promise<unknown>) => {
    calls.n += 1;
    return fn({
      execute: async () => [
        {
          id: ORG,
          name: "Binderlab",
          slug: "binderlab",
          timezone: "Europe/Stockholm",
          role: "owner",
          machines: 1,
        },
      ],
    });
  },
}));

const user = { userId: "22222222-2222-4222-8222-222222222222", email: "agare@binderlab.local" };

describe("läsningar en gång per förfrågan", () => {
  beforeEach(() => {
    calls.n = 0;
  });

  it("rollen läses en gång, hur många laddare som än frågar", async () => {
    const { getRoleFor, requireRoleFor } = await import("./access");
    expect(await getRoleFor(user, ORG)).toBe("owner");
    expect(await getRoleFor(user, ORG.toUpperCase())).toBe("owner");
    expect(await requireRoleFor(user, ORG, ["owner", "admin"])).toBe("owner");
    expect(calls.n).toBe(1);
  });

  it("skalet och den aktiva organisationen delar organisationslistan", async () => {
    const { listOrganizationsFor, listOrganizationsWithMachinesFor, resolveActiveOrganization } =
      await import("./access");
    const withCounts = await listOrganizationsWithMachinesFor({ ...user, email: "x@y.se" });
    const plain = await listOrganizationsFor({ ...user, email: "x@y.se" });
    const active = await resolveActiveOrganization({ ...user, email: "x@y.se" }, ORG);
    expect(withCounts[0]?.machines).toBe(1);
    expect(plain[0]).toEqual({
      id: ORG,
      name: "Binderlab",
      slug: "binderlab",
      timezone: "Europe/Stockholm",
      role: "owner",
    });
    expect(active?.id).toBe(ORG);
    expect(calls.n).toBe(1);
    // En anropare som ändrar sin lista ändrar inte nästas.
    plain.pop();
    expect(await listOrganizationsFor({ ...user, email: "x@y.se" })).toHaveLength(1);
  });
});
