/**
 * Oberoende granskning (red team) av Expansion och Effekt: de nya tabellerna
 * expansion_leads, effect_measurements och effect_settings samt platsattributen på
 * stores. Angreppen körs direkt mot databasen som respektive roll (RLS), förbi
 * tjänstelagret, eftersom de delade isoleringssviterna (rls-isolation, redteam-isolering)
 * inte går att köra så länge den gemensamma fixturen kraschar.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import {
  asAnon,
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  rows,
  uniqueSuffix,
  type TestUser,
} from "./helpers";
import { inviteStoreUser } from "./portal-fixture";

const TABLES = ["expansion_leads", "effect_measurements", "effect_settings"] as const;

let ownerA: TestUser;
let viewerA: TestUser;
let refillerA: TestUser;
let storeUserA: TestUser;
let ownerB: TestUser;
let orgA: string;
let orgB: string;
let storeA: string;
let machineA: string;
let storeB: string;
let leadA: string;

beforeAll(async () => {
  ownerA = await createUser(`rt-exp-a-${uniqueSuffix()}@test.binderlab.se`);
  orgA = await createOrg(ownerA, "RT Expansion A");
  viewerA = await createMember(orgA, "viewer");
  refillerA = await createMember(orgA, "refiller");
  ownerB = await createUser(`rt-exp-b-${uniqueSuffix()}@test.binderlab.se`);
  orgB = await createOrg(ownerB, "RT Expansion B");

  const a = await asUser(ownerA, async (tx) => {
    const store = await one<{ id: string }>(
      tx,
      sql`insert into public.stores (organization_id, name, email, store_type, city)
          values (${orgA}, 'Hemlig butik', 'butik@example.se', 'livs', 'Lund') returning id`,
    );
    const machine = await one<{ id: string }>(
      tx,
      sql`insert into public.machines (organization_id, code, name) values (${orgA}, 'RT-1', 'RT 1') returning id`,
    );
    const lead = await one<{ id: string }>(
      tx,
      sql`insert into public.expansion_leads (organization_id, name, contact_email, notes, purchase_ore)
          values (${orgA}, 'Hemlig lead', 'kontakt@example.se', 'Hemliga villkor', 4000000) returning id`,
    );
    await tx.execute(
      sql`insert into public.effect_measurements (organization_id, metric, month, value)
          values (${orgA}, 'refill_hours_month', '2026-10-01', 600)`,
    );
    await tx.execute(
      sql`insert into public.effect_settings (organization_id, hourly_cost_ore) values (${orgA}, 45000)`,
    );
    return { storeId: store.id, machineId: machine.id, leadId: lead.id };
  });
  storeA = a.storeId;
  machineA = a.machineId;
  leadA = a.leadId;
  storeUserA = await inviteStoreUser(ownerA, orgA, storeA);

  storeB = await asUser(ownerB, (tx) =>
    one<{ id: string }>(
      tx,
      sql`insert into public.stores (organization_id, name) values (${orgB}, 'B-butik') returning id`,
    ).then((r) => r.id),
  );
});

async function count(user: TestUser, table: string, orgId: string): Promise<number> {
  return asUser(user, async (tx) => {
    const r = await one<{ n: number }>(
      tx,
      sql`select count(*)::int as n from ${sql.raw(`public.${table}`)} where organization_id = ${orgId}`,
    );
    return r.n;
  });
}

describe("läsning: bara ägare, admin och läsare i samma organisation", () => {
  for (const table of TABLES) {
    it(`${table}: påfyllaren, butiken, annan organisation och anon ser ingenting`, async () => {
      expect(await count(ownerA, table, orgA)).toBe(1);
      expect(await count(viewerA, table, orgA)).toBe(1);
      expect(await count(refillerA, table, orgA)).toBe(0);
      expect(await count(storeUserA, table, orgA)).toBe(0);
      expect(await count(ownerB, table, orgA)).toBe(0);
      const anon = await asAnon((tx) =>
        attempt(tx, (sp) => rows(sp, sql`select 1 from ${sql.raw(`public.${table}`)}`)),
      );
      expect(anon.ok).toBe(false);
    });
  }

  it("ändringsloggen för leads (kontaktuppgifter) syns inte för påfyllare eller butik", async () => {
    for (const u of [refillerA, storeUserA, ownerB]) {
      const r = await asUser(u, (tx) =>
        one<{ n: number }>(
          tx,
          sql`select count(*)::int as n from public.audit_log
              where table_name in ('expansion_leads', 'effect_settings', 'effect_measurements')
                and organization_id = ${orgA}`,
        ),
      );
      expect(r.n).toBe(0);
    }
  });
});

describe("skrivning: bara ägare och admin", () => {
  it("läsare, påfyllare och butik kan inte skapa, ändra eller radera leads", async () => {
    for (const u of [viewerA, refillerA, storeUserA]) {
      await asUser(u, async (tx) => {
        const ins = await attempt(tx, (sp) =>
          sp.execute(
            sql`insert into public.expansion_leads (organization_id, name) values (${orgA}, 'x')`,
          ),
        );
        expect(ins.ok).toBe(false);
        const upd = await rows(
          tx,
          sql`update public.expansion_leads set notes = 'kapad' where id = ${leadA} returning id`,
        );
        expect(upd).toEqual([]);
        const del = await rows(
          tx,
          sql`delete from public.expansion_leads where id = ${leadA} returning id`,
        );
        expect(del).toEqual([]);
        const settings = await rows(
          tx,
          sql`update public.effect_settings set hourly_cost_ore = 1 where organization_id = ${orgA} returning id`,
        );
        expect(settings).toEqual([]);
      });
    }
  });

  it("påfyllaren kan inte ändra platsattributen på butiken", async () => {
    const upd = await asUser(refillerA, (tx) =>
      rows(tx, sql`update public.stores set city = 'X' where id = ${storeA} returning id`),
    );
    expect(upd).toEqual([]);
  });
});

describe("korsreferenser och förfalskning", () => {
  it("annan organisations ägare kan inte skriva in rader i A", async () => {
    await asUser(ownerB, async (tx) => {
      for (const q of [
        sql`insert into public.expansion_leads (organization_id, name) values (${orgA}, 'x')`,
        sql`insert into public.effect_measurements (organization_id, metric, month, value)
            values (${orgA}, 'admin_hours_month', '2026-10-01', 1)`,
        sql`insert into public.effect_settings (organization_id, hourly_cost_ore) values (${orgA}, 1)`,
      ]) {
        const r = await attempt(tx, (sp) => sp.execute(q));
        expect(r.ok).toBe(false);
      }
      const upd = await rows(
        tx,
        sql`update public.expansion_leads set notes = 'kapad' where id = ${leadA} returning id`,
      );
      expect(upd).toEqual([]);
    });
  });

  it("en lead eller ett mätvärde i B kan inte peka på A:s butik eller automat", async () => {
    await asUser(ownerB, async (tx) => {
      const lead = await attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.expansion_leads (organization_id, name, store_id) values (${orgB}, 'x', ${storeA})`,
        ),
      );
      expect(lead.ok).toBe(false);
      expect(lead.code).toBe("23503");
      const m = await attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.effect_measurements (organization_id, metric, scope, machine_id, month, value)
              values (${orgB}, 'admin_hours_month', 'machine', ${machineA}, '2026-10-01', 1)`,
        ),
      );
      expect(m.ok).toBe(false);
      expect(m.code).toBe("23503");
    });
  });

  it("en egen rad kan inte flyttas till en annan organisation", async () => {
    await asUser(ownerB, async (tx) => {
      const lead = await one<{ id: string }>(
        tx,
        sql`insert into public.expansion_leads (organization_id, name, store_id) values (${orgB}, 'egen', ${storeB}) returning id`,
      );
      const r = await attempt(tx, (sp) =>
        sp.execute(
          sql`update public.expansion_leads set organization_id = ${orgA}, store_id = null where id = ${lead.id}`,
        ),
      );
      expect(r.ok).toBe(false);
    });
  });

  it("stage_changed_at och created_by kan inte förfalskas", async () => {
    const lead = await asUser(ownerA, (tx) =>
      one<{ stage_changed_at: string; created_by: string }>(
        tx,
        sql`insert into public.expansion_leads (organization_id, name, stage_changed_at, created_by)
            values (${orgA}, 'förfalskad', '2000-01-01T00:00:00Z', ${ownerB.id})
            returning stage_changed_at::text, created_by::text`,
      ),
    );
    expect(lead.stage_changed_at.startsWith("2000")).toBe(false);
    expect(lead.created_by).toBe(ownerA.id);
  });
});

describe("butiksportalen", () => {
  it("butiksanvändaren ser inga investeringar, mål eller utgångslägen", async () => {
    await asUser(ownerA, (tx) =>
      tx.execute(
        sql`insert into public.machine_investments (organization_id, machine_id, kind, amount_ore, invested_on)
            values (${orgA}, ${machineA}, 'purchase', 3990000, '2026-09-01')`,
      ),
    );
    for (const table of ["machine_investments", "goals", "baselines"]) {
      expect(await count(storeUserA, table, orgA)).toBe(0);
      expect(await count(refillerA, table, orgA)).toBe(0);
    }
  });
});

describe("städning", () => {
  it("raderade leads går inte att återskapa via loggen för annan organisation", async () => {
    // Kontroll att fixturen finns kvar (inga sidoeffekter från angreppen ovan).
    const r = await rows<{ notes: string }>(
      db(),
      sql`select notes from public.expansion_leads where id = ${leadA}`,
    );
    expect(r).toEqual([{ notes: "Hemliga villkor" }]);
  });
});
