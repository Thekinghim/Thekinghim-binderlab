/**
 * requireRole/getActiveOrganization mot testdatabasen (under RLS).
 */

import { sql } from "drizzle-orm";
import { beforeAll, describe, expect, it } from "vitest";

import type { MemberRole } from "../../src/db/schema";
import {
  AuthorizationError,
  getRoleFor,
  listOrganizationsFor,
  requireRoleFor,
  resolveActiveOrganization,
  withUserDbFor,
  type SessionUser,
} from "../../src/server/access";
import {
  asPostgres,
  createMember,
  createOrg,
  createUser,
  one,
  rows,
  type TestUser,
} from "./helpers";

const ROLES: MemberRole[] = ["owner", "admin", "refiller", "viewer"];

const ROLE_SETS: MemberRole[][] = [
  ["owner"],
  ["owner", "admin"],
  ["owner", "admin", "viewer"],
  ["refiller"],
  ["owner", "admin", "refiller", "viewer"],
];

const session = (user: TestUser): SessionUser => ({ userId: user.id, email: user.email });

let orgA: string;
let orgB: string;
const members = new Map<MemberRole, TestUser>();
let outsider: TestUser;
let memberOfB: TestUser;

beforeAll(async () => {
  const owner = await createUser();
  orgA = await createOrg(owner, "Org A");
  members.set("owner", owner);
  for (const role of ["admin", "refiller", "viewer"] as const) {
    members.set(role, await createMember(orgA, role));
  }
  outsider = await createUser();
  memberOfB = await createUser();
  orgB = await createOrg(memberOfB, "Org B");
});

describe("requireRole-matris", () => {
  for (const role of ROLES) {
    for (const allowed of ROLE_SETS) {
      const expected = allowed.includes(role);
      it(`${role} mot [${allowed.join(", ")}] → ${expected ? "tillåts" : "nekas"}`, async () => {
        const user = session(members.get(role)!);
        if (expected) {
          await expect(requireRoleFor(user, orgA, allowed)).resolves.toBe(role);
        } else {
          await expect(requireRoleFor(user, orgA, allowed)).rejects.toBeInstanceOf(
            AuthorizationError,
          );
        }
      });
    }
  }

  it("nekar den som inte är medlem, och medlemmar i en annan organisation", async () => {
    await expect(requireRoleFor(session(outsider), orgA, ROLES)).rejects.toMatchObject({
      reason: "forbidden",
    });
    await expect(requireRoleFor(session(memberOfB), orgA, ROLES)).rejects.toMatchObject({
      reason: "forbidden",
    });
    await expect(requireRoleFor(session(members.get("owner")!), orgB, ROLES)).rejects.toThrow(
      "Du har inte behörighet till det här.",
    );
  });

  it("nekar ogiltigt id och okänd organisation utan att fråga om andras data", async () => {
    const owner = session(members.get("owner")!);
    await expect(requireRoleFor(owner, "inte-ett-uuid", ROLES)).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await expect(
      requireRoleFor(owner, "00000000-0000-4000-8000-000000000000", ROLES),
    ).rejects.toBeInstanceOf(AuthorizationError);
    await expect(requireRoleFor(owner, orgA, [])).rejects.toThrow(TypeError);
  });

  it("läser rollen under RLS: en förfalskad användare (sub) utan medlemskap ser ingenting", async () => {
    const ghost: SessionUser = { userId: crypto.randomUUID(), email: "spöke@example.se" };
    expect(await getRoleFor(ghost, orgA)).toBeNull();
  });

  it("följer en ändrad roll direkt", async () => {
    const user = await createMember(orgA, "viewer");
    await expect(requireRoleFor(session(user), orgA, ["admin"])).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    await asPostgres((tx) =>
      tx.execute(
        sql`update public.memberships set role = 'admin' where organization_id = ${orgA} and user_id = ${user.id}`,
      ),
    );
    await expect(requireRoleFor(session(user), orgA, ["admin"])).resolves.toBe("admin");
  });

  it("nekar alla roller i en arkiverad organisation", async () => {
    const owner = await createUser();
    const org = await createOrg(owner, "Arkiverad");
    await expect(requireRoleFor(session(owner), org, ["owner"])).resolves.toBe("owner");
    await asPostgres((tx) =>
      tx.execute(sql`update public.organizations set archived_at = now() where id = ${org}`),
    );
    await expect(requireRoleFor(session(owner), org, ["owner"])).rejects.toBeInstanceOf(
      AuthorizationError,
    );
    expect(await listOrganizationsFor(session(owner))).toEqual([]);
  });
});

describe("withUserDb", () => {
  it("kör som användaren (auth.uid, roll authenticated) med RLS", async () => {
    const owner = members.get("owner")!;
    const row = await withUserDbFor(session(owner), (tx) =>
      one<{ uid: string; role: string; email: string }>(
        tx,
        sql`select auth.uid()::text as uid, current_user::text as role, auth.jwt() ->> 'email' as email`,
      ),
    );
    expect(row).toEqual({ uid: owner.id, role: "authenticated", email: owner.email });

    const visible = await withUserDbFor(session(owner), (tx) =>
      rows<{ id: string }>(
        tx,
        sql`select id from public.organizations where id in (${orgA}, ${orgB})`,
      ),
    );
    expect(visible.map((r) => r.id)).toEqual([orgA]);
  });

  it("rullar tillbaka när funktionen kastar", async () => {
    const owner = members.get("owner")!;
    await expect(
      withUserDbFor(session(owner), async (tx) => {
        await tx.execute(sql`update public.organizations set name = 'Ändrad' where id = ${orgA}`);
        throw new Error("avbryt");
      }),
    ).rejects.toThrow("avbryt");
    const org = await asPostgres((tx) =>
      one<{ name: string }>(tx, sql`select name from public.organizations where id = ${orgA}`),
    );
    expect(org.name).toBe("Org A");
  });
});

describe("aktiv organisation", () => {
  it("använder cookien om användaren är medlem, annars den första", async () => {
    const user = await createUser();
    const first = await createOrg(user, "Första");
    const second = await createOrg(user, "Andra");

    expect((await resolveActiveOrganization(session(user), undefined))?.id).toBe(first);
    expect(await resolveActiveOrganization(session(user), second)).toMatchObject({
      id: second,
      name: "Andra",
      role: "owner",
      timezone: "Europe/Stockholm",
    });
    expect((await resolveActiveOrganization(session(user), second.toUpperCase()))?.id).toBe(second);
    // En organisation där användaren inte är medlem (eller skräp) ignoreras.
    expect((await resolveActiveOrganization(session(user), orgA))?.id).toBe(first);
    expect((await resolveActiveOrganization(session(user), "x"))?.id).toBe(first);
  });

  it("är null för den som saknar medlemskap", async () => {
    expect(await resolveActiveOrganization(session(outsider), orgA)).toBeNull();
  });

  it("listar bara egna organisationer med rätt roll", async () => {
    const viewer = members.get("viewer")!;
    expect(await listOrganizationsFor(session(viewer))).toEqual([
      expect.objectContaining({ id: orgA, role: "viewer" }),
    ]);
  });
});
