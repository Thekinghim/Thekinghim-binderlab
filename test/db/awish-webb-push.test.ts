/**
 * Push av påfyllningar till Awishs webbpanel (src/server/awish/web-service.ts) mot
 * testdatabasen och en lokal låtsas-panel:
 *
 *  - inloggningen sparas krypterat (Vault) och går att slå på/av; bara ägare och admin,
 *  - en påfyllning höjer rätt fack i Awish till Binderlabs antal,
 *  - ett fack som Awish redan har högre antal i rörs inte (vi sänker aldrig),
 *  - push avstängd eller utan inloggning gör ingenting,
 *  - en okopplad automat rapporteras, inte som fel.
 *
 * Testet når aldrig riktiga Awish: webb-klienten pekas mot låtsas-panelen.
 */

import { sql } from "drizzle-orm";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import * as s from "../../src/db/schema";
import { listOrganizationsFor } from "../../src/server/access";
import type { Viewer } from "../../src/server/data/core/loaders";

import {
  asPostgres,
  asUser,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  type TestUser,
} from "./helpers";

vi.mock("server-only", () => ({}));

// Hämta modulerna efter server-only-mocken (de importerar manage → server-only).
const {
  previewAwishPushFor,
  saveAwishCredentialsFor,
  saveAwishWebCredentialsFor,
  setAwishWebPushFor,
  testAwishWebLoginFor,
} = await import("../../src/server/awish/manage");
const { startFakeAwishWeb } = await import("../../src/server/awish/testing/fake-web-server");
type FakeWeb = Awaited<ReturnType<typeof startFakeAwishWeb>>;
const { createAwishWebClient } = await import("../../src/server/awish/web-client");
const { pushMachinesToAwish } = await import("../../src/server/awish/web-service");

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let fake: FakeWeb;
const webClientOptions = () => ({ baseUrl: fake.baseUrl, now: () => 1_762_250_000_000 });
const makeWebClient = (o: Parameters<typeof createAwishWebClient>[0] = {}) =>
  createAwishWebClient({ ...o, baseUrl: fake.baseUrl, now: () => 1_762_250_000_000 });

let owner: TestUser;
let orgId: string;
let sourceId: string;
let machineId: string;
let locationId: string;

/**
 * Sätter Binderlabs saldo för en titel i automaten genom en inventering (count-händelse);
 * stock_levels är en vy över append-only-händelserna, så den kan inte skrivas direkt.
 */
async function setLevel(titleName: string, quantity: number): Promise<void> {
  await asPostgres(async (tx) => {
    const existing = await tx.execute(
      sql`select id from public.titles where organization_id = ${orgId}::uuid and lower(name) = lower(${titleName})`,
    );
    let titleId = (Array.from(existing)[0] as { id?: string } | undefined)?.id;
    if (!titleId) {
      const ins = await tx.execute(
        sql`insert into public.titles (organization_id, name) values (${orgId}::uuid, ${titleName}) returning id`,
      );
      titleId = (Array.from(ins)[0] as { id: string }).id;
    }
    await tx.execute(sql`
      insert into public.stock_events
        (organization_id, location_id, title_id, kind, quantity, occurred_at, note)
      values (${orgId}::uuid, ${locationId}::uuid, ${titleId}::uuid, 'count', ${quantity}, now(), 'test')`);
  });
}

beforeAll(async () => {
  owner = await createUser();
  orgId = await createOrg(owner);
  const [machine] = await asUser(owner, (tx) =>
    tx
      .insert(s.machines)
      .values({
        organizationId: orgId,
        code: "BL-001",
        name: "Sega gubben",
        activeFrom: "2026-10-01",
      })
      .returning(),
  );
  machineId = machine!.id;
  locationId = (
    await one<{ id: string }>(
      db(),
      sql`select id from public.stock_locations where machine_id = ${machineId}::uuid`,
    )
  ).id;
  // AppId/AppSecret/AppKey (gRPC) måste finnas: webb-inloggningen hänger på samma källa.
  ({ dataSourceId: sourceId } = await saveAwishCredentialsFor(await viewerFor(owner, orgId), {
    appId: "app",
    appSecret: "secret",
    appKey: "key",
  }));
  // Koppla Binderlab-automaten till Awishs maskin-id 1001 (låtsas-panelens automat).
  await db().execute(sql`
    insert into public.source_machines (organization_id, data_source_id, external_id, external_name)
    values (${orgId}::uuid, ${sourceId}::uuid, '1001', 'Sega gubben')
    on conflict (organization_id, data_source_id, external_id)
    do update set machine_id = ${machineId}::uuid`);
  await db().execute(sql`
    update public.source_machines set machine_id = ${machineId}::uuid
    where data_source_id = ${sourceId}::uuid and external_id = '1001'`);
});

beforeEach(async () => {
  fake = await startFakeAwishWeb({
    products: {
      "1001": [
        {
          id: 11,
          goodId: 5,
          goodName: "30th Celebration",
          status: true,
          currentInventory: 2,
          capacity: 10,
          channelName: "A1",
        },
        {
          id: 12,
          goodId: 6,
          goodName: "Mystery Pack",
          status: true,
          currentInventory: 8,
          capacity: 10,
          channelName: "A2",
        },
      ],
    },
  });
});

afterEach(async () => {
  await fake.stop();
});

describe("Awish webb-inloggning och push", () => {
  it("bara ägare och admin får spara inloggningen", async () => {
    const refiller = await createMember(orgId, "refiller");
    await expect(
      saveAwishWebCredentialsFor(await viewerFor(refiller, orgId), {
        email: fake.state.email,
        password: fake.state.password,
      }),
    ).rejects.toBeTruthy();
  });

  it("sparar inloggningen, testar den och slår på push", async () => {
    const viewer = await viewerFor(owner, orgId);
    await saveAwishWebCredentialsFor(viewer, {
      email: fake.state.email,
      password: fake.state.password,
    });
    const test = await testAwishWebLoginFor(viewer, {
      makeWebClient,
      webClientOptions: webClientOptions(),
    });
    expect(test.ok, test.message).toBe(true);
    const r = await setAwishWebPushFor(viewer, true);
    expect(r.enabled).toBe(true);
  });

  it("push avstängd gör ingenting", async () => {
    const viewer = await viewerFor(owner, orgId);
    // Inloggningen kan vara sparad av ett annat test (delad databas): slå uttryckligen av.
    await saveAwishWebCredentialsFor(viewer, {
      email: fake.state.email,
      password: fake.state.password,
    });
    await setAwishWebPushFor(viewer, false);
    const result = await pushMachinesToAwish(orgId, [machineId], {
      serviceDb: db(),
      makeClient: makeWebClient,
      clientOptions: webClientOptions(),
    });
    expect(result.status).toBe("off");
    expect(result.reason).toBe("disabled");
  });

  it("höjer rätt fack till Binderlabs antal, rör inte fack som redan har mer", async () => {
    const viewer = await viewerFor(owner, orgId);
    await saveAwishWebCredentialsFor(viewer, {
      email: fake.state.email,
      password: fake.state.password,
    });
    await setAwishWebPushFor(viewer, true);
    // Binderlab efter påfyllning: 9 av 30th Celebration (Awish har 2 → höj till 9),
    // 5 av Mystery Pack (Awish har 8 → rör inte).
    await setLevel("30th Celebration", 9);
    await setLevel("Mystery Pack", 5);

    const result = await pushMachinesToAwish(orgId, [machineId], {
      serviceDb: db(),
      makeClient: makeWebClient,
      clientOptions: webClientOptions(),
    });
    expect(result.status).toBe("done");
    expect(result.machines[0]?.status).toBe("pushed");
    expect(result.machines[0]?.slotsUpdated).toBe(1);
    expect(fake.state.products["1001"]?.find((p) => p.id === 11)?.currentInventory).toBe(9);
    expect(fake.state.products["1001"]?.find((p) => p.id === 12)?.currentInventory).toBe(8);
  });

  it("rapporterar en automat som inte är kopplad i Awish", async () => {
    const viewer = await viewerFor(owner, orgId);
    await saveAwishWebCredentialsFor(viewer, {
      email: fake.state.email,
      password: fake.state.password,
    });
    await setAwishWebPushFor(viewer, true);
    const [other] = await asUser(owner, (tx) =>
      tx
        .insert(s.machines)
        .values({
          organizationId: orgId,
          code: "BL-009",
          name: "Okopplad",
          activeFrom: "2026-10-01",
        })
        .returning(),
    );
    const result = await pushMachinesToAwish(orgId, [other!.id], {
      serviceDb: db(),
      makeClient: makeWebClient,
      clientOptions: webClientOptions(),
    });
    expect(result.machines[0]?.status).toBe("no_awish_machine");
  });

  it("provkörning läser och räknar men skriver aldrig, även när push är av", async () => {
    const viewer = await viewerFor(owner, orgId);
    await saveAwishWebCredentialsFor(viewer, {
      email: fake.state.email,
      password: fake.state.password,
    });
    await setAwishWebPushFor(viewer, false);
    await setLevel("30th Celebration", 9);
    const r = await previewAwishPushFor(viewer, {
      serviceDb: db(),
      makeWebClient,
      webClientOptions: webClientOptions(),
    });
    expect(r.ok, r.message).toBe(true);
    const planned = r.machines.flatMap((m) => m.planned);
    expect(planned).toContainEqual({ titleName: "30th Celebration", from: 2, to: 9 });
    expect(fake.state.calls.some((c) => c.operationName === "UpdateProduct")).toBe(false);
    expect(fake.state.products["1001"]?.find((p) => p.id === 11)?.currentInventory).toBe(2);
  });
});
