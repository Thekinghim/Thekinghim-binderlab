import { describe, expect, it } from "vitest";

import {
  LAST_OWNER_REASON,
  OWNER_ONLY_REASON,
  assignableRoles,
  canManageMembers,
  canRevokeInvitation,
  countByRole,
  headline,
  isMemberRole,
  memberName,
  memberPermissions,
  roleMeta,
} from "./model";

describe("assignableRoles", () => {
  it("ägare ger alla roller, admin alla utom ägare, övriga inga", () => {
    expect(assignableRoles("owner")).toEqual(["owner", "admin", "viewer", "refiller"]);
    expect(assignableRoles("admin")).toEqual(["admin", "viewer", "refiller"]);
    expect(assignableRoles("viewer")).toEqual([]);
    expect(assignableRoles("refiller")).toEqual([]);
  });

  it("bara ägare och admin hanterar medlemmar", () => {
    expect(canManageMembers("owner")).toBe(true);
    expect(canManageMembers("admin")).toBe(true);
    expect(canManageMembers("viewer")).toBe(false);
    expect(canManageMembers("refiller")).toBe(false);
  });
});

describe("memberPermissions", () => {
  it("sista ägaren kan varken byta roll eller tas bort, med förklaring", () => {
    expect(memberPermissions("owner", { role: "owner" }, 1)).toEqual({
      canChangeRole: false,
      canRemove: false,
      reason: LAST_OWNER_REASON,
    });
  });

  it("med två ägare får en ägare ändra och ta bort en ägare", () => {
    expect(memberPermissions("owner", { role: "owner" }, 2)).toEqual({
      canChangeRole: true,
      canRemove: true,
      reason: null,
    });
  });

  it("admin rör inte ägare men hanterar övriga", () => {
    expect(memberPermissions("admin", { role: "owner" }, 2).reason).toBe(OWNER_ONLY_REASON);
    expect(memberPermissions("admin", { role: "owner" }, 2).canRemove).toBe(false);
    expect(memberPermissions("admin", { role: "viewer" }, 1).canChangeRole).toBe(true);
    expect(memberPermissions("admin", { role: "admin" }, 1).canRemove).toBe(true);
  });

  it("läsare och påfyllare får inget och ser ingen förklaring", () => {
    for (const actor of ["viewer", "refiller"] as const) {
      expect(memberPermissions(actor, { role: "viewer" }, 1)).toEqual({
        canChangeRole: false,
        canRemove: false,
        reason: null,
      });
    }
  });
});

describe("canRevokeInvitation", () => {
  it("admin återkallar inte en ägarinbjudan", () => {
    expect(canRevokeInvitation("owner", { role: "owner" })).toBe(true);
    expect(canRevokeInvitation("admin", { role: "owner" })).toBe(false);
    expect(canRevokeInvitation("admin", { role: "refiller" })).toBe(true);
    expect(canRevokeInvitation("viewer", { role: "viewer" })).toBe(false);
  });
});

describe("rubrik och räknare", () => {
  it("tvådelad rubrik med antal och väntande inbjudningar", () => {
    expect(headline(1, 0)).toBe("1 person har tillgång. Inga inbjudningar väntar.");
    expect(headline(5, 1)).toBe("5 personer har tillgång. 1 inbjudan väntar på svar.");
    expect(headline(12, 3)).toBe("12 personer har tillgång. 3 inbjudningar väntar på svar.");
  });

  it("räknar per roll, även nollor, i rollordning", () => {
    const members = [{ role: "owner" }, { role: "viewer" }, { role: "viewer" }] as const;
    expect(countByRole(members)).toEqual({ owner: 1, admin: 0, viewer: 2, refiller: 0 });
    expect(roleMeta(members)).toEqual([
      { label: "Ägare", value: "1" },
      { label: "Administratörer", value: "0" },
      { label: "Läsare", value: "2" },
      { label: "Påfyllare", value: "0" },
    ]);
  });

  it("namn: visningsnamn, annars delen före @", () => {
    expect(memberName({ displayName: " Delägare ", email: "d@x.se" })).toBe("Delägare");
    expect(memberName({ displayName: null, email: "anna.berg@x.se" })).toBe("anna.berg");
    expect(memberName({ displayName: "  ", email: "kim@x.se" })).toBe("kim");
  });

  it("isMemberRole avvisar okända värden", () => {
    expect(isMemberRole("owner")).toBe(true);
    expect(isMemberRole("superadmin")).toBe(false);
    expect(isMemberRole(undefined)).toBe(false);
  });
});
