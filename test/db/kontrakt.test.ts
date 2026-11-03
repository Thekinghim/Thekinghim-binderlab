/**
 * Kontrakt med egna villkor (migreringen 20261105040000_kontrakt_sarskilda_villkor.sql,
 * src/server/contracts) mot testdatabasen: andel av omsättningen + hyra och särskilda
 * villkor i kontraktet och PDF:en, bara hyra, delad förlust med VMB, Ny butik-guidens
 * kontrakt från samma dag som butikens villkor (fromOpenTerms), kontrakten per butik med
 * mall och signering (queryActiveContracts) och databasens gräns för särskilda villkor.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import { storeContractState } from "@/analytics/contracts/signed";
import * as s from "@/db/schema";
import { LocalFileStore } from "@/import/file-store";
import { listOrganizationsFor, type SessionUser } from "@/server/access";
import {
  contractTemplateHtmlFor,
  createStoreContractFor,
  loadSignableContractsFor,
  setContractStatusFor,
  type Viewer,
} from "@/server/contracts";

import { asUser, createOrg, createUser, uniqueSuffix, type TestUser } from "./helpers";

const TODAY = "2026-11-03";
const PDF = new TextEncoder().encode("%PDF-1.4\n% test\n");

let owner: TestUser;
let orgId: string;
let viewer: Viewer;
let files: LocalFileStore;
let rendered: string[] = [];

const deps = () => ({
  today: TODAY,
  renderPdf: async (html: string) => {
    rendered.push(html);
    return PDF;
  },
  fileStore: files,
});

async function newStore(name: string): Promise<string> {
  return asUser(owner, async (tx) => {
    const [st] = await tx.insert(s.stores).values({ organizationId: orgId, name }).returning();
    return st!.id;
  });
}

async function agreementsOf(storeId: string) {
  return asUser(owner, (tx) =>
    tx
      .select()
      .from(s.storeAgreements)
      .where(
        and(eq(s.storeAgreements.organizationId, orgId), eq(s.storeAgreements.storeId, storeId)),
      )
      .orderBy(s.storeAgreements.validFrom),
  );
}

async function contractOf(id: string) {
  const [c] = await asUser(owner, (tx) =>
    tx.select().from(s.contracts).where(eq(s.contracts.id, id)),
  );
  return c!;
}

const flat = (t: string) => t.replace(/\s+/g, " ");

beforeAll(async () => {
  owner = await createUser(`kontrakt-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(owner, `Kontrakt ${uniqueSuffix()}`);
  const user: SessionUser = { userId: owner.id, email: owner.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId)!;
  viewer = { user, organization };
  files = new LocalFileStore(mkdtempSync(path.join(tmpdir(), "kontrakt-")));
});

describe("Skapa kontrakt med egna villkor", () => {
  it("procent av omsättningen + hyra och särskilda villkor: villkoren, kontraktet och PDF:en", async () => {
    const storeId = await newStore("Kiosken");
    rendered = [];
    const res = await createStoreContractFor(
      viewer,
      {
        target: `store:${storeId}`,
        validFrom: TODAY,
        terms: {
          shareBp: 1_250,
          base: "net_excl_vat",
          lossTreatment: "zero",
          vmbBeforeSplit: false,
          monthlyRentOre: 75_000,
        },
        specialTerms: "Automaten står vid kassan.\n<b>El ingår.</b>",
      },
      deps(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const c = await contractOf(res.contractId);
    expect(c.specialTerms).toBe("Automaten står vid kassan.\n<b>El ingår.</b>");
    expect(c.terms).toContain("Andel av omsättningen");
    const [ag] = await agreementsOf(storeId);
    expect(ag).toMatchObject({
      validFrom: TODAY,
      commissionBp: 1_250,
      commissionBase: "net_excl_vat",
      monthlyRentOre: 75_000,
      contractId: res.contractId,
    });
    const html = flat(rendered[0]!);
    expect(html).toContain("Butiken får 12,5 % av automatens omsättning.");
    expect(html).toContain("fast hyra på 750 kr per månad");
    expect(html).toContain("8. Särskilda villkor");
    expect(html).toContain("Automaten står vid kassan.");
    expect(html).toContain("&lt;b&gt;El ingår.&lt;/b&gt;");
    // Utskriften från kontraktet (signering, /avtal/{id}/mall) speglar samma villkor.
    const again = flat(await contractTemplateHtmlFor(viewer, res.contractId));
    expect(again).toContain("12,5 % av automatens omsättning");
    expect(again).toContain("Automaten står vid kassan.");
  });

  it("bara hyra och vinstdelning med delad förlust och VMB", async () => {
    const rentStore = await newStore("Hyresgästen");
    const rent = await createStoreContractFor(
      viewer,
      {
        target: `store:${rentStore}`,
        validFrom: TODAY,
        terms: { shareBp: null, lossTreatment: "zero", monthlyRentOre: 150_000 },
      },
      deps(),
    );
    expect(rent.ok).toBe(true);
    expect((await agreementsOf(rentStore))[0]).toMatchObject({
      commissionBp: null,
      commissionBase: "net_excl_vat",
      monthlyRentOre: 150_000,
    });
    const split = await newStore("Delaren");
    rendered = [];
    const res = await createStoreContractFor(
      viewer,
      {
        target: `store:${split}`,
        validFrom: TODAY,
        terms: {
          shareBp: 4_000,
          base: "profit_after_costs",
          lossTreatment: "proportional",
          vmbBeforeSplit: true,
          monthlyRentOre: null,
        },
      },
      deps(),
    );
    expect(res.ok).toBe(true);
    expect((await agreementsOf(split))[0]).toMatchObject({
      commissionBp: 4_000,
      commissionBase: "profit_after_costs",
      lossTreatment: "proportional",
      vmbBeforeSplit: true,
    });
    expect(flat(rendered[0]!)).toContain("bär Butiken 40 % av förlusten");
    await expect(
      createStoreContractFor(
        viewer,
        {
          target: `store:${await newStore("Tomt")}`,
          validFrom: TODAY,
          terms: { shareBp: null, lossTreatment: "zero", monthlyRentOre: null },
        },
        deps(),
      ),
    ).rejects.toThrow("Ange andel, hyra eller båda.");
  });

  it("Ny butik: kontraktet börjar när butikens villkor börjar och skriver om dem, utan bekräftelse", async () => {
    const storeId = await newStore("Guiden");
    await asUser(owner, (tx) =>
      tx.insert(s.storeAgreements).values({
        organizationId: orgId,
        storeId,
        validFrom: "2026-10-20",
        commissionBp: 5_000,
        commissionBase: "profit_after_costs",
      }),
    );
    const res = await createStoreContractFor(
      viewer,
      {
        target: `store:${storeId}`,
        validFrom: TODAY,
        fromOpenTerms: true,
        terms: {
          shareBp: 5_000,
          base: "profit_after_costs",
          lossTreatment: "zero",
          monthlyRentOre: 20_000,
        },
      },
      deps(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect((await contractOf(res.contractId)).validFrom).toBe("2026-10-20");
    const ag = await agreementsOf(storeId);
    expect(ag).toHaveLength(1);
    expect(ag[0]).toMatchObject({
      validFrom: "2026-10-20",
      monthlyRentOre: 20_000,
      contractId: res.contractId,
    });
  });

  it("kontrakten per butik: osignerat → signerat; för hand räknas som signerat", async () => {
    const storeId = await newStore("Signeraren");
    const res = await createStoreContractFor(
      viewer,
      { target: `store:${storeId}`, validFrom: TODAY },
      deps(),
    );
    if (!res.ok) throw new Error("ej skapat");
    let list = await loadSignableContractsFor(viewer);
    expect(storeContractState(list, storeId, TODAY)).toBe("unsigned");
    await setContractStatusFor(viewer, { id: res.contractId, status: "signed" });
    list = await loadSignableContractsFor(viewer);
    expect(list.find((c) => c.id === res.contractId)?.template).toBe("placering-vinstdelning-v1");
    expect(storeContractState(list, storeId, TODAY)).toBe("signed");
    const paper = await newStore("Papper");
    await asUser(owner, (tx) =>
      tx
        .insert(s.contracts)
        .values({ organizationId: orgId, storeId: paper, validFrom: "2026-01-01" }),
    );
    expect(storeContractState(await loadSignableContractsFor(viewer), paper, TODAY)).toBe("signed");
    expect(
      storeContractState(await loadSignableContractsFor(viewer), await newStore("Utan"), TODAY),
    ).toBe("missing");
  });

  it("databasen: särskilda villkor högst 2 000 tecken och inte tomma", async () => {
    const storeId = await newStore("Gränsen");
    await expect(
      asUser(owner, (tx) =>
        tx.execute(
          sql`insert into public.contracts (organization_id, store_id, valid_from, special_terms)
              values (${orgId}::uuid, ${storeId}::uuid, '2026-11-01', ${"x".repeat(2001)})`,
        ),
      ),
    ).rejects.toThrow();
    await expect(
      asUser(owner, (tx) =>
        tx.execute(
          sql`insert into public.contracts (organization_id, store_id, valid_from, special_terms)
              values (${orgId}::uuid, ${storeId}::uuid, '2026-11-01', '')`,
        ),
      ),
    ).rejects.toThrow();
  });
});
