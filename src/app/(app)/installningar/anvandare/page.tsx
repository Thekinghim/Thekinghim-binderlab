import type { Metadata } from "next";

import { wallClockIn } from "@/components/shell/period-state";
import { SectionHeader } from "@/components/ui/section-header";

import { MerHead } from "../_components/mer-head";
import { getServerEnv } from "@/lib/env";
import { formatDate } from "@/lib/format";
import { requireRoute } from "@/server/data/core";
import { requireUser } from "@/server/session";

import { InviteDialog } from "./invite-dialog";
import { loadMembersPageFor } from "./members-data";
import { MembersView, type InvitationView, type MemberView } from "./members-view";
import {
  ROLE_LABEL,
  ROLE_ORDER,
  ROLE_SUMMARY,
  assignableRoles,
  canRevokeInvitation,
  countByRole,
  headline,
  invitationsAside,
  memberName,
  membersAside,
  memberPermissions,
  roleMeta,
} from "./model";

export const metadata: Metadata = { title: "Användare" };

/**
 * Inställningar → Användare: vem som har tillgång, med vilken roll, och
 * vilka inbjudningar som väntar. Bara ägare och admin (requireRoute; läsare
 * och påfyllare skickas till sin startsida). Data läses under RLS efter en
 * rollkontroll mot databasen (loadMembersPageFor).
 */
export default async function UsersPage({
  searchParams,
}: {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireRoute("installningar");
  // ?bjud-in=1 (Att göra → "Bjud in delägaren") öppnar inbjudan direkt.
  const openInvite = (await searchParams)?.["bjud-in"] === "1";
  const user = await requireUser();
  const data = await loadMembersPageFor(user, ctx.organization.id);

  const tz = ctx.timeZone;
  const now = wallClockIn(new Date(ctx.now), tz);
  const date = (isoTime: string) =>
    formatDate(wallClockIn(new Date(isoTime), tz), { year: "auto", now });
  const ownerCount = countByRole(data.members).owner;
  const nameById = new Map(data.members.map((m) => [m.userId, memberName(m)]));

  const members: MemberView[] = data.members
    .slice()
    .sort(
      (a, b) =>
        ROLE_ORDER.indexOf(a.role) - ROLE_ORDER.indexOf(b.role) ||
        memberName(a).localeCompare(memberName(b), "sv"),
    )
    .map((m) => ({
      id: m.membershipId,
      name: memberName(m),
      email: m.email,
      role: m.role,
      since: date(m.createdAt),
      isSelf: m.userId === ctx.user.id,
      ...memberPermissions(data.role, m, ownerCount),
    }));

  const invitations: InvitationView[] = data.invitations.map((i) => ({
    id: i.id,
    email: i.email,
    role: i.role,
    sent: date(i.createdAt),
    expires: date(i.expiresAt),
    invitedBy: i.invitedBy ? (nameById.get(i.invitedBy) ?? "En tidigare medlem") : "Okänd",
    canManage: canRevokeInvitation(data.role, i),
  }));

  const newest = data.members.reduce<(typeof data.members)[number] | null>(
    (best, m) => (best === null || m.createdAt > best.createdAt ? m : best),
    null,
  );
  const firstExpiry = data.invitations.reduce<string | null>(
    (min, i) => (min === null || i.expiresAt < min ? i.expiresAt : min),
    null,
  );

  return (
    <div className="mx-auto w-full max-w-[1280px] px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <MerHead
        eyebrow="Användare"
        title={headline(members.length, invitations.length)}
        meta={roleMeta(data.members)}
        actions={
          <InviteDialog
            organizationName={ctx.organization.name}
            roles={assignableRoles(data.role)}
            devMailbox={getServerEnv().AUTH_PROVIDER === "dev"}
            initialOpen={openInvite}
          />
        }
      />

      <MembersView
        organizationName={ctx.organization.name}
        actorRole={data.role}
        assignable={assignableRoles(data.role)}
        members={members}
        invitations={invitations}
        membersAside={membersAside(
          newest ? { name: memberName(newest), date: date(newest.createdAt) } : null,
        )}
        invitationsAside={invitationsAside(firstExpiry ? date(firstExpiry) : null)}
      />

      <details
        className="rise mt-14 border-t border-line pt-6"
        style={{ "--i": 3 } as React.CSSProperties}
      >
        <summary className="cursor-pointer list-none">
          <SectionHeader id="roller" title="Roller." aside="Vem ser vad." size="md" />
        </summary>
        <dl className="mt-6 grid grid-cols-1 gap-x-8 gap-y-5 sm:grid-cols-2 lg:grid-cols-4">
          {ROLE_ORDER.map((role) => (
            <div key={role} className="flex flex-col gap-1.5 border-t border-line pt-3">
              <dt className="label text-fg">{ROLE_LABEL[role]}</dt>
              <dd className="text-sm text-muted">{ROLE_SUMMARY[role]}</dd>
            </div>
          ))}
        </dl>
      </details>
    </div>
  );
}
