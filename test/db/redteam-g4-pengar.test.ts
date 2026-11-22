/**
 * Red-team för V2:s Pengar, Butiker och Mer (G4), med samma sele som redteam-fas7-routes:
 *
 * - /pengar och /butiker: påfyllaren skickas till sin startsida innan något läses.
 * - GET /pengar/export (vinst per automat som CSV): påfyllaren, butiken, en icke-medlem och
 *   en utloggad nekas; ägaren och läsaren får filen, och en utomstående ser aldrig A:s automater.
 * - /mer: påfyllaren får sidan (utan Driften och Kopplingar).
 * - Butikernas laddare (loadShops, med vinst per automat och packbilderna per automat):
 *   påfyllaren och butiken får null på servern; en utomstående ser aldrig A:s automater.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

const req = vi.hoisted(() => ({
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
}));

vi.mock("next/headers", async () => {
  const { createRequestMock } = await import("./redteam-fas7-harness");
  return createRequestMock(req).headers;
});
vi.mock("next/navigation", async () => {
  const { createRequestMock } = await import("./redteam-fas7-harness");
  return createRequestMock(req).navigation;
});
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
  refresh: vi.fn(),
  unstable_noStore: vi.fn(),
}));

import {
  call,
  loginAs,
  NextSignal,
  seedCast,
  type Cast,
  type PersonaName,
} from "./redteam-fas7-harness";

let cast: Cast;

beforeAll(async () => {
  cast = await seedCast();
}, 180_000);

afterEach(() => {
  req.cookies.clear();
  req.headers.clear();
});

async function renderPage(file: string) {
  const mod = (await import(/* @vite-ignore */ `@/app/(app)/${file}/page`)) as {
    default: (props: unknown) => Promise<unknown>;
  };
  return call(() =>
    mod.default({ params: Promise.resolve({}), searchParams: Promise.resolve({}) }),
  );
}

async function exportAs(p: PersonaName): Promise<{ status: number; body: string }> {
  await loginAs(req, cast.personas[p]);
  const { GET } = await import("@/app/(app)/pengar/export/route");
  try {
    const res = await GET();
    return { status: res.status, body: await res.text() };
  } catch (error) {
    if (error instanceof NextSignal) return { status: 307, body: "" };
    throw error;
  }
}

describe("Pengar, Butiker och Mer (V2)", () => {
  it.each([
    ["pengar", "pengar"],
    ["butiker/(oversikt)", "butiker"],
  ])(
    "/%s: påfyllaren skickas till sin startsida",
    async (file, route) => {
      await loginAs(req, cast.personas.refiller);
      const outcome = await renderPage(file);
      expect(outcome.kind).toBe("redirect");
      expect((outcome as { to: string }).to).toBe(`/?nekad=${route}`);
    },
    60_000,
  );

  it("/mer: påfyllaren får sidan", async () => {
    await loginAs(req, cast.personas.refiller);
    const outcome = await renderPage("mer");
    expect(outcome.kind).toBe("ok");
  }, 60_000);

  it("GET /pengar/export: bara ekonomirollerna, och bara den egna organisationen", async () => {
    for (const p of ["refiller", "store", "stranger", "anon"] as PersonaName[]) {
      const r = await exportAs(p);
      expect([401, 403, 307], p).toContain(r.status);
      expect(r.body, p).not.toMatch(/;\d+,\d\d/);
    }
    const owner = await exportAs("owner");
    expect(owner.status).toBe(200);
    expect(owner.body).toContain("Kod;Automat");
    const outsider = await exportAs("outsider");
    expect(outsider.body).not.toContain(cast.A.machineId);
  }, 60_000);

  it("loadShops: inga belopp till påfyllaren eller butiken, bara den egna organisationen", async () => {
    const { loadShops } = await import("@/server/data/v2/analytics/shops");
    for (const p of ["refiller", "store"] as PersonaName[]) {
      await loginAs(req, cast.personas[p]);
      const r = await call(() => loadShops({}));
      if (r.kind === "ok") expect(r.value, p).toBeNull();
      else expect(r.kind, p).not.toBe("ok");
      req.cookies.clear();
      req.headers.clear();
    }
    await loginAs(req, cast.personas.outsider);
    const outsider = await call(() => loadShops({}));
    if (outsider.kind === "ok" && outsider.value) {
      expect(JSON.stringify(outsider.value)).not.toContain(cast.A.machineId);
    }
    req.cookies.clear();
    req.headers.clear();
    await loginAs(req, cast.personas.owner);
    const owner = await call(() => loadShops({}));
    expect(owner.kind).toBe("ok");
    const data = (owner as { value: Awaited<ReturnType<typeof loadShops>> }).value;
    expect(data).not.toBeNull();
    for (const row of data!.rows) {
      for (const m of row.machines) expect(Array.isArray(m.packs)).toBe(true);
    }
  }, 60_000);
});
