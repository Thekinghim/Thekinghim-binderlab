/**
 * Röd granskning fas 7: varje server action anropad med fel roll, från fel
 * organisation, utan medlemskap och utloggad.
 *
 * Hela stacken är riktig (dev-sessionscookie → session.ts → requireRole/RLS); bara
 * Nexts förfrågan är fejkad (se redteam-fas7-harness.ts). För varje action i
 * redteam-fas7-catalog.ts och varje person som INTE får göra ändringen:
 *   - anropet nekas; för roller i A ska det vara ett BEHÖRIGHETSNEJ (rollkontrollen
 *     nåddes, inte ett valideringsfel som döljer att den saknas),
 *   - inget i organisationen A ändras (fingeravtryck av alla organisationsbundna
 *     tabeller och storage.objects före och efter),
 *   - en utomstående (ägare i B) anropar med A:s id:n (IDOR): A ändras inte och
 *     svaret innehåller inga av A:s id:n utöver dem hon själv skickade.
 * Därtill: actions med FormData (filuppladdning), larm/push, butiksportalen,
 * inloggningens actions (öppen omdirigering, gräns för försök) och att påfyllarens
 * svar aldrig bär belopp.
 */

import { mkdtempSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it, vi } from "vitest";

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

import { hashPassword } from "@/server/auth/password";

import { db, one, orgScopedTables, rows } from "./helpers";
import { ACTIONS, sink, type ActionSpec } from "./redteam-fas7-catalog";
import {
  call,
  changedTables,
  fingerprint,
  isAuthDenial,
  isDenied,
  keysDeep,
  loginAs,
  MONEY_KEY,
  NextSignal,
  seedCast,
  type Cast,
  type PersonaName,
} from "./redteam-fas7-harness";

// Avtalsfiler och importfiler hamnar i en egen katalog, inte i projektets .data.
const FILE_DIR = mkdtempSync(path.join(tmpdir(), "rt7-files-"));
process.env.CONTRACT_FILE_DIR = path.join(FILE_DIR, "contracts");
process.env.CONTRACT_FILE_STORE = "local";
process.env.IMPORT_FILE_STORE = "local";
process.env.IMPORT_FILE_DIR = path.join(FILE_DIR, "imports");

const ALL_PERSONAS: PersonaName[] = [
  "owner",
  "admin",
  "viewer",
  "refiller",
  "store",
  "outsider",
  "stranger",
  "anon",
];
/** Personer med en approll i A: nejet ska komma från rollkontrollen. */
const IN_ORG: PersonaName[] = ["owner", "admin", "viewer", "refiller"];

let cast: Cast;
/** Alla id:n i A (alla organisationsbundna tabeller) och A:s organisations-id. */
let allIdsA: Set<string>;

beforeAll(async () => {
  cast = await seedCast();
  allIdsA = new Set([cast.A.orgId]);
  for (const table of await orgScopedTables()) {
    const has = await rows(
      db(),
      sql`select 1 from information_schema.columns
          where table_schema = 'public' and table_name = ${table} and column_name = 'id'`,
    );
    if (has.length === 0) continue;
    for (const r of await rows<{ id: string }>(
      db(),
      sql`select id::text as id from ${sql.identifier("public")}.${sql.identifier(table)}
          where organization_id = ${cast.A.orgId}`,
    )) {
      allIdsA.add(r.id);
    }
  }
}, 180_000);

async function load(spec: { module: string; name: string }) {
  const mod = (await import(/* @vite-ignore */ spec.module)) as Record<string, unknown>;
  const fn = mod[spec.name];
  if (typeof fn !== "function") throw new Error(`${spec.module} saknar ${spec.name}`);
  return fn as (...args: unknown[]) => Promise<unknown>;
}

/** A:s id:n i svaret som inte fanns i anropet. */
function leakedIdsOfA(args: unknown[], outcome: unknown): string[] {
  const sent = JSON.stringify(args);
  const got = JSON.stringify(outcome) ?? "";
  const uuids = got.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? [];
  return [...new Set(uuids)].filter((u) => allIdsA.has(u) && !sent.includes(u));
}

// ---------------------------------------------------------------------------
// 0. Alla server actions finns i katalogen eller testas särskilt nedan
// ---------------------------------------------------------------------------

/** Actions som testas i egna block i den här filen (inte i matrisen). */
const SPECIAL = new Set([
  "@/app/(app)/datakallor/actions#uploadChunk",
  "@/app/(app)/avtal/actions#uploadContractFile",
  "@/app/(app)/ekonomi/actions#uploadPayoutFile",
  "@/app/(app)/drift/actions#saveAlertSubscription",
  "@/app/(app)/drift/actions#savePushDevice",
  "@/app/(app)/drift/actions#sendTestAlert",
  "@/server/portal/actions#reportFault",
  "@/server/portal/actions#selectPortalStore",
  "@/server/actions/auth#login",
  "@/server/actions/auth#logout",
  "@/server/actions/auth#acceptInvite",
  "@/server/actions/auth#switchOrganization",
  // Eget lösenord (ingen organisation); testas i test/db/auth-flows.test.ts.
  "@/server/actions/auth#changePassword",
  // Eget språk (bara den egna profilen, ingen organisation); testas i test/db/enkel-vy.test.ts.
  "@/server/actions/locale#setMyLocale",
  "@/app/logga-in/actions#signIn",
  "@/app/logga-in/actions#requestMagicLink",
  "@/app/logga-in/actions#confirmMagicLink",
  // Inloggning utan organisation (egen inbjudan, eget lösenord via länk); testas i
  // test/db/auth-flows.test.ts, src/server/auth/flows.test.ts och supabase-link.test.ts.
  "@/server/actions/auth#acceptMyInvitation",
  "@/server/actions/auth#sendOwnPasswordLink",
  "@/app/logga-in/actions#requestPasswordReset",
  "@/app/logga-in/actions#setNewPassword",
  "@/app/inbjudan/[token]/actions#acceptInvitation",
  // Signering på plats utan inloggning (token är beviset); testas i test/db/avtal-signering.test.ts.
  "@/app/signera/[token]/actions#signContract",
  // Ägs av fas 7 del 1 (onboarding); testas i test/db/redteam-onboarding.test.ts.
  "@/server/onboarding/actions#createOrganization",
  // AI-panelens läsningar svarar mjukt (status/tomt) i stället för att neka; eget block nedan.
  "@/app/(app)/assistent/panel-actions#assistantPanelState",
  "@/app/(app)/assistent/panel-actions#pageTips",
]);

describe("katalogen", () => {
  it("varje exporterad server action (alla filer med 'use server') är med", async () => {
    const { execSync } = await import("node:child_process");
    const files = execSync(`grep -rl '"use server"' src`, { encoding: "utf8" })
      .trim()
      .split("\n")
      .filter((f) => !f.includes(".test."));
    const known = new Set([...ACTIONS.map((a) => `${a.module}#${a.name}`), ...SPECIAL]);
    const missing: string[] = [];
    for (const file of files) {
      const specifier = `@/${file.replace(/^src\//, "").replace(/\.tsx?$/, "")}`;
      const mod = (await import(/* @vite-ignore */ specifier)) as Record<string, unknown>;
      for (const [name, value] of Object.entries(mod)) {
        if (typeof value === "function" && !known.has(`${specifier}#${name}`)) {
          missing.push(`${specifier}#${name}`);
        }
      }
    }
    expect(missing).toEqual([]);
  }, 120_000);
});

// ---------------------------------------------------------------------------
// 1. Matrisen: action × person som inte får
// ---------------------------------------------------------------------------

function label(spec: ActionSpec): string {
  return `${spec.module.replace("@/app/(app)/", "").replace("@/", "")}#${spec.name}`;
}

describe("fel roll, fel organisation, utan medlemskap och utloggad nekas och ändrar inget i A", () => {
  it.each(ACTIONS.map((spec) => [label(spec), spec] as const))(
    "%s",
    async (_label, spec) => {
      const fn = await load(spec);
      const problems: string[] = [];
      for (const p of ALL_PERSONAS) {
        if (spec.allowed.includes(p)) continue;
        const args = spec.args(cast);
        const before = await fingerprint(cast.A.orgId);
        await loginAs(req, cast.personas[p]);
        const outcome = await call(() => fn(...args));
        const changed = changedTables(before, await fingerprint(cast.A.orgId));
        if (changed.length > 0) problems.push(`${p}: ändrade ${changed.join(", ")} i A`);
        if (p === "outsider") {
          // B:s ägare agerar i sin egen organisation: får lyckas där, men aldrig röra
          // eller visa A.
          const leaked = leakedIdsOfA(args, outcome);
          if (leaked.length > 0) problems.push(`${p}: svaret innehåller A:s id ${leaked[0]}`);
          continue;
        }
        if (!isDenied(outcome)) {
          problems.push(`${p}: lyckades (${JSON.stringify(outcome).slice(0, 160)})`);
        } else if (IN_ORG.includes(p) && !isAuthDenial(outcome)) {
          problems.push(
            `${p}: nekades inte av rollkontrollen (${JSON.stringify(outcome).slice(0, 160)})`,
          );
        }
      }
      expect(problems).toEqual([]);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// 2. Filuppladdning (FormData)
// ---------------------------------------------------------------------------

function form(fields: Record<string, string | Blob>, fileName?: string): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (v instanceof Blob && fileName) f.set(k, v, fileName);
    else f.set(k, v);
  }
  return f;
}

const PDF = new TextEncoder().encode("%PDF-1.4\n1 0 obj<<>>endobj\ntrailer<<>>\n%%EOF\n");

describe("filuppladdning", () => {
  const uploads = [
    {
      module: "@/app/(app)/avtal/actions",
      name: "uploadContractFile",
      make: (c: Cast) => form({ contractId: c.A.contractId, file: new Blob([PDF]) }, "avtal.pdf"),
    },
    {
      module: "@/app/(app)/ekonomi/actions",
      name: "uploadPayoutFile",
      make: () =>
        form(
          {
            file: new Blob([
              "Referens;Period från;Period till;Utbetald;Belopp;Avgifter;Återbetalningar\r\nRT-1;2025-03-01;2025-03-31;2025-04-05;100,00;0;0\r\n",
            ]),
          },
          "utbetalning.csv",
        ),
    },
    {
      module: "@/app/(app)/datakallor/actions",
      name: "uploadChunk",
      make: (c: Cast) =>
        form({
          uploadId: c.idsA.import_uploads ?? crypto.randomUUID(),
          index: "0",
          chunk: new Blob(["a;b\r\n"]),
        }),
    },
  ];

  it.each(uploads.map((u) => [u.name, u] as const))(
    "%s: alla utom ägare och admin nekas av rollkontrollen och inget sparas",
    async (_name, u) => {
      const fn = await load(u);
      const problems: string[] = [];
      for (const p of ALL_PERSONAS.filter((x) => x !== "owner" && x !== "admin")) {
        const before = await fingerprint(cast.A.orgId);
        await loginAs(req, cast.personas[p]);
        const outcome = await call(() => fn(u.make(cast)));
        const changed = changedTables(before, await fingerprint(cast.A.orgId));
        if (changed.length > 0) problems.push(`${p}: ändrade ${changed.join(", ")}`);
        if (p !== "outsider" && !isDenied(outcome)) problems.push(`${p}: lyckades`);
        if (IN_ORG.includes(p) && !isAuthDenial(outcome))
          problems.push(`${p}: inte ett behörighetsnej (${JSON.stringify(outcome).slice(0, 120)})`);
      }
      expect(problems).toEqual([]);
    },
    120_000,
  );

  it("avtalsfilen: HTML med filnamnet avtal.pdf avvisas (typen kontrolleras mot innehållet)", async () => {
    const fn = await load({ module: "@/app/(app)/avtal/actions", name: "uploadContractFile" });
    await loginAs(req, cast.personas.owner);
    const html = new TextEncoder().encode("<html><script>alert(document.cookie)</script></html>");
    const outcome = await call(() =>
      fn(
        form(
          { contractId: cast.A.contractId, file: new Blob([html], { type: "application/pdf" }) },
          "avtal.pdf",
        ),
      ),
    );
    expect(outcome.kind).toBe("refused");
  });

  it("avtalsfilen: filnamnet styr aldrig sökvägen (../ och absoluta namn)", async () => {
    const fn = await load({ module: "@/app/(app)/avtal/actions", name: "uploadContractFile" });
    await loginAs(req, cast.personas.owner);
    const outcome = await call(() =>
      fn(
        form(
          { contractId: cast.A.contractId, file: new Blob([PDF]) },
          "../../../../tmp/rt7-pwned.pdf",
        ),
      ),
    );
    expect(outcome.kind).toBe("ok");
    const row = await one<{ storage_path: string | null; file_name: string | null }>(
      db(),
      sql`select storage_path, file_name from public.contracts where id = ${cast.A.contractId}`,
    );
    expect(row.storage_path).toMatch(
      new RegExp(`^${cast.A.orgId}/${cast.A.contractId}/[0-9a-f]{64}\\.pdf$`),
    );
    // Inget hamnade utanför katalogen för avtalsfiler.
    const top = await readdir(FILE_DIR);
    expect(top.every((name) => name === "contracts" || name === "imports")).toBe(true);
  });

  it("avtalsfilen: en utomstående kan inte bifoga en fil till A:s avtal", async () => {
    const fn = await load({ module: "@/app/(app)/avtal/actions", name: "uploadContractFile" });
    const before = await fingerprint(cast.A.orgId);
    await loginAs(req, cast.personas.outsider);
    const outcome = await call(() =>
      fn(form({ contractId: cast.A.contractId, file: new Blob([PDF]) }, "kapad.pdf")),
    );
    expect(outcome.kind).not.toBe("ok");
    expect(changedTables(before, await fingerprint(cast.A.orgId))).toEqual([]);
  });

  it("utbetalningsfilen: en binär fil (inte CSV) avvisas", async () => {
    const fn = await load({ module: "@/app/(app)/ekonomi/actions", name: "uploadPayoutFile" });
    await loginAs(req, cast.personas.owner);
    const before = await fingerprint(cast.A.orgId);
    const outcome = await call(() =>
      fn(form({ file: new Blob([new Uint8Array([0x4d, 0x5a, 0, 0, 0xff, 0xfe, 0, 1])]) }, "x.exe")),
    );
    expect(outcome.kind).toBe("refused");
    expect(changedTables(before, await fingerprint(cast.A.orgId))).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Larm och push: alla approller, men aldrig butiken, en icke-medlem eller utloggad
// ---------------------------------------------------------------------------

const SUBSCRIPTION = {
  kinds: [],
  allKinds: true,
  machineIds: [],
  allMachines: true,
  minSeverity: "info",
  channels: ["email"],
  phone: "",
  quiet: false,
  quietStart: "22:00",
  quietEnd: "07:00",
  window: false,
  windowDays: [],
  windowStart: "08:00",
  windowEnd: "17:00",
  criticalDuringQuiet: true,
  notifyResolved: false,
  reminders: false,
  active: true,
};

describe("larm och push-enheter", () => {
  it.each(["saveAlertSubscription", "savePushDevice", "sendTestAlert"])(
    "%s: butiken, en icke-medlem och en utloggad nekas och inget sparas i A",
    async (name) => {
      const fn = await load({ module: "@/app/(app)/drift/actions", name });
      const args =
        name === "saveAlertSubscription"
          ? [SUBSCRIPTION]
          : name === "savePushDevice"
            ? [
                {
                  endpoint: "https://fcm.googleapis.com/fcm/send/rt7",
                  keys: { p256dh: "x".repeat(40), auth: "y".repeat(16) },
                },
              ]
            : [];
      const problems: string[] = [];
      for (const p of ["store", "stranger", "anon"] as const) {
        const before = await fingerprint(cast.A.orgId);
        await loginAs(req, cast.personas[p]);
        const outcome = await call(() => fn(...args));
        if (!isDenied(outcome)) problems.push(`${p}: lyckades`);
        const changed = changedTables(before, await fingerprint(cast.A.orgId));
        if (changed.length > 0) problems.push(`${p}: ändrade ${changed.join(", ")}`);
      }
      expect(problems).toEqual([]);
    },
  );

  it("påfyllaren som ber om alla larm får bara automat- och lagerlarm (aldrig import, avvikande dag)", async () => {
    const fn = await load({ module: "@/app/(app)/drift/actions", name: "saveAlertSubscription" });
    await loginAs(req, cast.personas.refiller);
    await call(() => fn(SUBSCRIPTION));
    const saved = await rows<{ kinds: string[] | null }>(
      db(),
      sql`select kinds from public.alert_subscriptions
          where organization_id = ${cast.A.orgId} and user_id = ${cast.personas.refiller.user!.id}`,
    );
    for (const row of saved) {
      expect(row.kinds).not.toBeNull();
      expect(row.kinds!.some((k) => /import|deviat|avvik|data/.test(k))).toBe(false);
    }
  });

  it("push-endpoint till en intern adress avvisas (ingen SSRF via web-push)", async () => {
    const fn = await load({ module: "@/app/(app)/drift/actions", name: "savePushDevice" });
    await loginAs(req, cast.personas.owner);
    for (const endpoint of [
      "http://169.254.169.254/latest/meta-data/",
      "https://127.0.0.1:5432/x",
      "https://fcm.googleapis.com.evil.example/x",
      "https://localhost/x",
    ]) {
      const outcome = await call(() =>
        fn({ endpoint, keys: { p256dh: "x".repeat(40), auth: "y".repeat(16) } }),
      );
      expect(outcome.kind, endpoint).toBe("refused");
    }
  });
});

// ---------------------------------------------------------------------------
// 4. Butiksportalen: butiksanvändarens egna actions
// ---------------------------------------------------------------------------

describe("butiksportalen", () => {
  it("felanmälan: bara butiksanvändaren för just den butiken (inte operatörens roller, inte B)", async () => {
    const fn = await load({ module: "@/server/portal/actions", name: "reportFault" });
    const problems: string[] = [];
    const attempts: Array<[PersonaName, Record<string, unknown>]> = [
      [
        "owner",
        {
          storeId: cast.A.storeId,
          machineId: cast.A.machineId,
          kind: "store_other",
          description: "x",
        },
      ],
      [
        "refiller",
        {
          storeId: cast.A.storeId,
          machineId: cast.A.machineId,
          kind: "store_other",
          description: "x",
        },
      ],
      [
        "outsider",
        {
          storeId: cast.A.storeId,
          machineId: cast.A.machineId,
          kind: "store_other",
          description: "x",
        },
      ],
      [
        "stranger",
        {
          storeId: cast.A.storeId,
          machineId: cast.A.machineId,
          kind: "store_other",
          description: "x",
        },
      ],
      [
        "anon",
        {
          storeId: cast.A.storeId,
          machineId: cast.A.machineId,
          kind: "store_other",
          description: "x",
        },
      ],
      // Butiken i A anmäler fel på B:s butik eller automat.
      [
        "store",
        {
          storeId: cast.B.storeId,
          machineId: cast.B.machineId,
          kind: "store_other",
          description: "x",
        },
      ],
      [
        "store",
        {
          storeId: cast.A.storeId,
          machineId: cast.B.machineId,
          kind: "store_other",
          description: "x",
        },
      ],
    ];
    for (const [p, input] of attempts) {
      const beforeA = await fingerprint(cast.A.orgId);
      const beforeB = await fingerprint(cast.B.orgId);
      await loginAs(req, cast.personas[p]);
      const outcome = await call(() => fn(input));
      if (!isDenied(outcome)) problems.push(`${p} ${JSON.stringify(input).slice(0, 60)}: lyckades`);
      const changed = [
        ...changedTables(beforeA, await fingerprint(cast.A.orgId)).map((t) => `A.${t}`),
        ...changedTables(beforeB, await fingerprint(cast.B.orgId)).map((t) => `B.${t}`),
      ];
      if (changed.length > 0) problems.push(`${p}: ändrade ${changed.join(", ")}`);
    }
    expect(problems).toEqual([]);
  });

  it("välj butik: en annan organisations butik nekas och cookien sätts inte", async () => {
    const fn = await load({ module: "@/server/portal/actions", name: "selectPortalStore" });
    await loginAs(req, cast.personas.store);
    const outcome = await call(() => fn(cast.B.storeId));
    expect(outcome.kind).toBe("refused");
    expect(req.cookies.get("bl_portal_store")).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. Inloggningens actions
// ---------------------------------------------------------------------------

describe("inloggning och organisation", () => {
  it("switchOrganization till en organisation där man inte är medlem nekas (cookien ändras inte)", async () => {
    const fn = await load({ module: "@/server/actions/auth", name: "switchOrganization" });
    for (const p of ["viewer", "refiller", "store", "stranger"] as const) {
      await loginAs(req, cast.personas[p]);
      const cookieBefore = req.cookies.get("bl_org");
      const outcome = await call(() => fn(cast.B.orgId));
      expect(outcome.kind, p).not.toBe("ok");
      expect(req.cookies.get("bl_org"), p).toBe(cookieBefore);
    }
  });

  it("acceptInvite med en gissad eller annans token ger inget medlemskap", async () => {
    const fn = await load({ module: "@/server/actions/auth", name: "acceptInvite" });
    const before = await fingerprint(cast.A.orgId);
    for (const p of ["stranger", "outsider", "store"] as const) {
      await loginAs(req, cast.personas[p]);
      // Fixturens öppna inbjudan gäller en annan e-postadress.
      for (const token of [cast.A.invitationToken, "0".repeat(64), "../../x"]) {
        const outcome = await call(() => fn(token, {}));
        expect(outcome.kind, `${p} ${token.slice(0, 8)}`).not.toBe("ok");
      }
    }
    expect(changedTables(before, await fingerprint(cast.A.orgId))).toEqual([]);
  });

  describe("öppen omdirigering efter inloggning", () => {
    const PASSWORD = "rodteam-losenord-1234";
    beforeAll(async () => {
      const hash = await hashPassword(PASSWORD);
      await db().execute(
        sql`update auth.users set encrypted_password = ${hash} where id = ${cast.personas.viewer.user!.id}`,
      );
    });

    it.each([
      "//evil.example",
      "/\\evil.example",
      "https://evil.example",
      "/%2e%2e//evil.example",
      "/.//evil.example",
      "\\\\evil.example",
      "/%09/evil.example",
      "javascript:alert(1)",
      "/logga-in?next=//evil.example",
      " //evil.example",
    ])("next=%s skickar bara till en lokal sökväg", async (next) => {
      const signIn = await load({ module: "@/app/logga-in/actions", name: "signIn" });
      req.cookies.clear();
      req.headers.clear();
      req.headers.set("host", "localhost:3200");
      req.headers.set(
        "x-forwarded-for",
        `10.9.${Math.floor(Math.random() * 250)}.${Math.floor(Math.random() * 250)}`,
      );
      const f = new FormData();
      f.set("email", cast.personas.viewer.user!.email);
      f.set("password", PASSWORD);
      f.set("next", next);
      let target: string | null = null;
      try {
        await signIn({}, f);
      } catch (error) {
        if (error instanceof NextSignal) target = error.redirectTo;
        else throw error;
      }
      expect(target).not.toBeNull();
      expect(target!.startsWith("/")).toBe(true);
      expect(target!.startsWith("//")).toBe(false);
      expect(target!.startsWith("/\\")).toBe(false);
      expect(new URL(target!, "https://app.binderlab.se").host).toBe("app.binderlab.se");
    });
  });

  it("inloggningen: efter 5 fel från samma IP stoppas även rätt lösenord", async () => {
    const login = await load({ module: "@/server/actions/auth", name: "login" });
    const user = cast.personas.admin.user!;
    const password = "rodteam-admin-losen-1";
    await db().execute(
      sql`update auth.users set encrypted_password = ${await hashPassword(password)} where id = ${user.id}`,
    );
    req.cookies.clear();
    req.headers.clear();
    req.headers.set("x-forwarded-for", "203.0.113.77");
    for (let i = 0; i < 5; i += 1) {
      const o = await call(() => login({ email: user.email, password: `fel-${i}` }));
      expect(o.kind).toBe("refused");
    }
    const blocked = await call(() => login({ email: user.email, password }));
    expect(blocked.kind).toBe("refused");
    expect((blocked as { error: string }).error).toMatch(/För många/);
  });

  it("inloggningen: att byta X-Forwarded-For vid varje försök kringgår inte gränsen per konto", async () => {
    const login = await load({ module: "@/server/actions/auth", name: "login" });
    const user = cast.personas.refiller.user!;
    const password = "rodteam-pafyll-losen-1";
    await db().execute(
      sql`update auth.users set encrypted_password = ${await hashPassword(password)} where id = ${user.id}`,
    );
    for (let i = 0; i < 20; i += 1) {
      req.cookies.clear();
      req.headers.clear();
      req.headers.set("x-forwarded-for", `198.51.100.${i + 1}`);
      await call(() => login({ email: user.email, password: `fel-${i}` }));
    }
    req.headers.set("x-forwarded-for", "198.51.100.200");
    const blocked = await call(() => login({ email: user.email, password }));
    expect(blocked.kind).toBe("refused");
    expect((blocked as { error: string }).error).toMatch(/För många/);
  });
});

// ---------------------------------------------------------------------------
// 6. Påfyllaren får aldrig belopp i ett svar från en action
// ---------------------------------------------------------------------------

describe("påfyllarens svar bär inga belopp", () => {
  it("påfyllning, inventering, offline-synk och avbockning svarar utan belopp", async () => {
    await loginAs(req, cast.personas.refiller);
    const calls: Array<[string, string, unknown[]]> = [
      [
        "@/app/(app)/lager/actions",
        "registerRefill",
        [
          {
            machineId: cast.A.machineId,
            titleId: cast.A.titleId,
            quantity: 1,
            fromWarehouse: false,
          },
        ],
      ],
      [
        "@/app/(app)/lager/actions",
        "registerCount",
        [{ location: "machine", machineId: cast.A.machineId, titleId: cast.A.titleId, counted: 3 }],
      ],
      [
        "@/app/(app)/att-gora/actions",
        "registerRefill",
        [
          {
            machineId: cast.A.machineId,
            titleId: cast.A.titleId,
            quantity: 1,
            fromWarehouse: false,
          },
        ],
      ],
      [
        "@/app/(app)/drift/actions",
        "syncRefills",
        [
          [
            {
              clientId: crypto.randomUUID(),
              machineId: cast.A.machineId,
              titleId: cast.A.titleId,
              quantity: 1,
              fromWarehouse: false,
              occurredAt: new Date().toISOString(),
            },
          ],
        ],
      ],
      [
        "@/app/(app)/att-gora/actions",
        "dismissTodo",
        [sink(cast, { key: "stock:x:y", fingerprint: "z" })],
      ],
    ];
    const problems: string[] = [];
    for (const [module, name, args] of calls) {
      const fn = await load({ module, name });
      const outcome = await call(() => fn(...args));
      const money = [...keysDeep(outcome)].filter((k) => MONEY_KEY.test(k));
      if (money.length > 0) problems.push(`${name}: ${money.join(", ")}`);
      if (/\d\s?kr\b/.test(JSON.stringify(outcome))) problems.push(`${name}: belopp i text`);
    }
    expect(problems).toEqual([]);
  });

  it("orderlistan och orderdetaljen nekas påfyllaren även med giltiga id:n", async () => {
    await loginAs(req, cast.personas.refiller);
    const more = await load({ module: "@/app/(app)/order/actions", name: "loadMoreOrders" });
    const detail = await load({ module: "@/app/(app)/order/actions", name: "getOrderDetail" });
    for (const outcome of [
      await call(() => more("period=allt", { offset: 0, afterId: null })),
      await call(() => detail(cast.A.orderIds[0])),
    ]) {
      expect(outcome.kind).toBe("refused");
      expect([...keysDeep(outcome)].filter((k) => MONEY_KEY.test(k))).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// AI-panelen i skalet: bara läsning, mjukt nej, inget från A läcker
// ---------------------------------------------------------------------------

describe("AI-panelens läsningar", () => {
  const MODULE = "@/app/(app)/assistent/panel-actions";

  it("personer utan assistent får status forbidden och inga förslag; inget ändras", async () => {
    const state = await load({ module: MODULE, name: "assistantPanelState" });
    const tips = await load({ module: MODULE, name: "pageTips" });
    const problems: string[] = [];
    for (const p of ALL_PERSONAS) {
      const before = await fingerprint(cast.A.orgId);
      await loginAs(req, cast.personas[p]);
      const s = await call(() => state());
      const t = await call(() => tips());
      const changed = changedTables(before, await fingerprint(cast.A.orgId));
      if (changed.length > 0) problems.push(`${p}: ändrade ${changed.join(", ")} i A`);
      for (const outcome of IN_ORG.includes(p) ? [] : [s, t]) {
        const leaked = leakedIdsOfA([], outcome);
        if (leaked.length > 0) problems.push(`${p}: svaret innehåller A:s id ${leaked[0]}`);
      }
      if (p === "store" || p === "stranger" || p === "anon") {
        const status = s.kind === "ok" ? (s.value as { status?: string }).status : "nekad";
        if (status !== "forbidden" && status !== "nekad") problems.push(`${p}: status ${status}`);
        if (t.kind === "ok" && Object.keys(t.value as object).length > 0) {
          problems.push(`${p}: fick förslag`);
        }
      }
      if ((p === "viewer" || p === "refiller") && t.kind === "ok") {
        if (Object.keys(t.value as object).length > 0) problems.push(`${p}: fick förslag`);
      }
    }
    expect(problems).toEqual([]);
  }, 120_000);
});
