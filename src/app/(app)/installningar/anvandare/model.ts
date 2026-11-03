/**
 * Regler och texter för Inställningar → Användare. Rena funktioner (testas i
 * model.test.ts) som speglar databasens regler, så att gränssnittet kan
 * förklara i förväg varför en åtgärd inte går. Databasen avgör alltid:
 * RLS på memberships, BL005 (minst en ägare) och BL006 (admin rör inte ägare).
 */

import type { MemberRole, MembershipRole } from "@/db/schema";
import { formatInt } from "@/lib/format";

export const ROLE_ORDER: readonly MemberRole[] = ["owner", "admin", "viewer", "refiller"];

// Texterna täcker även butiksportalens roll "store" (fas 10): inbjudningssidan
// (/inbjudan/[token]) visar rollen för en butiksinbjudan från /butiker. Butiken
// kan aldrig väljas här (ROLE_ORDER, assignableRoles).
export const ROLE_LABEL: Record<MembershipRole, string> = {
  owner: "Ägare",
  admin: "Administratör",
  viewer: "Läsare",
  refiller: "Påfyllare",
  store: "Butik",
};

/** Plural för räknare i rubriken och metadatablocket. */
const ROLE_PLURAL: Record<MembershipRole, string> = {
  owner: "Ägare",
  admin: "Administratörer",
  viewer: "Läsare",
  refiller: "Påfyllare",
  store: "Butiker",
};

/** Vad rollen ser och får göra, en mening. */
export const ROLE_SUMMARY: Record<MembershipRole, string> = {
  owner: "Ser och ändrar allt, även ägarna och vem som har tillgång.",
  admin: "Ser och ändrar allt utom ägarna. Kan bjuda in.",
  viewer: "Ser siffror, lönsamhet och rapporter. Ändrar inget.",
  refiller: "Ser påfyllning och lager. Inga belopp.",
  store:
    "Ser butikens egen försäljning, ersättning och rapporter i butiksportalen. Inga inköpspriser.",
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
export const OWNER_INVITE_REASON = "Bara en ägare kan bjuda in en ägare.";

/**
 * Felet efter en misslyckad inbjudan. En admin som bjuder in en ägare stoppas
 * av create_invitation med det allmänna behörighetsfelet (42501); rollkontrollen
 * för admin har redan passerat, så felet gäller ägarrollen och förklaras så.
 */
export function inviteErrorFor(role: MemberRole, error: string, genericForbidden: string): string {
  return role === "owner" && error === genericForbidden ? OWNER_INVITE_REASON : error;
}

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
 * Sidans rubrik, en mening: väntar någon på att gå med säger den det (det är
 * det som kan behöva göras), annars hur många som har tillgång.
 */
export function headline(memberCount: number, pendingCount: number): string {
  if (pendingCount > 0) {
    return `${formatInt(pendingCount)} ${pendingCount === 1 ? "inbjudan väntar" : "inbjudningar väntar"}.`;
  }
  return `${peopleCount(memberCount)} har tillgång.`;
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

/** Avslutar med punkt, utan att dubbla den efter en förkortning som "2 nov.". */
function sentence(text: string): string {
  return text.endsWith(".") ? text : `${text}.`;
}

/**
 * Den grå delen av rubriken "Med tillgång nu.": den senast tillagda, så att
 * sektionen säger något annat än sidans rubrik (som redan har antalet).
 */
export function membersAside(latest: { name: string; date: string } | null): string {
  return latest
    ? sentence(`Senast tillagd: ${latest.name}, ${latest.date}`)
    : "Ingen har tillgång ännu.";
}

/** Den grå delen av "Väntar på svar.": när första länken går ut, annars regeln för länkar. */
export function invitationsAside(firstExpires: string | null): string {
  return firstExpires ? sentence(`Första länken går ut ${firstExpires}`) : "Länken gäller 7 dagar.";
}
