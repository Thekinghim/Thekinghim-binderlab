"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import type { MemberRole } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { useToast } from "@/components/ui/toast";

import { changeMemberRole, removeMember, resendInvitation, revokeInvitation } from "./actions";
import { FormError } from "@/app/logga-in/form-error";
import { ROLE_LABEL, canManageMembers } from "./model";
import { RoleChoice } from "./role-choice";

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
}

export interface InvitationView {
  id: string;
  email: string;
  role: MemberRole;
  sent: string;
  expires: string;
  invitedBy: string;
  canManage: boolean;
}

type Dialog =
  | { kind: "role"; member: MemberView }
  | { kind: "remove"; member: MemberView }
  | { kind: "revoke"; invitation: InvitationView }
  | null;

const ROW =
  "grid grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-2 border-t border-line py-3 md:grid-cols-[minmax(0,1fr)_160px_140px_auto] md:py-0 md:h-14";

export function MembersView({
  organizationName,
  actorRole,
  assignable,
  members,
  invitations,
  membersAside,
  invitationsAside,
}: {
  organizationName: string;
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
    <>
      <section aria-labelledby="medlemmar" className="mt-12">
        <SectionHeader
          id="medlemmar"
          eyebrow="Medlemmar"
          title="Med tillgång nu."
          aside={membersAside}
          size="md"
        />
        <div className="mt-6">
          <div
            aria-hidden
            className="label hidden h-9 grid-cols-[minmax(0,1fr)_160px_140px_auto] items-center gap-x-4 text-subtle md:grid"
          >
            <span>Person</span>
            <span>Roll</span>
            <span>Medlem sedan</span>
            <span className="w-[168px]" />
          </div>
          <ul className="border-b border-line">
            {members.map((m) => (
              <li key={m.id} className={ROW}>
                <div className="flex min-w-0 flex-col">
                  <span className="flex min-w-0 items-center gap-2 text-base text-fg">
                    <span className="truncate">{m.name}</span>
                    {m.isSelf ? (
                      <span className="label shrink-0 rounded-xs border border-line-strong px-1 text-muted">
                        Du
                      </span>
                    ) : null}
                  </span>
                  <span className="meta [overflow-wrap:anywhere] text-subtle">{m.email}</span>
                </div>
                <span className="text-base text-fg md:order-none">
                  <span className="sr-only">Roll: </span>
                  {ROLE_LABEL[m.role]}
                </span>
                <span className="meta tnum hidden text-muted md:block">
                  <span className="sr-only">Medlem sedan </span>
                  {m.since}
                </span>
                <div className="col-span-2 flex min-h-7 items-center gap-1 md:col-span-1 md:w-[168px] md:justify-end">
                  {m.canChangeRole || m.canRemove ? (
                    <>
                      {m.canChangeRole ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          className="-ml-2.5 md:ml-0"
                          aria-label={`Byt roll för ${m.name}`}
                          onClick={() => open({ kind: "role", member: m })}
                        >
                          Byt roll
                        </Button>
                      ) : null}
                      {m.canRemove ? (
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={m.isSelf ? "Lämna organisationen" : `Ta bort ${m.name}`}
                          onClick={() => open({ kind: "remove", member: m })}
                        >
                          {m.isSelf ? "Lämna" : "Ta bort"}
                        </Button>
                      ) : null}
                    </>
                  ) : m.reason ? (
                    <span className="text-xs text-subtle md:text-right">{m.reason}</span>
                  ) : null}
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section aria-labelledby="inbjudningar" className="mt-14">
        <SectionHeader
          id="inbjudningar"
          eyebrow="Inbjudningar"
          title="Väntar på svar."
          aside={invitationsAside}
          size="md"
        />
        <div className="mt-6">
          {invitations.length === 0 ? (
            <StateMessage kind="empty" code="0 väntar" compact message="Ingen länk är aktiv." />
          ) : (
            <ul className="border-b border-line">
              {invitations.map((i) => (
                <li key={i.id} className={ROW}>
                  <div className="flex min-w-0 flex-col">
                    <span className="text-base [overflow-wrap:anywhere] text-fg">{i.email}</span>
                    <span className="meta truncate text-subtle">
                      Skickad {i.sent} av {i.invitedBy}
                    </span>
                  </div>
                  <span className="text-base text-fg">
                    <span className="sr-only">Roll: </span>
                    {ROLE_LABEL[i.role]}
                  </span>
                  <span className="meta tnum hidden text-muted md:block">Går ut {i.expires}</span>
                  <div className="col-span-2 flex min-h-7 items-center gap-1 md:col-span-1 md:w-[168px] md:justify-end">
                    <span className="meta tnum mr-auto text-muted md:hidden">
                      Går ut {i.expires}
                    </span>
                    {i.canManage ? (
                      <>
                        <Button
                          size="sm"
                          variant="ghost"
                          loading={busyInvite === i.id}
                          aria-label={`Skicka ny länk till ${i.email}`}
                          onClick={() => resend(i)}
                        >
                          Skicka igen
                        </Button>
                        <Button
                          size="sm"
                          variant="ghost"
                          aria-label={`Återkalla inbjudan till ${i.email}`}
                          onClick={() => open({ kind: "revoke", invitation: i })}
                        >
                          Återkalla
                        </Button>
                      </>
                    ) : (
                      <span className="text-xs text-subtle">Ägarinbjudan</span>
                    )}
                  </div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </section>

      <Modal
        open={dialog?.kind === "role"}
        onClose={close}
        eyebrow={dialog?.kind === "role" ? dialog.member.email : undefined}
        title={dialog?.kind === "role" ? `Byt roll för ${dialog.member.name}` : "Byt roll"}
        description="Ändringen gäller direkt, även för den som redan är inloggad, och loggas."
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
              <p className="text-sm text-muted">
                Du förlorar tillgången till Inställningar när du sparar.
              </p>
            ) : null}
            <FormError message={error} />
            <div className="flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end">
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
    </>
  );
}
