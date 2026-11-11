/**
 * Butikens felanmälan plingar direkt (runda 2, T4-2) mot testdatabasen:
 *
 * - butiksanvändaren felanmäler i portalen (den riktiga server-actionen): i samma anrop går
 *   en push till ägare, admin och automatens ansvariga, med butikens namn och felet,
 * - ägare och admin får länken till ärendet i Inkorgen; påfyllaren (som inte får öppna
 *   ärenden) får butikens nummer i texten och länken till Fyll på,
 * - läsare, butiksanvändare, andra organisationer, den med Enkel vy och den som stängt av
 *   Notiser får ingenting,
 * - en enhet som inte finns längre stängs av, och ett fel i utskicket stoppar inte anmälan.
 */

import { mkdtempSync } from "node:fs";
import { readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

import { notifyFaultReported } from "@/server/portal/fault-push";
import type { PushPayload, PushSender, PushTarget } from "@/server/notify/push";

import { asPostgres, db, one, rows, type TestUser } from "./helpers";
import { loginAs, seedCast, type Cast } from "./redteam-fas7-harness";

// Push skrivs till en egen katalog (outbox), inget lämnar maskinen.
const OUTBOX = mkdtempSync(path.join(tmpdir(), "fel-push-"));
process.env.PUSH_PROVIDER = "outbox";
process.env.PUSH_OUTBOX_DIR = OUTBOX;

const endpointOf = (name: string) => `https://fcm.googleapis.com/fcm/send/${name}`;

async function device(orgId: string, user: TestUser, name: string): Promise<void> {
  await asPostgres((tx) =>
    tx.execute(
      sql`insert into public.push_subscriptions (organization_id, user_id, endpoint, p256dh, auth_secret)
          values (${orgId}::uuid, ${user.id}::uuid, ${endpointOf(name)}, ${"p".repeat(40)}, ${"a".repeat(16)})`,
    ),
  );
}

async function outbox(): Promise<{ to: string; payload: PushPayload }[]> {
  const dir = path.join(OUTBOX, "push");
  let files: string[] = [];
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  } catch {
    return [];
  }
  const out: { to: string; payload: PushPayload }[] = [];
  for (const f of files) {
    const parsed = JSON.parse(await readFile(path.join(dir, f), "utf8")) as {
      endpoint: string;
      payload: PushPayload;
    };
    out.push({ to: parsed.endpoint.split("/").pop() ?? "", payload: parsed.payload });
  }
  return out.sort((a, b) => a.to.localeCompare(b.to));
}

let cast: Cast;
let report: (input: Record<string, unknown>) => Promise<{ ok: boolean; id?: string }>;

beforeAll(async () => {
  cast = await seedCast();
  const mod = await import("@/server/portal/actions");
  report = mod.reportFault as typeof report;
  const p = cast.personas;
  await device(cast.A.orgId, p.owner.user!, "owner");
  await device(cast.A.orgId, p.admin.user!, "admin");
  await device(cast.A.orgId, p.refiller.user!, "refiller");
  await device(cast.A.orgId, p.viewer.user!, "viewer");
  await device(cast.A.orgId, cast.storeUser, "store");
  await device(cast.B.orgId, cast.B.owner, "other-org");
  await asPostgres(async (tx) => {
    await tx.execute(
      sql`update public.stores set name = 'Sega gubben', phone = '040-12 34 56'
          where id = ${cast.A.storeId}::uuid`,
    );
    // Ägaren har Notiser på (organisationens ägare börjar med bara e-post).
    await tx.execute(
      sql`insert into public.alert_subscriptions (organization_id, user_id, channels, active)
          values (${cast.A.orgId}::uuid, ${p.owner.user!.id}::uuid, array['push', 'email'], true)
          on conflict (organization_id, user_id) do update set channels = array['push', 'email'], active = true`,
    );
    // Påfyllaren är automatens ansvariga.
    await tx.execute(
      sql`update public.machines set responsible_user_id = ${p.refiller.user!.id}::uuid
          where id = ${cast.A.machineId}::uuid`,
    );
  });
}, 180_000);

beforeEach(async () => {
  await rm(path.join(OUTBOX, "push"), { recursive: true, force: true });
});

describe("butikens felanmälan plingar direkt", () => {
  it("portalens formulär: en push i samma anrop till ägare, admin och ansvarig", async () => {
    await loginAs(req, cast.personas.store);
    const r = await report({
      storeId: cast.A.storeId,
      machineId: cast.A.machineId,
      kind: "store_payment",
      description: "Kortläsaren svarar inte",
    });
    expect(r.ok).toBe(true);
    const id = r.id!;
    // Ärendet finns (som förut) ...
    const incident = await one<{ kind: string }>(
      db(),
      sql`select kind from public.incidents where id = ${id}::uuid`,
    );
    expect(incident.kind).toBe("store_payment");
    // ... och notiserna är redan skickade när anropet svarar.
    const sent = await outbox();
    expect(sent.map((s) => s.to)).toEqual(["admin", "owner", "refiller"]);
    const forOwner = sent.find((s) => s.to === "owner")!.payload;
    expect(forOwner).toEqual({
      title: "Sega gubben: Betalningen fungerar inte",
      body: "Butiken har felanmält automaten. Tryck för att ringa butiken.",
      url: `/inkorg/${id}`,
      tag: `fel-${id}`,
      severity: "critical",
    });
    expect(sent.find((s) => s.to === "admin")!.payload).toEqual(forOwner);
    // Påfyllaren får inte öppna ärenden: numret står i texten, länken går till Fyll på.
    expect(sent.find((s) => s.to === "refiller")!.payload).toEqual({
      title: "Sega gubben: Betalningen fungerar inte",
      body: "Butiken har felanmält automaten. Ring butiken: 040-12 34 56.",
      url: `/fyll-pa/${cast.A.machineId}`,
      tag: `fel-${id}`,
      severity: "critical",
    });
  });

  it("påfyllaren som inte är ansvarig, Enkel vy och avstängda Notiser får ingenting", async () => {
    const p = cast.personas;
    await asPostgres(async (tx) => {
      await tx.execute(
        sql`update public.machines set responsible_user_id = null where id = ${cast.A.machineId}::uuid`,
      );
      await tx.execute(
        sql`update public.memberships set view_mode = 'simple'
            where organization_id = ${cast.A.orgId}::uuid and user_id = ${p.admin.user!.id}::uuid`,
      );
    });
    await loginAs(req, cast.personas.store);
    const r = await report({
      storeId: cast.A.storeId,
      machineId: cast.A.machineId,
      kind: "store_stuck",
    });
    expect(r.ok).toBe(true);
    expect((await outbox()).map((s) => [s.to, s.payload.title])).toEqual([
      ["owner", "Sega gubben: Ett pack fastnade"],
    ]);

    // Ägaren stänger av Notiser: ingen får något, och anmälan går ändå igenom.
    await asPostgres((tx) =>
      tx.execute(
        sql`insert into public.alert_subscriptions (organization_id, user_id, channels, active)
            values (${cast.A.orgId}::uuid, ${p.owner.user!.id}::uuid, array['email'], true)
            on conflict (organization_id, user_id) do update set channels = array['email']`,
      ),
    );
    await rm(path.join(OUTBOX, "push"), { recursive: true, force: true });
    const quiet = await report({
      storeId: cast.A.storeId,
      machineId: cast.A.machineId,
      kind: "store_screen",
    });
    expect(quiet.ok).toBe(true);
    expect(await outbox()).toEqual([]);
    expect(await notifyFaultReported(db(), quiet.id!)).toEqual({
      sent: 0,
      failed: 0,
      skipped: "no_devices",
    });
    await asPostgres((tx) =>
      tx.execute(
        sql`update public.alert_subscriptions set channels = array['push', 'email']
            where organization_id = ${cast.A.orgId}::uuid and user_id = ${p.owner.user!.id}::uuid`,
      ),
    );
  });

  it("utan telefonnummer: 'Tryck för att öppna ärendet.'; en borttagen enhet stängs av", async () => {
    await asPostgres((tx) =>
      tx.execute(sql`update public.stores set phone = null where id = ${cast.A.storeId}::uuid`),
    );
    await device(cast.A.orgId, cast.personas.owner.user!, "owner-gammal");
    await loginAs(req, cast.personas.store);
    const r = await report({
      storeId: cast.A.storeId,
      machineId: cast.A.machineId,
      kind: "store_empty",
    });
    const seen: { to: string; payload: PushPayload }[] = [];
    const sender: PushSender = {
      kind: "outbox",
      async send(target: PushTarget, payload: PushPayload) {
        const to = target.endpoint.split("/").pop() ?? "";
        if (to === "owner-gammal") return { ok: false, gone: true, detail: "HTTP 410" };
        seen.push({ to, payload });
        return { ok: true, detail: "test" };
      },
    };
    const out = await notifyFaultReported(db(), r.id!, { sender });
    expect(out).toEqual({ sent: 1, failed: 0, skipped: null });
    expect(seen).toHaveLength(1);
    expect(seen[0]!.payload.body).toBe(
      "Butiken har felanmält automaten. Tryck för att öppna ärendet.",
    );
    const state = await rows<{ endpoint: string; off: boolean }>(
      db(),
      sql`select endpoint, disabled_at is not null as off from public.push_subscriptions
          where organization_id = ${cast.A.orgId}::uuid and user_id = ${cast.personas.owner.user!.id}::uuid
          order by endpoint`,
    );
    expect(state.map((s) => [s.endpoint.split("/").pop(), s.off])).toEqual([
      ["owner", false],
      ["owner-gammal", true],
    ]);
  });

  it("ett vanligt kundärende (inte från butiken) och ett okänt id ger ingen notis; fel kastar inte", async () => {
    const other = await one<{ id: string }>(
      db(),
      sql`insert into public.incidents (organization_id, machine_id, kind, started_at)
          values (${cast.A.orgId}::uuid, ${cast.A.machineId}::uuid, 'not_delivered', now())
          returning id`,
    );
    expect((await notifyFaultReported(db(), other.id)).skipped).toBe("not_store_fault");
    expect((await notifyFaultReported(db(), "00000000-0000-4000-8000-000000000000")).skipped).toBe(
      "not_found",
    );
    // Ogiltigt id: frågan misslyckas, men funktionen kastar inte.
    expect(await notifyFaultReported(db(), "inte-ett-id")).toEqual({
      sent: 0,
      failed: 0,
      skipped: null,
    });
    expect(await outbox()).toEqual([]);
  });
});
