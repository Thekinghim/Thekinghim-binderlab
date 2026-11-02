/**
 * Röda laget, Ekonomi (fas 9): oberoende granskning.
 *
 * Testerna beskriver hur systemet SKA bete sig. De som misslyckas visar ett säkerhetshål som
 * finns i dag (se granskningsrapporten):
 *
 * 1. Avtalsfilen som lagrad XSS. En admin kan via PostgREST (grant update på hela contracts)
 *    sätta file_content_type = 'text/html' på ett avtal. Filtypen kontrolleras bara på de
 *    första bytes ("%PDF-"), så en polyglot "%PDF-<script>…" går igenom uppladdningen.
 *    GET /avtal/{id}/fil skickar sedan filen inline med den lagrade typen, på appens origin,
 *    till ägaren eller läsaren som öppnar den. Admin → ägare via skript i ägarens session.
 * 2. Kolumnerna för avtalsfilen ska bara sättas av servern (efter typkontroll), inte direkt.
 * 3. En utredning av en avvikelse ska alltid bära serverns fingerprint; utan fingerprint gäller
 *    den för alltid, även när avvikelsen växer.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import * as s from "@/db/schema";
import { LocalFileStore } from "@/import/file-store";
import { listOrganizationsFor, type SessionUser } from "@/server/access";
import { CONTRACT_FILE_TYPES } from "@/server/accounting/contract-files";
import {
  attachContractFileFor,
  readContractFileFor,
  saveContractFor,
} from "@/server/accounting/service";
import type { Viewer } from "@/server/data/core/loaders";

import {
  asUser,
  attempt,
  createMember,
  createOrg,
  createUser,
  uniqueSuffix,
  type TestUser,
} from "./helpers";

async function viewerFor(u: TestUser, orgId: string): Promise<Viewer> {
  const user: SessionUser = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === orgId);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let dir: string;
let files: LocalFileStore;
let orgId: string;
let ownerUser: TestUser;
let adminUser: TestUser;
let owner: Viewer;
let admin: Viewer;
let contractId: string;

beforeAll(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "rt-ekonomi-"));
  files = new LocalFileStore(dir);
  ownerUser = await createUser(`rt-agare-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(ownerUser, `Röda laget ekonomi ${uniqueSuffix()}`);
  adminUser = await createMember(orgId, "admin");
  owner = await viewerFor(ownerUser, orgId);
  admin = await viewerFor(adminUser, orgId);
  const storeId = await asUser(ownerUser, async (tx) => {
    const [st] = await tx
      .insert(s.stores)
      .values({ organizationId: orgId, name: "Butik" })
      .returning({ id: s.stores.id });
    return st!.id;
  });
  ({ id: contractId } = await saveContractFor(owner, {
    storeId,
    title: "Avtal",
    validFrom: "2026-01-01",
    validTo: "2026-12-31",
    noticePeriodMonths: 3,
    noticePeriodDays: null,
    renewalMonths: null,
    terminatedOn: null,
    terms: null,
    note: null,
  }));
});

afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("avtalsfilen (lagrad XSS via filtyp)", () => {
  it("en polyglot '%PDF-<script>' med typen ändrad till text/html serveras inte som HTML", async () => {
    const polyglot = new TextEncoder().encode(
      "%PDF-1.4\n<html><body><script>fetch('/installningar')</script></body></html>\n",
    );
    // Uppladdningen går igenom: bara de magiska bytes kontrolleras.
    await attachContractFileFor(
      admin,
      { contractId, fileName: "avtal.pdf", bytes: polyglot },
      { fileStore: files },
    );

    // Admin ändrar typen direkt i databasen (som via PostgREST med sin JWT).
    await asUser(adminUser, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.contracts set file_content_type = 'text/html', file_name = 'avtal.html'
              where id = ${contractId}`,
        ),
      ),
    );

    // Ägaren öppnar avtalsfilen: /avtal/{id}/fil skickar contentType rakt av, inline.
    const file = await readContractFileFor(owner, contractId, { fileStore: files });
    expect(Object.keys(CONTRACT_FILE_TYPES)).toContain(file.contentType);
  });

  it("kolumnerna för avtalsfilen kan inte ändras direkt av en användare", async () => {
    const res = await asUser(adminUser, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.contracts set file_content_type = 'image/svg+xml'
              where id = ${contractId}`,
        ),
      ),
    );
    expect(res.ok).toBe(false);
  });
});

describe("utredda avvikelser", () => {
  it("en utredning utan fingerprint (som gäller för alltid) kan inte skrivas direkt", async () => {
    const res = await asUser(adminUser, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.deviation_reviews (organization_id, deviation_key, action, note)
              values (${orgId}, 'AW-1:fee', 'investigated', 'Utredd för alltid')`,
        ),
      ),
    );
    expect(res.ok).toBe(false);
  });
});
