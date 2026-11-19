/**
 * Villkoren i ett signerat kontrakt (testdatabasen, egen fixtur, "i dag" 19 nov. 2026).
 *
 * Butiken Vinsten har 50 % av vinsten, och avtalet hör till ett kontrakt som signerades
 * den 3 november. Att ändra andelen under Butiker varnar först och kräver en bekräftelse;
 * ändringen märks på raden och står i ändringsloggen. Sista dag och anteckning hör inte
 * till villkoren och ändras utan varning.
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("next/headers", () => ({
  headers: async () => new Headers(),
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
}));
vi.mock("next/cache", () => ({
  revalidatePath: vi.fn(),
  revalidateTag: vi.fn(),
  updateTag: vi.fn(),
  unstable_noStore: vi.fn(),
  unstable_cache: <T>(fn: T) => fn,
}));

import { updateAgreementFor } from "@/app/(app)/butiker/_lib/service";

import { asPostgres, one } from "./helpers";
import { seedMoneyFixture, type MoneyFixture } from "./pengar-fixture";

const TODAY = "2026-11-19";

let f: MoneyFixture;
let agreementId: string;
let unsignedAgreementId: string;

const stored = () =>
  asPostgres((tx) =>
    one<{ bp: number; marked: string | null; note: string | null }>(
      tx,
      sql`select commission_bp as bp, changed_after_signing_at::text as marked, note
          from public.store_agreements where id = ${agreementId}`,
    ),
  );

beforeAll(async () => {
  f = await seedMoneyFixture("Signerat kontrakt");
  await asPostgres(async (tx) => {
    const contract = await one<{ id: string }>(
      tx,
      sql`insert into public.contracts (organization_id, store_id, valid_from, template, signed_at)
          values (${f.orgId}, ${f.stores.vinsten}, '2026-01-01', 'placering-vinstdelning-v1',
                  '2026-11-03T10:00:00Z')
          returning id`,
    );
    agreementId = (
      await one<{ id: string }>(
        tx,
        sql`update public.store_agreements set contract_id = ${contract.id}
            where organization_id = ${f.orgId} and store_id = ${f.stores.vinsten} returning id`,
      )
    ).id;
    unsignedAgreementId = (
      await one<{ id: string }>(
        tx,
        sql`select id from public.store_agreements
            where organization_id = ${f.orgId} and store_id = ${f.stores.provision}`,
      )
    ).id;
  });
}, 120_000);

describe("ändra villkoren i ett signerat kontrakt", () => {
  it("varnar först och ändrar ingenting", async () => {
    const r = await updateAgreementFor(
      f.owner,
      { agreementId, model: "split", commission: "40", confirmHistory: true },
      TODAY,
    );
    expect(r).toMatchObject({ ok: false, needsConfirm: true });
    expect(r.error!.replace(/ | /g, " ")).toBe(
      "Avtalet hör till ett kontrakt som signerades 3 nov. Ändrar du villkoren stämmer de inte längre med det butiken skrev under. Lägg hellre in nya villkor från ett datum och skriv ett nytt kontrakt.",
    );
    expect(await stored()).toMatchObject({ bp: 5000, marked: null });
  });

  it("med bekräftelsen ändras de, raden märks och loggen visar det", async () => {
    const r = await updateAgreementFor(
      f.owner,
      { agreementId, model: "split", commission: "40", confirmHistory: true, confirmSigned: true },
      TODAY,
    );
    expect(r.ok).toBe(true);
    const row = await stored();
    expect(row.bp).toBe(4000);
    expect(row.marked).not.toBeNull();
    const log = await asPostgres((tx) =>
      one<{ n: number }>(
        tx,
        sql`select count(*)::int as n from public.audit_log
            where organization_id = ${f.orgId} and table_name = 'store_agreements'
              and row_id = ${agreementId}::uuid and action = 'update'
              and actor_id = ${f.ownerUser.id}
              and before ->> 'commission_bp' = '5000' and after ->> 'commission_bp' = '4000'
              and before ->> 'changed_after_signing_at' is null
              and after ->> 'changed_after_signing_at' is not null`,
      ),
    );
    expect(log.n).toBe(1);
  });

  it("anteckning och sista dag ändras utan varning", async () => {
    const r = await updateAgreementFor(
      f.owner,
      { agreementId, model: "split", commission: "40", note: "Ny kontaktperson" },
      TODAY,
    );
    expect(r.ok).toBe(true);
    expect((await stored()).note).toBe("Ny kontaktperson");
  });

  it("ett avtal utan signerat kontrakt varnar bara om historiken, som förut", async () => {
    const r = await updateAgreementFor(
      f.owner,
      { agreementId: unsignedAgreementId, commission: "12" },
      TODAY,
    );
    expect(r).toMatchObject({ ok: false, needsConfirm: true });
    expect(r.error).not.toMatch(/signerades/);
  });
});
