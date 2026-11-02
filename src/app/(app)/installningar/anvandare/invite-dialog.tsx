"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import type { MemberRole } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

import { inviteMember } from "./actions";
import { FormError } from "@/app/logga-in/form-error";
import { ROLE_LABEL } from "./model";
import { RoleChoice } from "./role-choice";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Knappen "Bjud in" och dialogen bakom den. */
export function InviteDialog({
  organizationName,
  roles,
  devMailbox,
}: {
  organizationName: string;
  roles: readonly MemberRole[];
  /** Lokalt: mejlen skrivs till .data/mail i stället för att skickas. */
  devMailbox: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<MemberRole>(roles.includes("viewer") ? "viewer" : roles[0]!);
  const [emailError, setEmailError] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  const close = () => {
    setOpen(false);
    setEmailError(undefined);
    setError(undefined);
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const address = email.trim();
    if (!EMAIL.test(address)) {
      setEmailError("Ange en giltig e-postadress.");
      return;
    }
    setEmailError(undefined);
    setError(undefined);
    startTransition(async () => {
      const result = await inviteMember({ email: address, role });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast({
        title: `Inbjudan skickad till ${address}`,
        description: devMailbox
          ? `${ROLE_LABEL[role]}. Lokalt sparas mejlet i .data/mail.`
          : `${ROLE_LABEL[role]}. Länken gäller i 7 dagar.`,
        tone: "ok",
      });
      setEmail("");
      close();
      router.refresh();
    });
  };

  return (
    <>
      <Button variant="primary" iconLeft="plus" onClick={() => setOpen(true)}>
        Bjud in
      </Button>
      <Modal
        open={open}
        onClose={close}
        eyebrow={organizationName}
        title="Bjud in en person"
        description="Personen får ett mejl med en länk som gäller i 7 dagar och kan användas en gång."
      >
        <form id="invite-form" onSubmit={submit} noValidate className="flex flex-col gap-5">
          <Input
            label="E-postadress"
            type="email"
            name="email"
            autoComplete="off"
            inputMode="email"
            spellCheck={false}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            error={emailError}
            required
            autoFocus
          />
          <RoleChoice roles={roles} value={role} onChange={setRole} />
          <FormError message={error} />
          <div className="flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end">
            <Button type="button" onClick={close}>
              Avbryt
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              Skicka inbjudan
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
