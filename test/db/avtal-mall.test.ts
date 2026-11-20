/**
 * Skapa avtal (migreringen 20261104120000_avtal_mall.sql, src/server/contracts) mot
 * testdatabasen: avtalet från mallen, villkoren 50 % av vinsten efter kostnader från
 * startdagen (gamla villkor avslutas dagen före), PDF:en i lagringen, en plats i pipelinen
 * som blir butik, bakåtdatering kräver bekräftelse, status utkast → skickat → signerat,
 * och att läsaren inte kan skapa avtal.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import * as s from "@/db/schema";
import { LocalFileStore } from "@/import/file-store";
import { listOrganizationsFor, type SessionUser } from "@/server/access";
import {
  contractTemplateHtmlFor,
  createStoreContractFor,
  setContractStatusFor,
  type Viewer,
} from "@/server/contracts";

import {
  asUser,
  createMember,
  createOrg,
  createUser,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

const TODAY = "2026-11-03";
const PDF = new TextEncoder().encode("%PDF-1.4\n% test\n");

let owner: TestUser;
let orgId: string;
let viewer: Viewer;
let files: LocalFileStore;
let rendered: string[] = [];

async function viewerFor(u: TestUser): Promise<Viewer> {
  const user: SessionUser = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

const deps = () => ({
  today: TODAY,
  renderPdf: async (html: string) => {
    rendered.push(html);
    return PDF;
  },
  fileStore: files,
});

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

beforeAll(async () => {
  owner = await createUser(`avtal-mall-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(owner, `Avtalsmall ${uniqueSuffix()}`);
  viewer = await viewerFor(owner);
  files = new LocalFileStore(mkdtempSync(path.join(tmpdir(), "avtal-mall-")));
  await asUser(owner, (tx) =>
    tx.execute(
      sql`insert into public.bookkeeping_settings (organization_id, org_number) values (${orgId}::uuid, '559000-0000')`,
    ),
  );
});

describe("Skapa avtal", () => {
  it("butik med gamla villkor: avtal, vinstdelning från startdagen och PDF", async () => {
    const storeId = await asUser(owner, async (tx) => {
      const [st] = await tx
        .insert(s.stores)
        .values({ organizationId: orgId, name: "Sega gubben", address: "Storgatan 1" })
        .returning();
      await tx.insert(s.storeAgreements).values({
        organizationId: orgId,
        storeId: st!.id,
        validFrom: "2026-01-01",
        commissionBp: 5_000,
        commissionBase: "net_excl_vat",
      });
      return st!.id;
    });
    rendered = [];
    const res = await createStoreContractFor(
      viewer,
      { target: `store:${storeId}`, validFrom: TODAY },
      deps(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.pdf).toBe(true);

    const c = await contractOf(res.contractId);
    expect(c.template).toBe("placering-vinstdelning-v1");
    expect(c.validFrom).toBe(TODAY);
    expect(c.validTo).toBeNull();
    expect(c.noticePeriodMonths).toBe(1);
    expect(c.sentAt).toBeNull();
    expect(c.signedAt).toBeNull();
    expect(c.fileContentType).toBe("application/pdf");
    expect(c.storagePath).toMatch(new RegExp(`^${orgId}/${res.contractId}/[0-9a-f]{64}\\.pdf$`));
    expect(await files.get(c.storagePath!)).toEqual(PDF);

    const html = rendered[0]!;
    expect(html).toContain("Sega gubben");
    expect(html).toContain("559000-0000");
    expect(html).toContain("50 % av vinsten");

    const ag = await agreementsOf(storeId);
    expect(ag).toHaveLength(2);
    expect(ag[0]).toMatchObject({ validTo: "2026-11-02", commissionBase: "net_excl_vat" });
    expect(ag[1]).toMatchObject({
      validFrom: TODAY,
      validTo: null,
      commissionBp: 5_000,
      commissionBase: "profit_after_costs",
      lossTreatment: "zero",
      monthlyRentOre: null,
      contractId: res.contractId,
    });

    expect(await contractTemplateHtmlFor(viewer, res.contractId)).toContain("Sega gubben");
  });

  it("villkor som börjar samma dag skrivs om till vinstdelning", async () => {
    const storeId = await asUser(owner, async (tx) => {
      const [st] = await tx
        .insert(s.stores)
        .values({ organizationId: orgId, name: "Samma dag" })
        .returning();
      await tx.insert(s.storeAgreements).values({
        organizationId: orgId,
        storeId: st!.id,
        validFrom: TODAY,
        monthlyRentOre: 50_000,
      });
      return st!.id;
    });
    const res = await createStoreContractFor(
      viewer,
      { target: `store:${storeId}`, validFrom: TODAY },
      deps(),
    );
    expect(res.ok).toBe(true);
    const ag = await agreementsOf(storeId);
    expect(ag).toHaveLength(1);
    // Hyran i villkoren som skrivs om behålls, och avtalet skriver ut den.
    expect(ag[0]).toMatchObject({
      commissionBase: "profit_after_costs",
      commissionBp: 5_000,
      monthlyRentOre: 50_000,
    });
    expect(rendered.at(-1)).toMatch(/hyra på 500.{0,8}kr per månad/);
  });

  it("ett klick till ger inget andra avtal", async () => {
    const storeId = await asUser(owner, async (tx) => {
      const [st] = await tx
        .insert(s.stores)
        .values({ organizationId: orgId, name: "Dubbelklick" })
        .returning();
      return st!.id;
    });
    const target = { target: `store:${storeId}`, validFrom: TODAY };
    expect((await createStoreContractFor(viewer, target, deps())).ok).toBe(true);
    await expect(createStoreContractFor(viewer, target, deps())).rejects.toThrow(
      "Dubbelklick har redan ett kontrakt (utkast). Öppna det under Kontrakt.",
    );
    const n = await asUser(owner, (tx) =>
      tx.select().from(s.contracts).where(eq(s.contracts.storeId, storeId)),
    );
    expect(n).toHaveLength(1);
    expect(await agreementsOf(storeId)).toHaveLength(1);
  });

  it("plats i pipelinen blir butik och flyttas till Avtal", async () => {
    const leadId = await asUser(owner, async (tx) => {
      const [l] = await tx
        .insert(s.expansionLeads)
        .values({
          organizationId: orgId,
          name: "Spelhörnan",
          city: "Umeå",
          contactName: "Kim",
          contactEmail: "kim@example.se",
          stage: "meeting",
        })
        .returning();
      return l!.id;
    });
    const res = await createStoreContractFor(
      viewer,
      { target: `lead:${leadId}`, validFrom: TODAY },
      deps(),
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.storeName).toBe("Spelhörnan");
    const [lead] = await asUser(owner, (tx) =>
      tx.select().from(s.expansionLeads).where(eq(s.expansionLeads.id, leadId)),
    );
    expect(lead).toMatchObject({ storeId: res.storeId, stage: "agreement" });
    const [store] = await asUser(owner, (tx) =>
      tx.select().from(s.stores).where(eq(s.stores.id, res.storeId)),
    );
    expect(store).toMatchObject({ name: "Spelhörnan", city: "Umeå", email: "kim@example.se" });
  });

  it("startdag bakåt kräver bekräftelse", async () => {
    const storeId = await asUser(owner, async (tx) => {
      const [st] = await tx
        .insert(s.stores)
        .values({ organizationId: orgId, name: "Bakåt" })
        .returning();
      return st!.id;
    });
    const first = await createStoreContractFor(
      viewer,
      { target: `store:${storeId}`, validFrom: "2026-11-01" },
      deps(),
    );
    expect(first).toMatchObject({ ok: false, needsConfirm: true });
    expect(await agreementsOf(storeId)).toHaveLength(0);
    const second = await createStoreContractFor(
      viewer,
      { target: `store:${storeId}`, validFrom: "2026-11-01", confirmHistory: true },
      deps(),
    );
    expect(second.ok).toBe(true);
  });

  it("utan PDF sparas avtalet ändå; status utkast → skickat → signerat", async () => {
    const storeId = await asUser(owner, async (tx) => {
      const [st] = await tx
        .insert(s.stores)
        .values({ organizationId: orgId, name: "Utan PDF" })
        .returning();
      return st!.id;
    });
    const res = await createStoreContractFor(
      viewer,
      { target: `store:${storeId}`, validFrom: TODAY },
      { ...deps(), renderPdf: null },
    );
    expect(res).toMatchObject({ ok: true, pdf: false });
    if (!res.ok) return;
    expect((await contractOf(res.contractId)).storagePath).toBeNull();

    await setContractStatusFor(viewer, { id: res.contractId, status: "sent" });
    const sent = await contractOf(res.contractId);
    expect(sent.sentAt).not.toBeNull();
    expect(sent.signedAt).toBeNull();
    await setContractStatusFor(viewer, { id: res.contractId, status: "signed" });
    const signed = await contractOf(res.contractId);
    expect(signed.signedAt).not.toBeNull();
    expect(signed.sentAt).toEqual(sent.sentAt);
  });

  it("läsaren kan inte skapa avtal", async () => {
    const reader = await createMember(orgId, "viewer");
    const storeId = await asUser(owner, async (tx) => {
      const [st] = await tx
        .insert(s.stores)
        .values({ organizationId: orgId, name: "Läsarens" })
        .returning();
      return st!.id;
    });
    await expect(
      createStoreContractFor(
        await viewerFor(reader),
        { target: `store:${storeId}`, validFrom: TODAY },
        deps(),
      ),
    ).rejects.toThrow();
  });
});
