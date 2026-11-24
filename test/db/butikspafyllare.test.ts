/**
 * Påfyllare i butiken (rollen machine_refiller): ser bara sina automater genom
 * staff_my_machines/staff_fill_data, kan fylla på och ångra bara där, ser 0 rader i
 * appens tabeller och vyer, och stängs av direkt i databasen. Plus ägarens flöde
 * (src/server/data/machine-staff.ts) och inloggningen (src/server/auth/phone-login.ts).
 * Inga riktiga butiksuppgifter: allt är påhittat.
 */

import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { createRateLimiter } from "../../src/server/rate-limit";
import {
  createMachineStaff,
  listMachineStaff,
  resetStaffPin,
  rotateStaffQr,
  setStaffDisabled,
  setStaffMachines,
  type StaffDeps,
} from "../../src/server/data/machine-staff";
import {
  PHONE_LOGIN_ERROR,
  QR_LOGIN_ERROR,
  checkOwnPin,
  qrAccountName,
  signInWithPhonePin,
  staffSessionState,
} from "../../src/server/auth/phone-login";
import { listOrganizationsFor } from "../../src/server/access";

import {
  asPostgres,
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  db,
  one,
  publicTables,
  publicViews,
  rel,
  rows,
  type TestUser,
} from "./helpers";

const tables = await publicTables();
const views = await publicViews();

let orgId: string;
let owner: TestUser;
let m1: string;
let m2: string;
let title1: string;
let title2: string;
let otherOrg: string;
let otherOwner: TestUser;
let otherMachine: string;
let staff: TestUser;
let staffPin: string;
let storeWarehouse: string;

const deleted: string[] = [];
const banned = new Map<string, boolean>();
const deps: StaffDeps = {
  db,
  provider: {
    async createSystemUser(email) {
      return (await createUser(email)).id;
    },
    async deleteUser(id) {
      deleted.push(id);
      await db().execute(sql`delete from auth.users where id = ${id}::uuid`);
    },
    async setUserBanned(id, b) {
      banned.set(id, b);
    },
  },
};

async function machine(org: string, code: string): Promise<string> {
  return asPostgres(async (tx) => {
    const m = await one<{ id: string }>(
      tx,
      sql`insert into public.machines (organization_id, code, name, active_from)
          values (${org}, ${code}, ${`Automat ${code}`}, '2025-01-01') returning id`,
    );
    const store = await one<{ id: string }>(
      tx,
      sql`insert into public.stores (organization_id, name) values (${org}, ${`Testbutik ${code}`}) returning id`,
    );
    await tx.execute(sql`insert into public.machine_placements (organization_id, machine_id, store_id, valid_from)
      values (${org}, ${m.id}, ${store.id}, '2025-01-01')`);
    return m.id;
  });
}

function phone(): string {
  return `070${String(Math.floor(Math.random() * 1e7)).padStart(7, "0")}`;
}

function refill(
  user: TestUser,
  org: string,
  machineId: string,
  titleId: string,
  qty: number,
  fromLocation: string | null = null,
) {
  return asUser(user, (tx) =>
    attempt(tx, (sp) =>
      one<{ stock_event_id: string }>(
        sp,
        sql`select * from public.register_refill_once(${org}::uuid, ${randomUUID()}::uuid, ${machineId}::uuid,
              ${titleId}::uuid, ${qty}::integer, true, null, null, ${fromLocation}::uuid)`,
      ),
    ),
  );
}

beforeAll(async () => {
  owner = await createUser();
  orgId = await createOrg(owner, "Fixtur butikspåfyll");
  m1 = await machine(orgId, "BL-901");
  m2 = await machine(orgId, "BL-902");
  otherOwner = await createUser();
  otherOrg = await createOrg(otherOwner, "Annan org");
  otherMachine = await machine(otherOrg, "BL-903");
  const titles = await asPostgres(async (tx) => {
    const t1 = await one<{ id: string }>(
      tx,
      sql`insert into public.titles (organization_id, name) values (${orgId}, 'Testpack Ett') returning id`,
    );
    const t2 = await one<{ id: string }>(
      tx,
      sql`insert into public.titles (organization_id, name) values (${orgId}, 'Testpack Två') returning id`,
    );
    await tx.execute(sql`insert into public.purchase_prices (organization_id, title_id, unit_cost_ore, valid_from)
      values (${orgId}, ${t1.id}, 4500, '2025-01-01')`);
    // Awish-läsning: 3 av 10 och 8 av 8.
    await tx.execute(
      sql`update public.stock_locations set awish_fill = ${JSON.stringify([
        { title_id: t1.id, units: 3, capacity: 10, channels: 1, empty: 0 },
        { title_id: t2.id, units: 8, capacity: 8, channels: 1, empty: 0 },
      ])}::jsonb, awish_synced_at = now() where organization_id = ${orgId} and machine_id = ${m1}`,
    );
    return [t1.id, t2.id];
  });
  title1 = titles[0]!;
  title2 = titles[1]!;
  const created = await createMachineStaff(
    { userId: owner.id, email: owner.email },
    orgId,
    { name: "Testperson", phone: phone(), machineIds: [m1] },
    deps,
  );
  if (!created.ok) throw new Error(created.error);
  staff = { id: created.userId, email: "staff" };
  staffPin = created.pin;
});

describe("ägaren skapar kontot", () => {
  it("ger medlemskap machine_refiller, profil, automat och en hashad PIN-kod", async () => {
    const m = await one<{ role: string; n: number; name: string; hash: string; must: boolean }>(
      db(),
      sql`select m.role::text as role,
                 (select count(*)::int from private.membership_machines mm where mm.membership_id = m.id) as n,
                 (select display_name from public.profiles p where p.user_id = m.user_id) as name,
                 l.pin_hash as hash, l.must_change_pin as must
          from public.memberships m join private.phone_logins l on l.user_id = m.user_id
          where m.user_id = ${staff.id}`,
    );
    expect(m).toMatchObject({ role: "machine_refiller", n: 1, name: "Testperson", must: true });
    expect(m.hash).not.toContain(staffPin);
    expect(m.hash.startsWith("scrypt$")).toBe(true);
  });

  it("bara ägare och admin kan skapa; automat i annan organisation och dubbelt nummer nekas", async () => {
    const viewer = await createMember(orgId, "viewer");
    await expect(
      createMachineStaff(
        { userId: viewer.id, email: viewer.email },
        orgId,
        { name: "X", phone: phone(), machineIds: [m1] },
        deps,
      ),
    ).rejects.toThrow();
    const foreign = await createMachineStaff(
      { userId: owner.id, email: owner.email },
      orgId,
      { name: "X", phone: phone(), machineIds: [otherMachine] },
      deps,
    );
    expect(foreign.ok).toBe(false);
    const p = phone();
    const first = await createMachineStaff(
      { userId: owner.id, email: owner.email },
      orgId,
      { name: "A", phone: p, machineIds: [m2] },
      deps,
    );
    expect(first.ok).toBe(true);
    const dup = await createMachineStaff(
      { userId: owner.id, email: owner.email },
      orgId,
      { name: "B", phone: p, machineIds: [m2] },
      deps,
    );
    expect(dup).toEqual({ ok: false, error: "Det finns redan ett konto med det numret." });
  });

  it("ett fel i ett steg raderar användaren igen", async () => {
    const before = deleted.length;
    // Automaten finns (kontrollen passerar) men tas bort innan raden skrivs: FK-fel.
    const failing: StaffDeps = {
      ...deps,
      provider: {
        ...deps.provider,
        async createSystemUser(email) {
          const id = (await createUser(email)).id;
          await db()
            .execute(sql`insert into private.phone_logins (user_id, phone_e164, pin_hash) values
            (${(await createUser()).id}::uuid, '+46709999999', 'scrypt$16384$8$1$xxxxxxxxxxxxxxxxxxxx$yy')
            on conflict do nothing`);
          return id;
        },
      },
    };
    const r = await createMachineStaff(
      { userId: owner.id, email: owner.email },
      orgId,
      { name: "Fel", phone: "0709999999", machineIds: [m1] },
      failing,
    );
    // Numret blev upptaget mellan kontrollen och skrivningen.
    expect(r.ok).toBe(false);
    expect(deleted.length).toBe(before + 1);
  });

  it("ägaren i en annan organisation kan inte röra kontot", async () => {
    const r = await resetStaffPin(
      { userId: otherOwner.id, email: otherOwner.email },
      otherOrg,
      staff.id,
      deps,
    );
    expect(r.ok).toBe(false);
    const list = await listMachineStaff(
      { userId: otherOwner.id, email: otherOwner.email },
      otherOrg,
      db,
    );
    expect(list).toEqual([]);
  });

  it("listan visar maskerat nummer och status", async () => {
    const list = await listMachineStaff({ userId: owner.id, email: owner.email }, orgId, db);
    const me = list.find((p) => p.userId === staff.id)!;
    expect(me.phoneMasked).toMatch(/^070-\d{3} \d{2} ··$/);
    expect(me.status).toBe("active");
    expect(me.machineIds).toEqual([m1]);
  });
});

describe("isolering", () => {
  it("kontot får ingen organisation i appen (MEMBER_ROLES)", async () => {
    expect(await listOrganizationsFor({ userId: staff.id, email: "x" })).toEqual([]);
  });

  it.each([...tables, ...views])("%s: påfyllaren ser bara sina egna rader", async (relation) => {
    const outcome = await asUser(staff, (tx) =>
      attempt(tx, (sp) =>
        rows<{ n: number }>(sp, sql`select count(*)::int as n from ${rel(relation)}`),
      ),
    );
    if (!outcome.ok) {
      expect(outcome.code).toBe("42501");
      return;
    }
    const allowed: Record<string, number> = {
      memberships: 1,
      profiles: 1,
      membership_machines: 1,
      organizations: 1,
    };
    expect(outcome.value[0]?.n).toBeLessThanOrEqual(allowed[relation] ?? 0);
  });

  it("phone_logins går inte att läsa eller ändra, membership_machines inte att skriva", async () => {
    const read = await asUser(staff, (tx) =>
      attempt(tx, (sp) => sp.execute(sql`select * from private.phone_logins`)),
    );
    expect(read.code).toBe("42501");
    const upd = await asUser(staff, (tx) =>
      attempt(tx, (sp) => sp.execute(sql`update private.phone_logins set disabled_at = null`)),
    );
    expect(upd.code).toBe("42501");
    const mid = await one<{ id: string }>(
      db(),
      sql`select id from public.memberships where user_id = ${staff.id}`,
    );
    const ins = await asUser(staff, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`insert into private.membership_machines (organization_id, membership_id, machine_id)
          values (${orgId}, ${mid.id}, ${m2})`),
      ),
    );
    expect(ins.code).toBe("42501");
  });

  it("rollen kan inte bytas från en klient (inte ens av ägaren)", async () => {
    const r = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`update public.memberships set role = 'viewer' where user_id = ${staff.id}`),
      ),
    );
    expect(r.code).toBe("42501");
  });

  it("appens RPC:er ger inget", async () => {
    for (const q of [
      sql`select * from public.list_members(${orgId}::uuid)`,
      sql`select public.create_warehouse(${orgId}::uuid, 'Hack')`,
      sql`select public.set_refill_source(${orgId}::uuid, ${m1}::uuid, null)`,
    ]) {
      const r = await asUser(staff, (tx) => attempt(tx, (sp) => rows(sp, q)));
      if (r.ok) expect(r.value).toEqual([]);
      else expect(["42501", "22023"]).toContain(r.code);
    }
  });

  it("staff_my_machines visar bara den egna automaten", async () => {
    const mine = await asUser(staff, (tx) =>
      rows<{ machine_id: string; store_name: string }>(
        tx,
        sql`select * from public.staff_my_machines()`,
      ),
    );
    expect(mine.map((m) => m.machine_id)).toEqual([m1]);
    expect(mine[0]!.store_name).toBe("Testbutik BL-901");
  });

  it("staff_fill_data: egen automat utan priser; andra automater och organisationer nekas", async () => {
    const data = await asUser(staff, (tx) =>
      one<{ d: Record<string, unknown> }>(
        tx,
        sql`select public.staff_fill_data(${orgId}::uuid, ${m1}::uuid) as d`,
      ),
    );
    const keys = JSON.stringify(data.d).match(/"([a-z_]+)":/g) ?? [];
    for (const k of keys)
      expect(k).not.toMatch(
        /pris|price|kr|sold|sales|phone|contact|email|cost|_ore|amount|revenue|profit/,
      );
    const rowsOut = data.d.rows as {
      title: string;
      units: number;
      capacity: number;
      suggested: number;
    }[];
    expect(rowsOut.find((r) => r.title === "Testpack Ett")).toMatchObject({
      units: 3,
      capacity: 10,
      suggested: 7,
    });
    expect(rowsOut.find((r) => r.title === "Testpack Två")).toMatchObject({ suggested: 0 });
    for (const [o, m] of [
      [orgId, m2],
      [otherOrg, otherMachine],
      [otherOrg, m1],
    ] as const) {
      const r = await asUser(staff, (tx) =>
        attempt(tx, (sp) => sp.execute(sql`select public.staff_fill_data(${o}::uuid, ${m}::uuid)`)),
      );
      expect(r.code).toBe("42501");
    }
  });
});

describe("påfyllning", () => {
  it("egen automat sparas med performed_by; andra automater och organisationer nekas", async () => {
    const ok = await refill(staff, orgId, m1, title1, 2);
    expect(ok.ok).toBe(true);
    const ev = await one<{ performed_by: string; note: string }>(
      db(),
      sql`select performed_by, note from public.stock_events where id = ${ok.value!.stock_event_id}`,
    );
    expect(ev.performed_by).toBe(staff.id);
    // Utan "Fylls på från" (eller standardlagret): spåras inte, inget uttag ur något lager.
    const out = await rows(
      db(),
      sql`select 1 from public.stock_events where organization_id = ${orgId}
      and kind = 'adjustment' and note like 'Uttag till påfyllning%' and performed_by = ${staff.id}`,
    );
    expect(out).toEqual([]);
    expect((await refill(staff, orgId, m2, title1, 1)).code).toBe("42501");
    expect((await refill(staff, otherOrg, otherMachine, title1, 1)).code).toBe("42501");
  });

  it("butikens lager: dras därifrån; valt lager från klienten ignoreras; fler än butiken har stoppas", async () => {
    storeWarehouse = (
      await asUser(owner, (tx) =>
        one<{ id: string }>(
          tx,
          sql`select (public.create_warehouse(${orgId}::uuid, 'Butikens lager')).id as id`,
        ),
      ).catch(async () =>
        asUser(owner, (tx) =>
          one<{ id: string }>(
            tx,
            sql`select public.create_warehouse(${orgId}::uuid, 'Butikens lager') as id`,
          ),
        ),
      )
    ).id;
    await asUser(owner, (tx) =>
      tx.execute(
        sql`select public.set_refill_source(${orgId}::uuid, ${m1}::uuid, ${storeWarehouse}::uuid)`,
      ),
    );
    const central = await one<{ id: string }>(
      db(),
      sql`select id from public.stock_locations
      where organization_id = ${orgId} and is_central`,
    );
    await asPostgres((tx) =>
      tx.execute(sql`insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at)
        values (${orgId}, ${storeWarehouse}, ${title1}, 'count', 5, now() - interval '1 hour'),
               (${orgId}, ${central.id}, ${title1}, 'count', 50, now() - interval '1 hour')`),
    );
    // Klienten ber om standardlagret: ignoreras, butikens lager används.
    const r = await refill(staff, orgId, m1, title1, 3, central.id);
    expect(r.ok).toBe(true);
    const lvl = async (loc: string) =>
      (
        await one<{ q: number }>(
          db(),
          sql`select coalesce((select quantity::int from public.stock_levels
        where location_id = ${loc} and title_id = ${title1}), 0) as q`,
        )
      ).q;
    expect(await lvl(storeWarehouse)).toBe(2);
    expect(await lvl(central.id)).toBe(50);
    // 4 > 2 kvar: stoppas (låst till det butiken har fått), inget dras.
    const short = await refill(staff, orgId, m1, title1, 4);
    expect(short.ok).toBe(false);
    expect(short.message ?? "").toContain("Du har bara 2 pack");
    expect(await lvl(storeWarehouse)).toBe(2);
    expect(await lvl(central.id)).toBe(50);
    // Testerna nedan fyller på fritt: gott om pack i butikens lager.
    await asPostgres((tx) =>
      tx.execute(sql`insert into public.stock_events (organization_id, location_id, title_id, kind, quantity, occurred_at)
        values (${orgId}, ${storeWarehouse}, ${title1}, 'count', 1000, now()),
               (${orgId}, ${storeWarehouse}, ${title2}, 'count', 1000, now())`),
    );
  });

  it("Ångra fungerar bara på egna påfyllningar", async () => {
    const clientId = randomUUID();
    await asUser(staff, (tx) =>
      tx.execute(sql`select * from public.register_refill_once(${orgId}::uuid, ${clientId}::uuid, ${m1}::uuid,
        ${title2}::uuid, 1, true, null, null, null)`),
    );
    const refiller = await createMember(orgId, "refiller");
    const foreign = randomUUID();
    await asUser(refiller, (tx) =>
      tx.execute(sql`select * from public.register_refill_once(${orgId}::uuid, ${foreign}::uuid, ${m1}::uuid,
        ${title2}::uuid, 1, false, null, null, null)`),
    );
    const bad = await asUser(staff, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`select public.undo_field_refills(${orgId}::uuid, ${`{${foreign}}`}::uuid[])`,
        ),
      ),
    );
    expect(bad.code).toBe("42501");
    const good = await asUser(staff, (tx) =>
      one<{ n: number }>(
        tx,
        sql`select public.undo_field_refills(${orgId}::uuid, ${`{${clientId}}`}::uuid[]) as n`,
      ),
    );
    expect(Number(good.n)).toBe(1);
  });

  it("avstängt konto: inga automater, ingen påfyllning, ingen inloggning", async () => {
    const off = await setStaffDisabled(
      { userId: owner.id, email: owner.email },
      orgId,
      staff.id,
      true,
      deps,
    );
    expect(off.ok).toBe(true);
    expect(banned.get(staff.id)).toBe(true);
    expect(
      await asUser(staff, (tx) => rows(tx, sql`select * from public.staff_my_machines()`)),
    ).toEqual([]);
    expect((await refill(staff, orgId, m1, title1, 1)).code).toBe("42501");
    expect((await staffSessionState(db, staff.id)).state).toBe("expired");
    await setStaffDisabled({ userId: owner.id, email: owner.email }, orgId, staff.id, false, deps);
    expect(banned.get(staff.id)).toBe(false);
    expect((await refill(staff, orgId, m1, title1, 1)).ok).toBe(true);
  });

  it("telefonen väljer aldrig tid, notering eller mer än 500 pack", async () => {
    const at = new Date(Date.now() - 3 * 86_400_000).toISOString();
    const r = await asUser(staff, (tx) =>
      one<{ stock_event_id: string }>(
        tx,
        sql`select * from public.register_refill_once(${orgId}::uuid, ${randomUUID()}::uuid, ${m1}::uuid,
              ${title2}::uuid, 1, true, ${at}::timestamptz, 'egen text', null)`,
      ),
    );
    const ev = await one<{ recent: boolean; note: string }>(
      db(),
      sql`select occurred_at > now() - interval '1 minute' as recent, note from public.stock_events
          where id = ${r.stock_event_id}`,
    );
    expect(ev.recent).toBe(true);
    expect(ev.note).not.toContain("egen text");
    expect((await refill(staff, orgId, m1, title2, 501)).code).toBe("22023");
  });

  it("ny PIN-kod: avstängt förblir avstängt; tokens från före gäller inte", async () => {
    const ownerUser = { userId: owner.id, email: owner.email };
    await setStaffDisabled(ownerUser, orgId, staff.id, true, deps);
    const reset = await resetStaffPin(ownerUser, orgId, staff.id, deps);
    expect(reset.ok && reset.disabled).toBe(true);
    expect((await staffSessionState(db, staff.id)).state).toBe("expired");
    await setStaffDisabled(ownerUser, orgId, staff.id, false, deps);
    // En token (PostgREST) utfärdad före ny PIN-kod: nekas. Utfärdad efter: släpps in.
    const asToken = (iat: number) =>
      db().transaction(async (tx) => {
        await tx.execute(
          sql`select set_config('request.jwt.claims', ${JSON.stringify({ sub: staff.id, role: "authenticated", iat })}, true), set_config('role', 'authenticated', true)`,
        );
        return rows(tx, sql`select machine_id from public.staff_my_machines()`);
      });
    const now = Math.floor(Date.now() / 1000);
    expect(await asToken(now - 3600)).toEqual([]);
    expect((await asToken(now + 5)).length).toBe(1);
  });

  it("kan inte skapa en egen organisation eller tas bort från en klient", async () => {
    const own = await asUser(staff, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`select public.create_organization('Egen', 'egen-bpf-x1')`),
      ),
    );
    expect(own.code).toBe("BL062");
    const first = await asUser(staff, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`select public.create_first_organization('Egen', 'egen-bpf-x2')`),
      ),
    );
    expect(first.code).toBe("BL062");
    const del = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`delete from public.memberships where organization_id = ${orgId}::uuid and user_id = ${staff.id}::uuid`,
        ),
      ),
    );
    expect(del.code).toBe("42501");
  });

  it("byte av automater gäller direkt", async () => {
    await setStaffMachines({ userId: owner.id, email: owner.email }, orgId, staff.id, [m2], db);
    expect((await refill(staff, orgId, m1, title1, 1)).code).toBe("42501");
    expect((await refill(staff, orgId, m2, title1, 1)).ok).toBe(true);
    const foreign = await setStaffMachines(
      { userId: owner.id, email: owner.email },
      orgId,
      staff.id,
      [otherMachine],
      db,
    );
    expect(foreign.ok).toBe(false);
    await setStaffMachines({ userId: owner.id, email: owner.email }, orgId, staff.id, [m1], db);
  });
});

describe("inloggning med mobilnummer och PIN-kod", () => {
  const limiter = () => createRateLimiter({ limit: 1000, windowMs: 60_000 });
  const signedIn: string[] = [];
  const loginDeps = (ip = limiter(), ph = limiter()) => ({
    db,
    provider: {
      async signInAsUser(id: string) {
        signedIn.push(id);
        return { userId: id, email: "x" };
      },
    },
    ipLimiter: ip,
    phoneLimiter: ph,
  });

  async function newStaff() {
    const p = phone();
    const r = await createMachineStaff(
      { userId: owner.id, email: owner.email },
      orgId,
      { name: "Login", phone: p, machineIds: [m1] },
      deps,
    );
    if (!r.ok) throw new Error(r.error);
    return { phone: p, pin: r.pin, userId: r.userId };
  }

  it("rätt PIN loggar in och nollställer; fel PIN ger samma fel som okänt nummer", async () => {
    const s = await newStaff();
    const d = loginDeps();
    const wrong = await signInWithPhonePin(d, {
      phone: s.phone,
      pin: s.pin === "135790" ? "246802" : "135790",
      ip: "1",
    });
    const unknown = await signInWithPhonePin(d, { phone: "0701111110", pin: "135790", ip: "1" });
    expect(wrong).toEqual({ ok: false, error: PHONE_LOGIN_ERROR });
    expect(unknown).toEqual(wrong);
    const ok = await signInWithPhonePin(d, { phone: s.phone, pin: s.pin, ip: "1" });
    expect(ok).toEqual({ ok: true, userId: s.userId, mustChangePin: true });
    expect(signedIn).toContain(s.userId);
    const row = await one<{ f: number; l: string | null }>(
      db(),
      sql`select failed_attempts as f, last_used_at as l from private.phone_logins where user_id = ${s.userId}`,
    );
    expect(row.f).toBe(0);
    expect(row.l).not.toBeNull();
  });

  it("5 fel låser i 15 minuter (även med rätt PIN), 10 fel ett dygn; ny PIN-kod låser upp", async () => {
    const s = await newStaff();
    const d = loginDeps();
    const bad = s.pin === "135790" ? "246802" : "135790";
    for (let i = 0; i < 5; i += 1)
      await signInWithPhonePin(d, { phone: s.phone, pin: bad, ip: "2" });
    expect((await signInWithPhonePin(d, { phone: s.phone, pin: s.pin, ip: "2" })).ok).toBe(false);
    // Låset har gått ut.
    await db().execute(
      sql`update private.phone_logins set locked_until = now() - interval '1 second' where user_id = ${s.userId}`,
    );
    for (let i = 0; i < 5; i += 1)
      await signInWithPhonePin(d, { phone: s.phone, pin: bad, ip: "2" });
    const l = await one<{ day: boolean }>(
      db(),
      sql`select locked_until between now() + interval '23 hours' and now() + interval '25 hours' as day
          from private.phone_logins where user_id = ${s.userId}`,
    );
    expect(l.day).toBe(true);
    expect((await signInWithPhonePin(d, { phone: s.phone, pin: s.pin, ip: "2" })).ok).toBe(false);
    const reset = await resetStaffPin(
      { userId: owner.id, email: owner.email },
      orgId,
      s.userId,
      deps,
    );
    expect(reset.ok).toBe(true);
    if (reset.ok)
      expect((await signInWithPhonePin(d, { phone: s.phone, pin: reset.pin, ip: "2" })).ok).toBe(
        true,
      );
  });

  it("fel som är äldre än ett dygn glöms (under 10 fel)", async () => {
    const s = await newStaff();
    const d = loginDeps();
    const bad = s.pin === "135790" ? "246802" : "135790";
    for (let i = 0; i < 4; i += 1)
      await signInWithPhonePin(d, { phone: s.phone, pin: bad, ip: "5" });
    await db().execute(
      sql`update private.phone_logins set last_failed_at = now() - interval '25 hours' where user_id = ${s.userId}`,
    );
    await signInWithPhonePin(d, { phone: s.phone, pin: bad, ip: "5" });
    const row = await one<{ f: number; locked: boolean }>(
      db(),
      sql`select failed_attempts as f, locked_until is not null as locked from private.phone_logins where user_id = ${s.userId}`,
    );
    expect(row).toEqual({ f: 1, locked: false });
  });

  it("QR-nyckel + PIN loggar in; ny QR-kod gör den gamla ogiltig", async () => {
    const p = phone();
    const r = await createMachineStaff(
      { userId: owner.id, email: owner.email },
      orgId,
      { name: "Kim Testsson", phone: p, machineIds: [m1] },
      deps,
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.qrToken).toMatch(/^[A-Za-z0-9_-]{43}$/);
    const stored = await one<{ h: string }>(
      db(),
      sql`select qr_token_hash as h from private.phone_logins where user_id = ${r.userId}`,
    );
    expect(stored.h).not.toContain(r.qrToken);
    expect(await qrAccountName(db, r.qrToken)).toBe("Kim");
    const d = loginDeps();
    const bad = r.pin === "135790" ? "246802" : "135790";
    expect(await signInWithPhonePin(d, { token: r.qrToken, pin: bad, ip: "6" })).toEqual({
      ok: false,
      error: QR_LOGIN_ERROR,
    });
    expect((await signInWithPhonePin(d, { token: r.qrToken, pin: r.pin, ip: "6" })).ok).toBe(true);
    const rotated = await rotateStaffQr(
      { userId: owner.id, email: owner.email },
      orgId,
      r.userId,
      db,
    );
    expect(rotated.ok).toBe(true);
    expect((await signInWithPhonePin(d, { token: r.qrToken, pin: r.pin, ip: "6" })).ok).toBe(false);
    expect(await qrAccountName(db, r.qrToken)).toBeNull();
    if (rotated.ok) {
      expect(
        (await signInWithPhonePin(d, { token: rotated.qrToken, pin: r.pin, ip: "6" })).ok,
      ).toBe(true);
    }
    expect(
      (
        await rotateStaffQr(
          { userId: otherOwner.id, email: otherOwner.email },
          otherOrg,
          r.userId,
          db,
        )
      ).ok,
    ).toBe(false);
    expect(await qrAccountName(db, "x".repeat(43))).toBeNull();
    expect(await checkOwnPin(db, r.userId, r.pin)).toBe(true);
    expect(await checkOwnPin(db, r.userId, bad)).toBe(false);
  });

  it("gränsen per IP gäller", async () => {
    const d = loginDeps(createRateLimiter({ limit: 2, windowMs: 60_000 }));
    await signInWithPhonePin(d, { phone: "0701111111", pin: "135790", ip: "3" });
    await signInWithPhonePin(d, { phone: "0701111111", pin: "135790", ip: "3" });
    expect(await signInWithPhonePin(d, { phone: "0701111111", pin: "135790", ip: "3" })).toEqual({
      ok: false,
      error: "För många försök. Vänta en stund och försök igen.",
    });
  });

  it("avstängt eller oanvänt i 90 dagar: ingen inloggning", async () => {
    const s = await newStaff();
    const d = loginDeps();
    await db()
      .execute(sql`update private.phone_logins set last_used_at = now() - interval '91 days',
      created_at = now() - interval '91 days' where user_id = ${s.userId}`);
    expect((await signInWithPhonePin(d, { phone: s.phone, pin: s.pin, ip: "4" })).ok).toBe(false);
    expect((await staffSessionState(db, s.userId)).state).toBe("expired");
    const staffUser = { id: s.userId, email: "x" };
    expect(
      await asUser(staffUser, (tx) => rows(tx, sql`select * from public.staff_my_machines()`)),
    ).toEqual([]);
    await db().execute(
      sql`update private.phone_logins set last_used_at = now(), disabled_at = now() where user_id = ${s.userId}`,
    );
    expect((await signInWithPhonePin(d, { phone: s.phone, pin: s.pin, ip: "4" })).ok).toBe(false);
  });
});
