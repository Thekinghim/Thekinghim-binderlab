/**
 * Rättningsrundan, område 3 (Att göra, AI-förslag, delägaren) mot testdatabasen:
 *
 *   - "Klar" på en påfyllning döljer den bara tills läget ändras: en försäljning till
 *     (saldot) eller en registrerad påfyllning tar upp den igen. En inventering (Awish)
 *     räknas inte som påfyllning (lastRefilledAt), varken i Att göra eller på automatsidan.
 *   - "Bjud in delägaren" så länge bara ett konto finns.
 *   - AI-förslag från en körning före en ändring av inköpspriser, inställningar eller
 *     avtal visas inte, och en ny körning får göras fast dagens knapptryck är slut.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { dismissTodoFor, registerRefillFor } from "@/app/(app)/att-gora/_lib/service";
import * as s from "@/db/schema";
import { withUserDbFor } from "@/server/access";
import type { AdvisorModel } from "@/server/assistant/advisor/model";
import {
  loadAdvisorStateFor,
  MANUAL_RUNS_PER_DAY,
  runAdvisor,
} from "@/server/assistant/advisor/service";
import type { Snapshot } from "@/server/assistant/advisor/snapshot";
import { loadTodosFor, type Viewer } from "@/server/data/core/loaders";
import { queryStock } from "@/server/data/core/queries";

import { viewerFor } from "./assistent-fixture";
import {
  addMember,
  asUser,
  createOrg,
  createUser,
  db,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

/** Mitt på dagen 14 mars 2025; fönstret för takten är 28 feb.–13 mars. */
const NOW = new Date("2025-03-14T11:00:00Z");

interface Fixture {
  orgId: string;
  owner: TestUser;
  machineId: string;
  locationId: string;
  titleId: string;
  sourceId: string;
}

let fx: Fixture;
let owner: Viewer;
let seq = 0;

/** En order (och därmed en försäljning i lagret) för titeln i automaten. */
async function sell(at: string): Promise<void> {
  seq += 1;
  await asUser(fx.owner, (tx) =>
    tx.insert(s.orders).values({
      organizationId: fx.orgId,
      dataSourceId: fx.sourceId,
      externalId: `ratt3-${seq}`,
      rawTitle: "Mystery Pack",
      titleId: fx.titleId,
      orderedAt: new Date(at),
      amountOre: 8900,
      paymentMethod: "card",
      machineId: fx.machineId,
      sourceHash: `ratt3-${seq}`,
    }),
  );
}

async function seed(): Promise<Fixture> {
  const user = await createUser(`ratt3-${uniqueSuffix()}@test.binderlab.se`);
  const orgId = await createOrg(user, `Rättning 3 ${uniqueSuffix()}`);
  return asUser(user, async (tx) => {
    const org = { organizationId: orgId };
    const [store] = await tx
      .insert(s.stores)
      .values({ ...org, name: "Sega gubben" })
      .returning();
    const [machine] = await tx
      .insert(s.machines)
      .values({ ...org, code: "BL-001", name: "BL-001", activeFrom: "2025-02-01" })
      .returning();
    await tx
      .insert(s.machinePlacements)
      .values({ ...org, machineId: machine!.id, storeId: store!.id, validFrom: "2025-02-01" });
    const [title] = await tx
      .insert(s.titles)
      .values({ ...org, name: "Mystery Pack" })
      .returning();
    await tx
      .insert(s.purchasePrices)
      .values({ ...org, titleId: title!.id, unitCostOre: 5000, validFrom: "2025-01-01" });
    const [source] = await tx
      .insert(s.dataSources)
      .values({
        ...org,
        provider: "awish_grpc",
        name: "Awish",
        lastSyncedAt: new Date(NOW.getTime() - 30 * 60 * 1000),
      })
      .returning();
    const location = (await tx.select().from(s.stockLocations)).find(
      (l) => l.organizationId === orgId && l.machineId === machine!.id,
    );
    return {
      orgId,
      owner: user,
      machineId: machine!.id,
      locationId: location!.id,
      titleId: title!.id,
      sourceId: source!.id,
    };
  });
}

beforeAll(async () => {
  fx = await seed();
  owner = await viewerFor(fx.owner, fx.orgId);
  // 4 pack per dag i 14 dagar (28 feb.–13 mars), sedan en inventering (Awish) med 4 kvar:
  // räcker 1,0 dag → Akut, som Mystery Pack på BL-001 den 4 nov.
  for (let d = 0; d < 14; d++) {
    const date = new Date(Date.UTC(2025, 1, 28 + d, 10, 0));
    for (let i = 0; i < 4; i++) await sell(new Date(date.getTime() + i * 60_000).toISOString());
  }
  await asUser(fx.owner, (tx) =>
    tx.insert(s.stockEvents).values({
      organizationId: fx.orgId,
      locationId: fx.locationId,
      titleId: fx.titleId,
      kind: "count",
      quantity: 4,
      occurredAt: new Date("2025-03-14T07:20:00Z"),
    }),
  );
});

const refillKey = () => `refill:${fx.machineId}:${fx.titleId}`;

describe("påfyllning: senast påfylld är en påfyllning, inte en inventering", () => {
  it("bara en inventering: lastRefilledAt saknas (men lastRestockedAt finns)", async () => {
    const rows = await withUserDbFor({ userId: fx.owner.id, email: fx.owner.email }, (tx) =>
      queryStock(tx, fx.orgId),
    );
    const row = rows.find((r) => r.machineId === fx.machineId && r.titleId === fx.titleId);
    expect(row?.onHand).toBe(4);
    expect(row?.lastRestockedAt).not.toBeNull();
    expect(row?.lastRefilledAt).toBeNull();
  });
});

describe("Att göra: Klar döljer en påfyllning bara tills läget ändras", () => {
  it("Akut står under I dag; avbockad döljs; nästa försäljning tar upp den igen", async () => {
    const before = await loadTodosFor(owner, NOW);
    const item = before.find((t) => t.key === refillKey());
    expect(item?.level).toBe("now");

    const dismissed = await dismissTodoFor(
      owner,
      { key: item!.key, fingerprint: item!.fingerprint },
      NOW,
    );
    expect(dismissed.ok).toBe(true);
    expect((await loadTodosFor(owner, NOW)).some((t) => t.key === refillKey())).toBe(false);

    // Ett pack till säljs (Awish), ingen påfyllning registrerad: punkten är tillbaka.
    await sell("2025-03-14T09:00:00Z");
    const after = await loadTodosFor(owner, NOW);
    expect(after.find((t) => t.key === refillKey())?.level).toBe("now");
  });

  it("en registrerad påfyllning sätter lastRefilledAt och ändrar fingerprint", async () => {
    const [item] = (await loadTodosFor(owner, NOW)).filter((t) => t.key === refillKey());
    expect(
      (
        await registerRefillFor(owner, {
          machineId: fx.machineId,
          titleId: fx.titleId,
          quantity: 1,
          fromWarehouse: false,
        })
      ).ok,
    ).toBe(true);
    const rows = await withUserDbFor({ userId: fx.owner.id, email: fx.owner.email }, (tx) =>
      queryStock(tx, fx.orgId),
    );
    const row = rows.find((r) => r.machineId === fx.machineId && r.titleId === fx.titleId);
    expect(row?.lastRefilledAt).not.toBeNull();
    const [again] = (await loadTodosFor(owner, NOW)).filter((t) => t.key === refillKey());
    expect(again?.fingerprint).not.toBe(item?.fingerprint);
  });
});

describe("Att göra: Bjud in delägaren", () => {
  it("bara ett konto: punkten finns och länkar till inbjudan; borta med ett andra konto", async () => {
    const alone = (await loadTodosFor(owner, NOW)).find((t) => t.kind === "team");
    expect(alone).toMatchObject({
      title: "Bjud in delägaren",
      link: "/installningar/anvandare?bjud-in=1",
    });

    // En väntande inbjudan: påminnelse i stället.
    await db().execute(
      sql`insert into public.invitations (organization_id, email, role, token_hash, expires_at)
          values (${fx.orgId}, ${`deläg-${uniqueSuffix()}@test.binderlab.se`}, 'owner',
                  ${randomUUID().replace(/-/g, "").repeat(2)}, now() + interval '7 days')`,
    );
    expect((await loadTodosFor(owner, NOW)).find((t) => t.kind === "team")?.title).toBe(
      "Påminn delägaren om inbjudan",
    );

    const partner = await createUser(`deläg-${uniqueSuffix()}@test.binderlab.se`);
    await addMember(fx.orgId, partner, "admin");
    expect((await loadTodosFor(owner, NOW)).some((t) => t.kind === "team")).toBe(false);
    // Delägaren (admin) får inte heller punkten.
    const partnerViewer = await viewerFor(partner, fx.orgId);
    expect((await loadTodosFor(partnerViewer, NOW)).some((t) => t.kind === "team")).toBe(false);
  });
});

describe("AI-förslag: gamla siffror visas inte", () => {
  const ENV = { ANTHROPIC_API_KEY: "test", AI_MONTHLY_BUDGET_SEK: "1000" };
  const model: AdvisorModel = {
    model: "claude-sonnet-5-5",
    async propose(request) {
      const snap = JSON.parse(request.snapshot) as Snapshot;
      const top = snap.titlar[0]!;
      return {
        stopReason: "tool_use",
        model: "claude-sonnet-5-5",
        usage: { inputTokens: 10, outputTokens: 10, cacheReadTokens: 0, cacheWriteTokens: 0 },
        toolInput: {
          forslag: [
            {
              titel: `Satsa på ${top.titel}`,
              varfor: `${top.titel} gav ${top.vinst30} i vinst på ${top.order30} order.`,
              atgard: `Lägg ${top.titel} i fler fack.`,
              effekt_kr_per_manad: 50,
              sakerhet: "medel",
            },
          ],
        },
      };
    },
  };

  it("ett nytt inköpspris efter körningen döljer förslagen och öppnar en ny körning", async () => {
    for (let i = 0; i < MANUAL_RUNS_PER_DAY; i++) {
      const r = await runAdvisor({ viewer: owner, trigger: "manual", now: NOW, env: ENV, model });
      expect(r.status).toBe("ok");
    }
    const fresh = await loadAdvisorStateFor(owner, NOW);
    expect(fresh!.suggestions.length).toBeGreaterThan(0);
    expect(fresh!.staleCount).toBe(0);
    expect(fresh!.suggestions[0]!.dataDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    // Dagens knapptryck är slut.
    expect(
      (await runAdvisor({ viewer: owner, trigger: "manual", now: NOW, env: ENV, model })).status,
    ).toBe("rate-limited");

    // Inköpspriset ändras (som 115 → 140 kr för 30th Celebration).
    await asUser(fx.owner, (tx) =>
      tx.insert(s.purchasePrices).values({
        organizationId: fx.orgId,
        titleId: fx.titleId,
        unitCostOre: 6000,
        validFrom: "2025-03-01",
      }),
    );
    const stale = await loadAdvisorStateFor(owner, NOW);
    expect(stale!.suggestions).toHaveLength(0);
    expect(stale!.staleCount).toBeGreaterThan(0);
    expect(stale!.manualLeft).toBeGreaterThan(0);

    // En ny körning får göras, och dess förslag visas.
    const again = await runAdvisor({ viewer: owner, trigger: "manual", now: NOW, env: ENV, model });
    expect(again.status).toBe("ok");
    const after = await loadAdvisorStateFor(owner, NOW);
    expect(after!.suggestions.length).toBeGreaterThan(0);
    expect(after!.staleCount).toBeGreaterThan(0);
  });
});
