/**
 * Regler och texter för Inställningar → Användare. Rena funktioner (testas i
 * model.test.ts) som speglar databasens regler, så att gränssnittet kan
 * förklara i förväg varför en åtgärd inte går. Databasen avgör alltid:
 * RLS på memberships, BL005 (minst en ägare) och BL006 (admin rör inte ägare).
 */

import type { MemberRole } from "@/db/schema";
import { formatInt } from "@/lib/format";

export const ROLE_ORDER: readonly MemberRole[] = ["owner", "admin", "viewer", "refiller"];

export const ROLE_LABEL: Record<MemberRole, string> = {
  owner: "Ägare",
  admin: "Administratör",
  viewer: "Läsare",
  refiller: "Påfyllare",
};

/** Plural för räknare i rubriken och metadatablocket. */
const ROLE_PLURAL: Record<MemberRole, string> = {
  owner: "Ägare",
  admin: "Administratörer",
  viewer: "Läsare",
  refiller: "Påfyllare",
};

/** Vad rollen ser och får göra, en mening. */
export const ROLE_SUMMARY: Record<MemberRole, string> = {
  owner: "Ser och ändrar allt, även ägarna och vem som har tillgång.",
  admin: "Ser och ändrar allt utom ägarna. Kan bjuda in.",
  viewer: "Ser siffror, lönsamhet och rapporter. Ändrar inget.",
  refiller: "Ser påfyllning och lager. Inga belopp.",
};

export function isMemberRole(value: unknown): value is MemberRole {
  return typeof value === "string" && (ROLE_ORDER as readonly string[]).includes(value);
}

export function canManageMembers(role: MemberRole): boolean {
  return role === "owner" || role === "admin";
}

/** Rollerna en medlem med `actor` får ge (bjuda in till eller byta till). */
export function assignableRoles(actor: MemberRole): MemberRole[] {
  if (actor === "owner") return [...ROLE_ORDER];
  if (actor === "admin") return ROLE_ORDER.filter((r) => r !== "owner");
  return [];
}

export interface MemberRow {
  membershipId: string;
  userId: string;
  email: string;
  displayName: string | null;
  role: MemberRole;
  /** ISO-tid. */
  createdAt: string;
}

export interface InvitationRow {
  id: string;
  email: string;
  role: MemberRole;
  /** ISO-tid. */
  createdAt: string;
  /** ISO-tid. */
  expiresAt: string;
  invitedBy: string | null;
}

export interface MemberPermissions {
  canChangeRole: boolean;
  canRemove: boolean;
  /** Varför åtgärderna är spärrade (visas vid raden), eller null. */
  reason: string | null;
}

export const LAST_OWNER_REASON = "Sista ägaren. Gör någon annan till ägare först.";
export const OWNER_ONLY_REASON = "Bara en ägare kan ändra en ägare.";

/**
 * Vad `actor` får göra med `member`. Sista ägaren kan varken byta roll eller
 * tas bort; en admin rör inte ägare; läsare och påfyllare rör ingen.
 */
export function memberPermissions(
  actor: MemberRole,
  member: Pick<MemberRow, "role">,
  ownerCount: number,
): MemberPermissions {
  if (!canManageMembers(actor)) {
    return { canChangeRole: false, canRemove: false, reason: null };
  }
  if (member.role === "owner" && actor !== "owner") {
    return { canChangeRole: false, canRemove: false, reason: OWNER_ONLY_REASON };
  }
  if (member.role === "owner" && ownerCount <= 1) {
    return { canChangeRole: false, canRemove: false, reason: LAST_OWNER_REASON };
  }
  return { canChangeRole: true, canRemove: true, reason: null };
}

/** En admin kan inte återkalla en ägarinbjudan (som RLS på invitations). */
export function canRevokeInvitation(actor: MemberRole, invitation: Pick<InvitationRow, "role">) {
  return actor === "owner" || (actor === "admin" && invitation.role !== "owner");
}

export function countByRole(
  members: readonly Pick<MemberRow, "role">[],
): Record<MemberRole, number> {
  const counts: Record<MemberRole, number> = { owner: 0, admin: 0, viewer: 0, refiller: 0 };
  for (const m of members) counts[m.role] += 1;
  return counts;
}

/** "1 person" · "5 personer" */
export function peopleCount(n: number): string {
  return `${formatInt(n)} ${n === 1 ? "person" : "personer"}`;
}

/**
 * Sidans tvådelade rubrik: "Användare." och ett faktum, t.ex.
 * "5 personer har tillgång. 1 inbjudan väntar på svar."
 */
export function headline(memberCount: number, pendingCount: number): string {
  const access = `${peopleCount(memberCount)} har tillgång.`;
  if (pendingCount === 0) return `${access} Inga inbjudningar väntar.`;
  const invites = `${formatInt(pendingCount)} ${pendingCount === 1 ? "inbjudan väntar" : "inbjudningar väntar"} på svar.`;
  return `${access} ${invites}`;
}

/** Metadata till rubriken: antal per roll, i rollordning, även nollor. */
export function roleMeta(members: readonly Pick<MemberRow, "role">[]) {
  const counts = countByRole(members);
  return ROLE_ORDER.map((role) => ({ label: ROLE_PLURAL[role], value: formatInt(counts[role]) }));
}

/** Namnet att visa: visningsnamn, annars delen före @. */
export function memberName(member: Pick<MemberRow, "displayName" | "email">): string {
  const name = member.displayName?.trim();
  return name ? name : (member.email.split("@")[0] ?? member.email);
}
