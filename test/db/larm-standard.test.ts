/**
 * Ägaren ska höra när något går sönder (robusthet 1B, punkt 1):
 *
 * - Ägare och admin får en larmprenumeration när medlemskapet skapas eller rollen höjs
 *   (trigger på memberships); läsare och påfyllare får ingen förrän de sparar en själva.
 *   En rad som finns rörs inte (den som stängt av sina larm förblir avstängd).
 * - En ägare utan rad (raden borttagen) får ändå utskick: larmjobbet använder standarden.
 * - Vakten säger "Ingen får larm just nu" när ingen ägare eller admin har en kanal som
 *   fungerar, larmar om det (watch:larm-nar-ingen) och stänger larmet när någon nås.
 * - Listan på Drift räknar utskick som gått fram, inte aviseringar.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { raiseAndNotify } from "@/server/monitoring/failures";
import { loadWatchFacts, syncWatchAlerts, watchFor } from "@/server/monitoring/watch";

import {
  asPostgres,
  createMember,
  createOrg,
  createUser,
  db,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const NOW = new Date("2026-11-19T12:00:00Z");
/** Produktionen: ingen e-postleverantör (utkorgen går inte att skriva till på Vercel). */
const PROD = { VERCEL: "1", APP_ENV: "production", NODE_ENV: "production" } as const;
/** Som produktionen, men med push påslaget (VAPID-nycklar). */
const PROD_PUSH = {
  ...PROD,
  VAPID_PUBLIC_KEY: "x".repeat(40),
  VAPID_PRIVATE_KEY: "y".repeat(40),
  VAPID_SUBJECT: "mailto:drift@binderlab.example",
};

let owner: TestUser;
let orgId: string;

async function subscription(org: string, userId: string) {
  return rows<{ channels: string[]; active: boolean; min_severity: string; quiet_start: string }>(
    db(),
    sql`select channels, active, min_severity::text, quiet_start
        from public.alert_subscriptions
        where organization_id = ${org}::uuid and user_id = ${userId}::uuid`,
  );
}

async function deliveriesFor(org: string, userId: string): Promise<number> {
  const [r] = await rows<{ n: number }>(
    db(),
    sql`select count(*)::int as n from public.alert_deliveries
        where organization_id = ${org}::uuid and user_id = ${userId}::uuid`,
  );
  return Number(r?.n ?? 0);
}

async function openWatchAlerts(org: string): Promise<string[]> {
  return (
    await rows<{ incident_key: string }>(
      db(),
      sql`select incident_key from public.alerts
          where organization_id = ${org}::uuid and status = 'open'
            and incident_key like 'watch:%' order by incident_key`,
    )
  ).map((r) => r.incident_key);
}

beforeAll(async () => {
  owner = await createUser(`larm-agare-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(owner, `Larm standard ${uniqueSuffix()}`);
});

describe("standardprenumerationen", () => {
  it("ägaren får en rad när organisationen skapas: push och e-post, varning, tyst 22–07", async () => {
    expect(await subscription(orgId, owner.id)).toEqual([
      { channels: ["push", "email"], active: true, min_severity: "warning", quiet_start: "22:00" },
    ]);
  });

  it("en ny admin får en rad, en läsare och en påfyllare får ingen", async () => {
    const admin = await createMember(orgId, "admin");
    const viewer = await createMember(orgId, "viewer");
    const refiller = await createMember(orgId, "refiller");
    expect(await subscription(orgId, admin.id)).toHaveLength(1);
    expect(await subscription(orgId, viewer.id)).toHaveLength(0);
    expect(await subscription(orgId, refiller.id)).toHaveLength(0);
  });

  it("en läsare som blir admin får raden då", async () => {
    const member = await createMember(orgId, "viewer");
    await asPostgres((tx) =>
      tx.execute(
        sql`update public.memberships set role = 'admin'
            where organization_id = ${orgId}::uuid and user_id = ${member.id}::uuid`,
      ),
    );
    expect(await subscription(orgId, member.id)).toHaveLength(1);
  });

  it("den som har stängt av sina larm förblir avstängd när rollen ändras", async () => {
    const member = await createMember(orgId, "admin");
    await asPostgres(async (tx) => {
      await tx.execute(
        sql`update public.alert_subscriptions set active = false, channels = array['push']
            where organization_id = ${orgId}::uuid and user_id = ${member.id}::uuid`,
      );
      await tx.execute(
        sql`update public.memberships set role = 'viewer'
            where organization_id = ${orgId}::uuid and user_id = ${member.id}::uuid`,
      );
      await tx.execute(
        sql`update public.memberships set role = 'admin'
            where organization_id = ${orgId}::uuid and user_id = ${member.id}::uuid`,
      );
    });
    expect(await subscription(orgId, member.id)).toMatchObject([
      { channels: ["push"], active: false },
    ]);
  });

  it("en ägare utan rad får ändå utskicket (larmjobbet använder standarden)", async () => {
    const u = await createUser(`larm-utan-rad-${uniqueSuffix()}@test.binderlab.se`);
    const org = await createOrg(u, `Larm utan rad ${uniqueSuffix()}`);
    await asPostgres((tx) =>
      tx.execute(sql`delete from public.alert_subscriptions where organization_id = ${org}::uuid`),
    );
    expect(await subscription(org, u.id)).toHaveLength(0);
    await raiseAndNotify(db(), {
      organizationId: org,
      kind: "job_failed",
      key: "job:prov",
      severity: "critical",
      title: "Provlarm",
      detail: "Ett jobb gick sönder.",
      rule: "Prov.",
      link: "/drift",
      now: NOW,
    });
    expect(await deliveriesFor(org, u.id)).toBe(1);
  });
});

describe("ingen får larm just nu", () => {
  it("produktionens läge: e-post går inte att skicka och ingen har en enhet", async () => {
    const lines = await watchFor(db(), orgId, NOW, PROD_PUSH);
    const line = lines.find((l) => l.key === "larm-nar-ingen");
    expect(line?.title).toBe("Ingen får larm just nu");
    expect(line?.detail).toBe(
      "Larmen syns bara här i appen. Slå på notiser på din telefon, så får du dem direkt.",
    );
  });

  it("med en e-post som fungerar nås ägaren: ingen rad", async () => {
    const lines = await watchFor(db(), orgId, NOW, { MAIL_PROVIDER: "outbox" });
    expect(lines.find((l) => l.key === "larm-nar-ingen")).toBeUndefined();
  });

  it("larmet skapas en gång, och stängs när ägaren har slagit på notiser på en enhet", async () => {
    const u = await createUser(`larm-vakt-${uniqueSuffix()}@test.binderlab.se`);
    const org = await createOrg(u, `Larm vakt ${uniqueSuffix()}`);
    await syncWatchAlerts(db(), org, NOW, PROD_PUSH);
    await syncWatchAlerts(db(), org, NOW, PROD_PUSH);
    expect((await openWatchAlerts(org)).filter((k) => k === "watch:larm-nar-ingen")).toEqual([
      "watch:larm-nar-ingen",
    ]);

    // Ägaren slår på notiser på sin telefon: en enhet.
    await asPostgres(async (tx) => {
      await tx.execute(
        sql`insert into public.push_subscriptions
              (organization_id, user_id, endpoint, p256dh, auth_secret)
            values (${org}::uuid, ${u.id}::uuid,
                    ${`https://fcm.googleapis.com/fcm/send/${uniqueSuffix()}`},
                    ${"p".repeat(87)}, ${"a".repeat(22)})`,
      );
    });
    const facts = await loadWatchFacts(db(), org, PROD_PUSH);
    expect(facts?.facts.reach?.members).toMatchObject([{ devices: 1, active: true }]);
    await syncWatchAlerts(db(), org, NOW, PROD_PUSH);
    expect((await openWatchAlerts(org)).includes("watch:larm-nar-ingen")).toBe(false);
  });

  it("en demo vaktas inte: där skickas aldrig något", async () => {
    const u = await createUser(`larm-demo-${uniqueSuffix()}@test.binderlab.se`);
    const org = await createOrg(u, `Larm demo ${uniqueSuffix()}`);
    await asPostgres((tx) =>
      tx.execute(sql`update public.organizations set is_demo = true where id = ${org}::uuid`),
    );
    expect(await watchFor(db(), org, NOW, PROD)).toEqual([]);
  });
});
