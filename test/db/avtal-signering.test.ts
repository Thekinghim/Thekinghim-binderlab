/**
 * Signering på plats (20261104233200_avtal_signering.sql, src/server/contracts/signing.ts)
 * mot testdatabasen: hela flödet (länk → PDF → signatur → signerad PDF), och säkerheten för
 * den öppna länken: engångs (även samtidigt), tidsbegränsad, ersatt av en ny länk, fel
 * organisation, manipulerad token, bytt eller manipulerad PDF, ogiltig signatur, att
 * funktionerna i private inte kan köras av någon klientroll, att signaturen inte kan ändras,
 * och routerna och server action för /signera.
 */

import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { and, eq, sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

const req = vi.hoisted(() => ({ headers: new Map<string, string>() }));
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (k: string) => req.headers.get(k.toLowerCase()) ?? null }),
  cookies: async () => ({ get: () => undefined, getAll: () => [], set: () => {} }),
}));

import * as s from "@/db/schema";
import { LocalFileStore } from "@/import/file-store";
import { listOrganizationsFor, type SessionUser } from "@/server/access";
import { attachContractFileFor } from "@/server/accounting/service";
import {
  ContractError,
  createSigningLinkFor,
  createStoreContractFor,
  describeSigningLink,
  loadContractSignaturesFor,
  readSigningDocument,
  signedDocumentFor,
  signedDocumentForLink,
  setContractStatusFor,
  SigningError,
  signWithLink,
  type Viewer,
} from "@/server/contracts";

import {
  asAnon,
  asPostgres,
  asServiceRole,
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

const TODAY = "2026-11-03";
// 1×1 PNG är för liten för en signatur; ritytan ger minst 50×20. Den här är 60×24.
const SIGNATURE = `data:image/png;base64,${pngOf(60, 24).toString("base64")}`;

/** En giltig PNG (vit) med måtten, utan beroenden: IHDR, en IDAT med okomprimerade rader, IEND. */
function pngOf(width: number, height: number): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buf: Buffer) => {
    let c = 0xffffffff;
    for (const b of buf) c = crcTable[(c ^ b) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
    const c = Buffer.alloc(4);
    c.writeUInt32BE(crc(td));
    return Buffer.concat([len, td, c]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0; // gråskala
  const raw = Buffer.alloc((width + 1) * height, 0xff);
  for (let y = 0; y < height; y += 1) raw[y * (width + 1)] = 0;
  // zlib med "stored"-block (ingen komprimering).
  const adler = (() => {
    let a = 1;
    let b = 0;
    for (const x of raw) {
      a = (a + x) % 65521;
      b = (b + a) % 65521;
    }
    const out = Buffer.alloc(4);
    out.writeUInt32BE(((b << 16) | a) >>> 0);
    return out;
  })();
  const stored = Buffer.alloc(5);
  stored[0] = 1;
  stored.writeUInt16LE(raw.length, 1);
  stored.writeUInt16LE(~raw.length & 0xffff, 3);
  const idat = Buffer.concat([Buffer.from([0x78, 0x01]), stored, raw, adler]);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");
/** Låtsas-PDF: unik per HTML, så att avtalet och den signerade PDF:en får olika filer. */
const renderPdf = async (html: string) => new TextEncoder().encode(`%PDF-1.4\n% ${sha(html)}\n`);

let owner: TestUser;
let orgId: string;
let viewer: Viewer;
let files: LocalFileStore;

async function viewerFor(u: TestUser, org: string): Promise<Viewer> {
  const user: SessionUser = { userId: u.id, email: u.email };
  const organization = (await listOrganizationsFor(user)).find((o) => o.id === org);
  if (!organization) throw new Error("Saknar medlemskap");
  return { user, organization };
}

let storeCounter = 0;
/** Ett nytt mallavtal (med PDF) i organisationen. */
async function newContract(v: Viewer = viewer, u: TestUser = owner): Promise<string> {
  storeCounter += 1;
  const storeId = await asUser(u, async (tx) => {
    const [st] = await tx
      .insert(s.stores)
      .values({
        organizationId: v.organization.id,
        name: `Butik ${storeCounter} ${uniqueSuffix()}`,
      })
      .returning();
    return st!.id;
  });
  const res = await createStoreContractFor(
    v,
    { target: `store:${storeId}`, validFrom: TODAY },
    { today: TODAY, renderPdf, fileStore: files },
  );
  if (!res.ok) throw new Error("avtalet skapades inte");
  return res.contractId;
}

const linkDeps = () => ({ renderPdf, fileStore: files });
const pubDeps = () => ({ store: files, renderPdf });
const signInput = (documentSha256: string, extra: Partial<Record<string, unknown>> = {}) => ({
  signerName: "  Anna   Andersson ",
  signature: SIGNATURE,
  documentSha256,
  ip: "203.0.113.7",
  userAgent: "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)",
  ...extra,
});

async function validDoc(token: string): Promise<string> {
  const d = await describeSigningLink(token);
  if (d.status !== "valid") throw new Error(`länken är ${d.status}`);
  return d.documentSha256;
}

async function expectSigningError(p: Promise<unknown>, code: SigningError["code"]) {
  const error = await p.then(
    () => null,
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(SigningError);
  expect((error as SigningError).code).toBe(code);
}

beforeAll(async () => {
  owner = await createUser(`signera-${uniqueSuffix()}@test.binderlab.se`);
  orgId = await createOrg(owner, `Signering ${uniqueSuffix()}`);
  viewer = await viewerFor(owner, orgId);
  files = new LocalFileStore(mkdtempSync(path.join(tmpdir(), "signera-")));
});

describe("hela flödet", () => {
  it("länk → PDF → signatur → signerad PDF, för båda parter", async () => {
    const contractId = await newContract();
    const { token, expiresAt } = await createSigningLinkFor(viewer, contractId, linkDeps());
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt.getTime() - Date.now()).toBeGreaterThan(6.9 * 86_400_000);

    // Bara hashen sparas; HTML:en som PDF:en skrevs ut från sparas med länken.
    const [link] = await asUser(owner, (tx) =>
      tx
        .select()
        .from(s.contractSigningLinks)
        .where(eq(s.contractSigningLinks.contractId, contractId)),
    );
    expect(link!.tokenHash).toBe(sha(token));
    expect(link!.tokenHash).not.toContain(token);
    expect(link!.snapshotHtml).toContain("Placeringsavtal");
    const [c0] = await asUser(owner, (tx) =>
      tx.select().from(s.contracts).where(eq(s.contracts.id, contractId)),
    );
    expect(c0!.sentAt).not.toBeNull();
    expect(link!.documentSha256).toBe(c0!.fileSha256);

    const d = await describeSigningLink(token);
    expect(d.status).toBe("valid");
    if (d.status !== "valid") return;
    expect(d.organizationName).toMatch(/^Signering/);
    expect(d.terms).toContain("Vinstdelning");

    const doc = await readSigningDocument(token, pubDeps());
    expect(sha(doc.bytes)).toBe(d.documentSha256);

    const res = await signWithLink(token, signInput(d.documentSha256), pubDeps());
    expect(res.signerName).toBe("Anna Andersson");
    expect(res.pdf).toBe(true);

    const [c] = await asUser(owner, (tx) =>
      tx.select().from(s.contracts).where(eq(s.contracts.id, contractId)),
    );
    expect(c!.signedAt).not.toBeNull();
    const [sig] = await asUser(owner, (tx) =>
      tx.select().from(s.contractSignatures).where(eq(s.contractSignatures.contractId, contractId)),
    );
    expect(sig).toMatchObject({
      signerName: "Anna Andersson",
      ip: "203.0.113.7",
      documentSha256: d.documentSha256,
    });
    expect(sig!.userAgent).toContain("iPhone");
    expect(sig!.signedFilePath).toBe(`${orgId}/${contractId}/${sig!.signedFileSha256}.pdf`);

    // Butiken laddar ner med länken, ägaren under Avtal: samma fil.
    const forStore = await signedDocumentForLink(token, pubDeps());
    const forOwner = await signedDocumentFor(viewer, contractId, pubDeps());
    expect(forStore.kind).toBe("pdf");
    expect(forOwner.kind).toBe("pdf");
    if (forStore.kind === "pdf" && forOwner.kind === "pdf") {
      expect(sha(forStore.bytes)).toBe(sig!.signedFileSha256);
      expect(sha(forOwner.bytes)).toBe(sig!.signedFileSha256);
      expect(forStore.fileName).toMatch(/^Signerat avtal Butik/);
    }
    expect((await describeSigningLink(token)).status).toBe("signed");
    const map = await loadContractSignaturesFor(viewer);
    expect(map.get(contractId)?.signerName).toBe("Anna Andersson");

    // Ett signerat avtal får ingen ny länk.
    await expect(createSigningLinkFor(viewer, contractId, linkDeps())).rejects.toThrow(
      "redan signerat",
    );
  });

  it("utan PDF-utskrift: signaturbladet som HTML, och PDF:en skrivs ut senare", async () => {
    const contractId = await newContract();
    const { token } = await createSigningLinkFor(viewer, contractId, {
      renderPdf: null,
      fileStore: files,
    });
    const doc = await validDoc(token);
    const res = await signWithLink(token, signInput(doc), { store: files, renderPdf: null });
    expect(res.pdf).toBe(false);
    const html = await signedDocumentForLink(token, { store: files, renderPdf: null });
    expect(html.kind).toBe("html");
    if (html.kind === "html") {
      expect(html.html).toContain("Signaturblad");
      expect(html.html).toContain("Anna Andersson");
      expect(html.html).toContain(doc);
      expect(html.html).toContain("data:image/png;base64,");
    }
    const pdf = await signedDocumentFor(viewer, contractId, pubDeps());
    expect(pdf.kind).toBe("pdf");
  });
});

describe("länken är engångs och tidsbegränsad", () => {
  it("andra signeringen nekas", async () => {
    const contractId = await newContract();
    const { token } = await createSigningLinkFor(viewer, contractId, linkDeps());
    const doc = await validDoc(token);
    await signWithLink(token, signInput(doc), pubDeps());
    await expectSigningError(signWithLink(token, signInput(doc), pubDeps()), "used");
  });

  it("två samtidiga signeringar: exakt en lyckas", async () => {
    const contractId = await newContract();
    const { token } = await createSigningLinkFor(viewer, contractId, linkDeps());
    const doc = await validDoc(token);
    const results = await Promise.allSettled([
      signWithLink(token, signInput(doc, { signerName: "Första" }), pubDeps()),
      signWithLink(token, signInput(doc, { signerName: "Andra" }), pubDeps()),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const { n } = await one<{ n: number }>(
      db(),
      sql`select count(*)::int as n from public.contract_signatures where contract_id = ${contractId}`,
    );
    expect(n).toBe(1);
  });

  it("utgången länk: sidan säger det och signeringen nekas", async () => {
    const contractId = await newContract();
    const { token } = await createSigningLinkFor(viewer, contractId, linkDeps());
    const doc = await validDoc(token);
    await asPostgres((tx) =>
      tx.execute(
        sql`update public.contract_signing_links set expires_at = now() - interval '1 second'
            where contract_id = ${contractId}`,
      ),
    );
    expect((await describeSigningLink(token)).status).toBe("expired");
    await expectSigningError(readSigningDocument(token, pubDeps()), "missing");
    await expectSigningError(signWithLink(token, signInput(doc), pubDeps()), "expired");
  });

  it("en ny länk ersätter den förra", async () => {
    const contractId = await newContract();
    const first = await createSigningLinkFor(viewer, contractId, linkDeps());
    const second = await createSigningLinkFor(viewer, contractId, linkDeps());
    expect((await describeSigningLink(first.token)).status).toBe("missing");
    await expectSigningError(
      signWithLink(first.token, signInput("0".repeat(64)), pubDeps()),
      "missing",
    );
    expect((await describeSigningLink(second.token)).status).toBe("valid");
  });

  it("länken laddar ner den signerade PDF:en bara i 30 dagar", async () => {
    const contractId = await newContract();
    const { token } = await createSigningLinkFor(viewer, contractId, linkDeps());
    await signWithLink(token, signInput(await validDoc(token)), pubDeps());
    await asPostgres(async (tx) => {
      await tx.execute(sql`alter table public.contract_signatures disable trigger t10_guard`);
      await tx.execute(
        sql`update public.contract_signatures set signed_at = now() - interval '31 days'
            where contract_id = ${contractId}`,
      );
      await tx.execute(sql`alter table public.contract_signatures enable trigger t10_guard`);
    });
    expect((await describeSigningLink(token)).status).toBe("used");
    await expectSigningError(signedDocumentForLink(token, pubDeps()), "missing");
    // Ägaren har den kvar.
    expect((await signedDocumentFor(viewer, contractId, pubDeps())).kind).toBe("pdf");
  });
});

describe("manipulering", () => {
  it("ändrad, för kort eller påhittad token känns inte igen", async () => {
    const contractId = await newContract();
    const { token } = await createSigningLinkFor(viewer, contractId, linkDeps());
    const doc = await validDoc(token);
    const flipped = (token[0] === "a" ? "b" : "a") + token.slice(1);
    for (const t of [flipped, token.slice(1), token.toUpperCase(), `${token}0`, "", "../x"]) {
      expect((await describeSigningLink(t)).status).toBe("missing");
      await expectSigningError(signWithLink(t, signInput(doc), pubDeps()), "missing");
      await expectSigningError(readSigningDocument(t, pubDeps()), "missing");
    }
    // Hashen i stället för token fungerar inte heller.
    expect((await describeSigningLink(sha(token))).status).toBe("missing");
  });

  it("fel kontrollsumma för PDF:en nekas", async () => {
    const contractId = await newContract();
    const { token } = await createSigningLinkFor(viewer, contractId, linkDeps());
    await expectSigningError(signWithLink(token, signInput("f".repeat(64)), pubDeps()), "changed");
    await expectSigningError(
      signWithLink(token, signInput(undefined as unknown as string), pubDeps()),
      "changed",
    );
    expect((await describeSigningLink(token)).status).toBe("valid");
  });

  it("avtalets PDF byts efter att länken skapades: länken slutar gälla", async () => {
    const contractId = await newContract();
    const { token } = await createSigningLinkFor(viewer, contractId, linkDeps());
    const doc = await validDoc(token);
    await attachContractFileFor(
      viewer,
      { contractId, fileName: "annat.pdf", bytes: new TextEncoder().encode("%PDF-1.4\n% annat\n") },
      { fileStore: files },
    );
    expect((await describeSigningLink(token)).status).toBe("changed");
    await expectSigningError(signWithLink(token, signInput(doc), pubDeps()), "changed");
  });

  it("filen i lagringen manipuleras: PDF:en visas inte", async () => {
    const contractId = await newContract();
    const { token } = await createSigningLinkFor(viewer, contractId, linkDeps());
    const [c] = await asUser(owner, (tx) =>
      tx.select().from(s.contracts).where(eq(s.contracts.id, contractId)),
    );
    const other = new LocalFileStore(mkdtempSync(path.join(tmpdir(), "signera-x-")));
    await other.put(c!.storagePath!, new TextEncoder().encode("%PDF-1.4\n% falsk\n"));
    await expectSigningError(readSigningDocument(token, { store: other }), "changed");
  });

  it("ogiltig signatur eller namn nekas och länken går fortfarande att använda", async () => {
    const contractId = await newContract();
    const { token } = await createSigningLinkFor(viewer, contractId, linkDeps());
    const doc = await validDoc(token);
    const bad: Record<string, unknown>[] = [
      { signerName: "" },
      { signerName: "A" },
      { signerName: "x".repeat(101) },
      { signature: null },
      { signature: "data:image/svg+xml;base64,PHN2Zz4=" },
      { signature: `data:image/png;base64,${Buffer.from("<script>").toString("base64")}` },
      // 1×1: för liten för en signatur.
      {
        signature:
          "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
      },
      { signature: `data:image/png;base64,${"A".repeat(500_000)}` },
    ];
    for (const extra of bad) {
      await expectSigningError(signWithLink(token, signInput(doc, extra), pubDeps()), "invalid");
    }
    expect((await describeSigningLink(token)).status).toBe("valid");
  });

  it("databasen nekar en signatur som inte är PNG även om servern skulle släppa igenom den", async () => {
    const contractId = await newContract();
    const { token } = await createSigningLinkFor(viewer, contractId, linkDeps());
    const doc = await validDoc(token);
    const outcome = await asPostgres((tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`select private.contract_signing_sign(${token}, ${doc}, 'Anna', ${Buffer.from("GIF89a".repeat(20))}::bytea, null, null)`,
        ),
      ),
    );
    expect(outcome.code).toBe("BL074");
  });

  it("signaturen kan inte ändras och den signerade PDF:en knyts bara en gång", async () => {
    const contractId = await newContract();
    const { token } = await createSigningLinkFor(viewer, contractId, linkDeps());
    await signWithLink(token, signInput(await validDoc(token)), pubDeps());
    const [sig] = await rows<{ id: string }>(
      db(),
      sql`select id from public.contract_signatures where contract_id = ${contractId}`,
    );
    const rename = await asPostgres((tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.contract_signatures set signer_name = 'Någon annan' where id = ${sig!.id}`,
        ),
      ),
    );
    expect(rename.code).toBe("BL075");
    const again = await one<{ ok: boolean }>(
      db(),
      sql`select private.contract_signing_attach(${sig!.id}::uuid,
            ${`${orgId}/${contractId}/${"a".repeat(64)}.pdf`}, ${"a".repeat(64)}, 10::bigint) as ok`,
    );
    expect(again.ok).toBe(false);
    const del = await asPostgres((tx) =>
      attempt(tx, (sp) =>
        sp.execute(sql`delete from public.contract_signatures where id = ${sig!.id}`),
      ),
    );
    expect(del.ok).toBe(false);
  });

  it("ett signerat avtal kan inte byta fil eller bli osignerat", async () => {
    const contractId = await newContract();
    const { token } = await createSigningLinkFor(viewer, contractId, linkDeps());
    await signWithLink(token, signInput(await validDoc(token)), pubDeps());
    await expect(
      attachContractFileFor(
        viewer,
        { contractId, fileName: "annat.pdf", bytes: new TextEncoder().encode("%PDF-1.4\n% x\n") },
        { fileStore: files },
      ),
    ).rejects.toThrow();
    await expect(
      setContractStatusFor(viewer, { id: contractId, status: "draft" }),
    ).rejects.toThrow();
    const [c] = await rows<{ signed_at: Date | null; file_sha256: string }>(
      db(),
      sql`select signed_at, file_sha256 from public.contracts where id = ${contractId}`,
    );
    expect(c!.signed_at).not.toBeNull();
    const [sig] = await rows<{ document_sha256: string }>(
      db(),
      sql`select document_sha256 from public.contract_signatures where contract_id = ${contractId}`,
    );
    expect(c!.file_sha256).toBe(sig!.document_sha256);
    // Arkivera går fortfarande.
    await asPostgres((tx) =>
      tx.execute(sql`update public.contracts set archived_at = now() where id = ${contractId}`),
    );
  });
});

describe("roller och organisationer", () => {
  it("läsare och påfyllare kan inte skapa länkar", async () => {
    const contractId = await newContract();
    for (const role of ["viewer", "refiller"] as const) {
      const u = await createMember(orgId, role);
      const v = await viewerFor(u, orgId);
      await expect(createSigningLinkFor(v, contractId, linkDeps())).rejects.toThrow();
      const outcome = await asUser(u, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`select public.create_contract_signing_link(${orgId}::uuid, ${contractId}::uuid,
                  ${"1".repeat(64)}, ${"2".repeat(64)}, null, 7)`,
          ),
        ),
      );
      expect(outcome.code).toBe("42501");
    }
  });

  it("en annan organisations ägare når varken länkar, signaturer eller PDF", async () => {
    const contractId = await newContract();
    const { token } = await createSigningLinkFor(viewer, contractId, linkDeps());
    await signWithLink(token, signInput(await validDoc(token)), pubDeps());

    const other = await createUser(`signera-b-${uniqueSuffix()}@test.binderlab.se`);
    const orgB = await createOrg(other, `Annan ${uniqueSuffix()}`);
    const vB = await viewerFor(other, orgB);

    // Peka B:s organisation mot A:s avtal, eller A:s organisation direkt.
    for (const org of [orgB, orgId]) {
      const outcome = await asUser(other, (tx) =>
        attempt(tx, (sp) =>
          sp.execute(
            sql`select public.create_contract_signing_link(${org}::uuid, ${contractId}::uuid,
                  ${"3".repeat(64)}, ${"4".repeat(64)}, null, 7)`,
          ),
        ),
      );
      expect(outcome.ok).toBe(false);
      expect(["42501", "BL070"]).toContain(outcome.code);
    }
    await expect(createSigningLinkFor(vB, contractId, linkDeps())).rejects.toBeInstanceOf(
      ContractError,
    );
    const seen = await asUser(other, async (tx) => ({
      links: await tx
        .select()
        .from(s.contractSigningLinks)
        .where(eq(s.contractSigningLinks.organizationId, orgId)),
      sigs: await tx
        .select()
        .from(s.contractSignatures)
        .where(eq(s.contractSignatures.organizationId, orgId)),
    }));
    expect(seen.links).toHaveLength(0);
    expect(seen.sigs).toHaveLength(0);
    await expectSigningError(signedDocumentFor(vB, contractId, pubDeps()), "missing");
  });

  it("påfyllaren ser inga signaturer; läsaren ser dem", async () => {
    const refiller = await createMember(orgId, "refiller");
    const reader = await createMember(orgId, "viewer");
    const count = (u: TestUser) =>
      asUser(u, (tx) =>
        one<{ n: number }>(
          tx,
          sql`select count(*)::int as n from public.contract_signatures where organization_id = ${orgId}`,
        ),
      );
    expect((await count(refiller)).n).toBe(0);
    expect((await count(reader)).n).toBeGreaterThan(0);
  });

  it("funktionerna i private kan inte köras av anon, inloggade eller service_role", async () => {
    const calls = [
      sql`select private.contract_signing_lookup('x')`,
      sql`select private.contract_signing_sign('x', 'x', 'x', '\\x00'::bytea, null, null)`,
      sql`select private.contract_signing_attach(gen_random_uuid(), 'x', 'x', 1)`,
    ];
    for (const q of calls) {
      expect((await asAnon((tx) => attempt(tx, (sp) => sp.execute(q)))).code).toBe("42501");
      expect((await asUser(owner, (tx) => attempt(tx, (sp) => sp.execute(q)))).code).toBe("42501");
      expect((await asServiceRole((tx) => attempt(tx, (sp) => sp.execute(q)))).code).toBe("42501");
    }
    const anonCreate = await asAnon((tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`select public.create_contract_signing_link(gen_random_uuid(), gen_random_uuid(), 'x', 'x', null, 7)`,
        ),
      ),
    );
    expect(anonCreate.code).toBe("42501");
  });

  it("ingen klientroll kan skriva länkar eller signaturer direkt", async () => {
    const contractId = await newContract();
    const insert = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`insert into public.contract_signing_links
                (organization_id, contract_id, token_hash, document_sha256, expires_at)
              values (${orgId}, ${contractId}, ${"5".repeat(64)}, ${"6".repeat(64)}, now() + interval '1 day')`,
        ),
      ),
    );
    expect(insert.code).toBe("42501");
    const update = await asUser(owner, (tx) =>
      attempt(tx, (sp) =>
        sp.execute(
          sql`update public.contract_signing_links set expires_at = now() + interval '1 year'
              where organization_id = ${orgId}`,
        ),
      ),
    );
    expect(update.code).toBe("42501");
  });
});

describe("routerna och server action för /signera", () => {
  it("GET /signera/{token}/avtal: PDF för en giltig länk, 404 annars; inget i cache", async () => {
    const contractId = await newContract();
    // Routerna läser lagringen enligt CONTRACT_FILE_STORE/CONTRACT_FILE_DIR.
    process.env.CONTRACT_FILE_STORE = "local";
    process.env.CONTRACT_FILE_DIR = files.root;
    const { token } = await createSigningLinkFor(viewer, contractId, linkDeps());
    const { GET } = await import("@/app/signera/[token]/avtal/route");
    const ok = await GET(new Request("http://x/"), { params: Promise.resolve({ token }) });
    expect(ok.status).toBe(200);
    expect(ok.headers.get("content-type")).toBe("application/pdf");
    expect(ok.headers.get("cache-control")).toContain("no-store");
    expect(ok.headers.get("x-robots-tag")).toContain("noindex");
    expect(ok.headers.get("referrer-policy")).toBe("no-referrer");
    const bad = await GET(new Request("http://x/"), {
      params: Promise.resolve({ token: "0".repeat(64) }),
    });
    expect(bad.status).toBe(404);

    const signed = await import("@/app/signera/[token]/signerad/route");
    const before = await signed.GET(new Request("http://x/"), {
      params: Promise.resolve({ token }),
    });
    expect(before.status).toBe(404);
  });

  it("signContract: kräver krysset, sparar IP och webbläsare från förfrågan", async () => {
    const contractId = await newContract();
    process.env.CONTRACT_FILE_STORE = "local";
    process.env.CONTRACT_FILE_DIR = files.root;
    process.env.PDF_RENDERER = "off";
    const { token } = await createSigningLinkFor(viewer, contractId, linkDeps());
    const doc = await validDoc(token);
    const { signContract } = await import("@/app/signera/[token]/actions");
    req.headers.set("x-real-ip", "198.51.100.9");
    req.headers.set("user-agent", "Testwebbläsare/1.0");
    const form = new FormData();
    form.set("name", "Bo Butiksägare");
    form.set("signature", SIGNATURE);
    form.set("document", doc);
    const noAccept = await signContract(token, form);
    expect(noAccept.ok).toBe(false);
    form.set("accept", "1");
    const res = await signContract(token, form);
    expect(res.ok).toBe(true);
    const [sig] = await asUser(owner, (tx) =>
      tx
        .select()
        .from(s.contractSignatures)
        .where(
          and(
            eq(s.contractSignatures.organizationId, orgId),
            eq(s.contractSignatures.contractId, contractId),
          ),
        ),
    );
    expect(sig).toMatchObject({ ip: "198.51.100.9", userAgent: "Testwebbläsare/1.0" });
    const again = await signContract(token, form);
    expect(again).toMatchObject({ ok: false, code: "used" });
    // Den signerade (här HTML, utan PDF-utskrift) laddas ner med länken.
    const signed = await import("@/app/signera/[token]/signerad/route");
    const r = await signed.GET(new Request("http://x/"), { params: Promise.resolve({ token }) });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await r.text()).toContain("Bo Butiksägare");
  });
});
