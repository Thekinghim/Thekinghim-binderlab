"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import type { MemberRole } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { Badge } from "@/components/v2/badge";
import { Button as V2Button } from "@/components/v2/button";
import { Card } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { useT } from "@/i18n/client";

import { changeMemberRole, removeMember, resendInvitation, revokeInvitation } from "./actions";
import { FormError } from "@/app/logga-in/form-error";
import { ROLE_LABEL, canManageMembers } from "./model";
import { RoleChoice } from "./role-choice";
import { ViewSettings } from "./view-settings";

export interface MemberView {
  id: string;
  name: string;
  email: string;
  role: MemberRole;
  /** Formaterat datum (organisationens tidszon). */
  since: string;
  isSelf: boolean;
  canChangeRole: boolean;
  canRemove: boolean;
  reason: string | null;
  /** Enkel vy och språk (memberships.view_mode, profiles.locale). */
  viewMode: "full" | "simple";
  locale: "sv" | "en";
  /** Får den inloggade ändra Enkel vy och språk (inte den egna, admin inte en ägare)? */
  canSetView: boolean;
}

export interface InvitationView {
  id: string;
  email: string;
  role: MemberRole;
  sent: string;
  expires: string;
  invitedBy: string;
  canManage: boolean;
  viewMode: "full" | "simple";
  locale: "sv" | "en";
}

type Dialog =
  | { kind: "role"; member: MemberView }
  | { kind: "remove"; member: MemberView }
  | { kind: "revoke"; invitation: InvitationView }
  | null;

const ROW =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-t border-v2-line2 px-[14px] py-3 first:border-t-0 md:grid-cols-[minmax(0,1fr)_160px_140px_auto] md:min-h-14 md:px-[18px] md:py-2.5";

export function MembersView({
  organizationName,
  actorRole,
  assignable,
  members,
  invitations,
  membersAside,
  invitationsAside,
  actions,
}: {
  organizationName: string;
  /** Knappen i Medlemmar-kortets rubrikrad (Bjud in). */
  actions?: React.ReactNode;
  /** Grå del av sektionsrubrikerna (model.ts → membersAside, invitationsAside). */
  membersAside: string;
  invitationsAside: string;
  actorRole: MemberRole;
  assignable: readonly MemberRole[];
  members: readonly MemberView[];
  invitations: readonly InvitationView[];
}) {
  const router = useRouter();
  const toast = useToast();
  const t = useT();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [error, setError] = useState<string>();
  const [nextRole, setNextRole] = useState<MemberRole>("viewer");
  const [pending, startTransition] = useTransition();
  const [busyInvite, setBusyInvite] = useState<string | null>(null);

  const open = (d: Exclude<Dialog, null>) => {
    setError(undefined);
    if (d.kind === "role") setNextRole(d.member.role);
    setDialog(d);
  };
  const close = () => {
    if (!pending) setDialog(null);
  };

  const saveRole = (member: MemberView) =>
    startTransition(async () => {
      const result = await changeMemberRole({ membershipId: member.id, role: nextRole });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDialog(null);
      toast({
        title: `${member.name} är nu ${ROLE_LABEL[nextRole].toLowerCase()}`,
        meta: member.email,
        tone: "ok",
      });
      if (result.data?.self && !canManageMembers(nextRole)) router.replace("/");
      else router.refresh();
    });

  const remove = (member: MemberView) =>
    startTransition(async () => {
      const result = await removeMember({ membershipId: member.id });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDialog(null);
      toast({
        title: member.isSelf
          ? `Du har lämnat ${organizationName}`
          : `${member.name} har inte längre tillgång`,
        meta: member.email,
        tone: "ok",
      });
      if (result.data?.self) router.replace("/");
      else router.refresh();
    });

  const revoke = (invitation: InvitationView) =>
    startTransition(async () => {
      const result = await revokeInvitation({ invitationId: invitation.id });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDialog(null);
      toast({ title: "Inbjudan återkallad", meta: invitation.email, tone: "ok" });
      router.refresh();
    });

  const resend = (invitation: InvitationView) => {
    setBusyInvite(invitation.id);
    startTransition(async () => {
      const result = await resendInvitation({ invitationId: invitation.id });
      setBusyInvite(null);
      if (!result.ok) {
        toast({ title: "Inbjudan skickades inte", description: result.error, tone: "critical" });
        return;
      }
      toast({
        title: `Ny länk skickad till ${invitation.email}`,
        description: "Den gamla länken gäller inte längre.",
        tone: "ok",
      });
      router.refresh();
    });
  };

  const demotesSelf =
    dialog?.kind === "role" && dialog.member.isSelf && !canManageMembers(nextRole);

  return (
    <div className="v2-stack">
      <Card
        title={<span id="medlemmar">Medlemmar</span>}
        actions={
          <span className="flex items-center gap-3">
            <span className="lk max-md:hidden">{membersAside.replace(/\.$/, "")}</span>
            {actions}
          </span>
        }
        className="order-2"
      >
        <div
          aria-hidden
          className="hidden h-[34px] grid-cols-[minmax(0,1fr)_160px_140px_auto] items-center gap-x-4 border-b border-v2-line bg-v2-hover px-[18px] text-v2-xs font-[550] text-v2-mute md:grid"
        >
          <span>Person</span>
          <span>Roll</span>
          <span>Medlem sedan</span>
          <span className="w-[168px]" />
        </div>
        <ul aria-labelledby="medlemmar">
          {members.map((m) => (
            <li key={m.id} className={ROW}>
              <div className="flex min-w-0 flex-col">
                <span className="flex min-w-0 items-center gap-2 text-v2-md font-[550] text-v2-ink">
                  <span className="truncate">{m.name}</span>
                  {m.isSelf ? <Badge className="shrink-0">Du</Badge> : null}
                </span>
                <span className="text-v2-sm [overflow-wrap:anywhere] text-v2-mute">{m.email}</span>
              </div>
              <span className="text-v2-md text-v2-ink md:order-none">
                <span className="sr-only">Roll: </span>
                {ROLE_LABEL[m.role]}
              </span>
              <span className="hidden text-v2-sm text-v2-mute tabular-nums md:block">
                <span className="sr-only">Medlem sedan </span>
                {m.since}
              </span>
              <div className="col-span-2 flex min-h-7 items-center gap-1.5 md:col-span-1 md:w-[168px] md:justify-end">
                {m.canChangeRole || m.canRemove ? (
                  <>
                    {m.canChangeRole ? (
                      <V2Button
                        size="sm"
                        touch
                        aria-label={`Byt roll för ${m.name}`}
                        onClick={() => open({ kind: "role", member: m })}
                      >
                        Byt roll
                      </V2Button>
                    ) : null}
                    {m.canRemove ? (
                      <V2Button
                        size="sm"
                        touch
                        variant="quiet"
                        aria-label={m.isSelf ? "Lämna organisationen" : `Ta bort ${m.name}`}
                        onClick={() => open({ kind: "remove", member: m })}
                      >
                        {m.isSelf ? "Lämna" : "Ta bort"}
                      </V2Button>
                    ) : null}
                  </>
                ) : m.reason ? (
                  <span className="text-v2-xs text-v2-mute md:text-right">{m.reason}</span>
                ) : null}
              </div>
              {m.canSetView ? (
                <ViewSettings
                  target={{ kind: "member", membershipId: m.id }}
                  name={m.name}
                  viewMode={m.viewMode}
                  locale={m.locale}
                />
              ) : m.viewMode === "simple" ? (
                <span className="col-span-2 text-v2-xs text-v2-mute md:col-span-4">
                  {`${t.team.simpleView} · ${t.team.simpleViewHint}`}
                </span>
              ) : null}
            </li>
          ))}
        </ul>
      </Card>

      <Card
        title={<span id="inbjudningar">Väntar</span>}
        actions={<span className="lk">{invitationsAside.replace(/\.$/, "")}</span>}
        className={invitations.length > 0 ? "order-1" : "order-3"}
      >
        {invitations.length === 0 ? (
          <Empty title="Ingen väntar." />
        ) : (
          <ul aria-labelledby="inbjudningar">
            {invitations.map((i) => (
              <li key={i.id} className={ROW}>
                <div className="flex min-w-0 flex-col">
                  <span className="text-v2-md font-[550] [overflow-wrap:anywhere] text-v2-ink">
                    {i.email}
                  </span>
                  <span className="truncate text-v2-sm text-v2-mute">
                    Skickad {i.sent} av {i.invitedBy}
                  </span>
                </div>
                <span className="text-v2-md text-v2-ink">
                  <span className="sr-only">Roll: </span>
                  {ROLE_LABEL[i.role]}
                </span>
                <span className="hidden text-v2-sm text-v2-mute tabular-nums md:block">
                  Går ut {i.expires}
                </span>
                <div className="col-span-2 flex min-h-7 items-center gap-1.5 md:col-span-1 md:w-[168px] md:justify-end">
                  <span className="mr-auto text-v2-sm text-v2-mute tabular-nums md:hidden">
                    Går ut {i.expires}
                  </span>
                  {i.canManage ? (
                    <>
                      <V2Button
                        size="sm"
                        touch
                        pending={busyInvite === i.id}
                        aria-label={`Skicka ny länk till ${i.email}`}
                        onClick={() => resend(i)}
                      >
                        Skicka igen
                      </V2Button>
                      <V2Button
                        size="sm"
                        touch
                        variant="quiet"
                        aria-label={`Återkalla inbjudan till ${i.email}`}
                        onClick={() => open({ kind: "revoke", invitation: i })}
                      >
                        Återkalla
                      </V2Button>
                    </>
                  ) : (
                    <span className="text-v2-xs text-v2-mute">Ägarinbjudan</span>
                  )}
                </div>
                {i.canManage ? (
                  <ViewSettings
                    target={{ kind: "invitation", invitationId: i.id }}
                    name={i.email}
                    viewMode={i.viewMode}
                    locale={i.locale}
                  />
                ) : null}
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Modal
        open={dialog?.kind === "role"}
        onClose={close}
        dismissible={!pending}
        eyebrow={dialog?.kind === "role" ? dialog.member.email : undefined}
        title={dialog?.kind === "role" ? `Byt roll för ${dialog.member.name}` : "Byt roll"}
        description="Gäller direkt."
      >
        {dialog?.kind === "role" ? (
          <form
            noValidate
            className="flex flex-col gap-5"
            onSubmit={(e) => {
              e.preventDefault();
              saveRole(dialog.member);
            }}
          >
            <RoleChoice
              legend="Ny roll"
              roles={actorRole === "owner" ? assignable : assignable.filter((r) => r !== "owner")}
              value={nextRole}
              current={dialog.member.role}
              onChange={(r) => {
                setError(undefined);
                setNextRole(r);
              }}
            />
            {demotesSelf ? (
              <p className="text-v2-sm text-v2-mute">
                Du förlorar tillgången till Inställningar när du sparar.
              </p>
            ) : null}
            <FormError message={error} />
            <div className="flex flex-col-reverse gap-2 border-t border-v2-line2 pt-4 sm:flex-row sm:justify-end">
              <Button type="button" onClick={close}>
                Avbryt
              </Button>
              <Button
                type="submit"
                variant="primary"
                loading={pending}
                disabled={nextRole === dialog.member.role}
              >
                Spara roll
              </Button>
            </div>
          </form>
        ) : null}
      </Modal>

      <Modal
        size="sm"
        open={dialog?.kind === "remove"}
        onClose={close}
        dismissible={!pending}
        eyebrow={dialog?.kind === "remove" ? dialog.member.email : undefined}
        title={
          dialog?.kind === "remove"
            ? dialog.member.isSelf
              ? `Lämna ${organizationName}?`
              : `Ta bort ${dialog.member.name}?`
            : "Ta bort"
        }
        description={
          dialog?.kind === "remove"
            ? dialog.member.isSelf
              ? "Du förlorar tillgången direkt. För att komma tillbaka behövs en ny inbjudan."
              : `Personen förlorar tillgången till ${organizationName} direkt. Historiken finns kvar och ändringen loggas.`
            : undefined
        }
        footer={
          dialog?.kind === "remove" ? (
            <>
              <Button onClick={close}>Avbryt</Button>
              <Button
                variant="danger-confirm"
                loading={pending}
                onClick={() => remove(dialog.member)}
              >
                {dialog.member.isSelf ? "Lämna" : "Ta bort"}
              </Button>
            </>
          ) : null
        }
      >
        {error && dialog?.kind === "remove" ? <FormError message={error} /> : null}
      </Modal>

      <Modal
        size="sm"
        open={dialog?.kind === "revoke"}
        onClose={close}
        dismissible={!pending}
        eyebrow={dialog?.kind === "revoke" ? ROLE_LABEL[dialog.invitation.role] : undefined}
        title={
          dialog?.kind === "revoke"
            ? `Återkalla inbjudan till ${dialog.invitation.email}?`
            : "Återkalla"
        }
        description="Länken i mejlet slutar gälla direkt. Du kan bjuda in igen senare."
        footer={
          dialog?.kind === "revoke" ? (
            <>
              <Button onClick={close}>Avbryt</Button>
              <Button
                variant="danger-confirm"
                loading={pending}
                onClick={() => revoke(dialog.invitation)}
              >
                Återkalla
              </Button>
            </>
          ) : null
        }
      >
        {error && dialog?.kind === "revoke" ? <FormError message={error} /> : null}
      </Modal>
    </div>
  );
}
