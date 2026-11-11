/**
 * Runda 2, T6-3 mot testdatabasen: fakta för startlistan per ny butik
 * (src/app/(app)/butiker/(oversikt)/_lib/start-facts.ts) under RLS och per roll, och att
 * storeStartList ger rätt bockar och knapp för dem.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { loadStoreStartDataFor } from "@/app/(app)/butiker/(oversikt)/_lib/start-facts";
import { storeStartList } from "@/app/(app)/butiker/_lib/model";
import { AuthorizationError } from "@/server/access";

import {
  asUser,
  createMember,
  createOrg,
  createUser,
  one,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const session = (u: TestUser) => ({ userId: u.id, email: u.email });

describe("Startlista per ny butik", () => {
  let owner: TestUser;
  let orgId: string;
  let empty: string;
  let withTerms: string;
  let archived: string;

  const newStore = (name: string) =>
    asUser(owner, async (tx) => {
      const row = await one<{ id: string }>(
        tx,
        sql`insert into public.stores (organization_id, name)
            values (${orgId}::uuid, ${name}) returning id`,
      );
      return row.id;
    });

  beforeAll(async () => {
    owner = await createUser(`start-${uniqueSuffix()}@test.binderlab.se`);
    orgId = await createOrg(owner, `Startlista ${uniqueSuffix()}`);
    empty = await newStore("Tom butik");
    withTerms = await newStore("Kafé Ett");
    archived = await newStore("Stängd");
    await asUser(owner, async (tx) => {
      await tx.execute(
        sql`insert into public.store_agreements
              (organization_id, store_id, valid_from, commission_bp, commission_base)
            values (${orgId}::uuid, ${withTerms}::uuid, current_date + 10, 5000, 'profit_after_costs')`,
      );
      await tx.execute(
        sql`update public.stores set archived_at = now() where id = ${archived}::uuid`,
      );
      // En automat i drift utan butik.
      await tx.execute(
        sql`insert into public.machines (organization_id, code, name, active_from)
            values (${orgId}::uuid, 'BL-007', 'Ny automat', current_date)`,
      );
    });
  });

  it("ny butik: inget klart; villkor som börjar senare räknas som villkor", async () => {
    const data = await loadStoreStartDataFor(session(owner), orgId);
    expect(data.facts.get(empty)).toEqual({
      hasTerms: false,
      recipients: 0,
      portal: { users: 0, pending: 0 },
    });
    expect(data.facts.get(withTerms)?.hasTerms).toBe(true);
    expect(data.facts.has(archived)).toBe(false);
    expect(data.freeMachineCode).toBe("BL-007");

    const list = storeStartList({
      store: {
        id: withTerms,
        name: "Kafé Ett",
        href: `/butiker/${withTerms}`,
        contract: "unsigned",
        machineCodes: [],
      },
      facts: data.facts.get(withTerms)!,
      freeMachineCode: data.freeMachineCode,
    });
    expect(list.progress).toBe("1 av 5 klart");
    expect(list.next?.label).toBe("Signera");
  });

  it("mottagare och portal-inbjudan bockas av när de finns", async () => {
    await asUser(owner, async (tx) => {
      await tx.execute(
        sql`insert into public.report_recipients (organization_id, name, email, kind, store_id)
            values (${orgId}::uuid, 'Anna', 'anna@example.se', 'store', ${withTerms}::uuid)`,
      );
      await tx.execute(
        sql`insert into public.report_recipients
              (organization_id, name, email, kind, store_id, active)
            values (${orgId}::uuid, 'Gammal', 'gammal@example.se', 'store', ${empty}::uuid, false)`,
      );
      await tx.execute(
        sql`select public.create_store_invitation(${orgId}::uuid, ${withTerms}::uuid,
              'butik@example.se', 14)`,
      );
    });
    const data = await loadStoreStartDataFor(session(owner), orgId);
    expect(data.facts.get(withTerms)).toEqual({
      hasTerms: true,
      recipients: 1,
      portal: { users: 0, pending: 1 },
    });
    // En inaktiv mottagare räknas inte.
    expect(data.facts.get(empty)?.recipients).toBe(0);
  });

  it("en automat som redan står i en butik är inte ledig", async () => {
    await asUser(owner, (tx) =>
      tx.execute(
        sql`insert into public.machine_placements (organization_id, machine_id, store_id, valid_from)
            select ${orgId}::uuid, m.id, ${empty}::uuid, current_date
            from public.machines m where m.organization_id = ${orgId}::uuid and m.code = 'BL-007'`,
      ),
    );
    expect((await loadStoreStartDataFor(session(owner), orgId)).freeMachineCode).toBeNull();
  });

  it("läsaren ser listan utan portalen; påfyllaren och utomstående nekas", async () => {
    const reader = await createMember(orgId, "viewer");
    const data = await loadStoreStartDataFor(session(reader), orgId);
    expect(data.facts.get(withTerms)).toEqual({ hasTerms: true, recipients: 1, portal: null });
    const refiller = await createMember(orgId, "refiller");
    await expect(loadStoreStartDataFor(session(refiller), orgId)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    const stranger = await createUser(`annan-${uniqueSuffix()}@test.binderlab.se`);
    await createOrg(stranger, `Annan ${uniqueSuffix()}`);
    await expect(loadStoreStartDataFor(session(stranger), orgId)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
  });
});
