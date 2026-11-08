"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition, type FormEvent } from "react";

import type { MemberRole } from "@/db/schema";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { useT } from "@/i18n/client";
import { LOCALES, LOCALE_NAME, type Locale } from "@/i18n/locale";

import { inviteMember } from "./actions";
import { FormError } from "@/app/logga-in/form-error";
import { PASSWORD_MIN_LENGTH } from "../_lib/model";
import { ROLE_LABEL } from "./model";
import { RoleChoice } from "./role-choice";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/** Knappen "Bjud in" och dialogen bakom den. */
export function InviteDialog({
  organizationName,
  roles,
  devMailbox,
  initialOpen = false,
}: {
  organizationName: string;
  roles: readonly MemberRole[];
  /** Lokalt: mejlen skrivs till .data/mail i stället för att skickas. */
  devMailbox: boolean;
  /** Öppen från början (länken "Bjud in delägaren" i Att göra, ?bjud-in=1). */
  initialOpen?: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(initialOpen);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string>();
  const defaultRole: MemberRole = roles.includes("viewer") ? "viewer" : roles[0]!;
  // Från "Bjud in delägaren": delägaren blir ägare (eller admin om ägare inte får väljas).
  const coOwnerRole: MemberRole = roles.includes("owner")
    ? "owner"
    : roles.includes("admin")
      ? "admin"
      : defaultRole;
  const [role, setRole] = useState<MemberRole>(initialOpen ? coOwnerRole : defaultRole);
  const t = useT();
  // Enkel vy och språk när inbjudan tas emot. Från "Bjud in delägaren": enkel vy förvald.
  const [simple, setSimple] = useState(false);
  const [locale, setLocale] = useState<Locale>("sv");
  const [emailError, setEmailError] = useState<string>();
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const emailRef = useRef<HTMLInputElement>(null);

  // showModal() flyttar fokus till första fokuserbara elementet (stängknappen)
  // och skriver över autoFocus. Fältet får fokus när dialogen väl är öppen.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => emailRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open]);

  /** Stänger och nollställer: nästa inbjudan börjar alltid som läsare med tomt fält. */
  const close = () => {
    setOpen(false);
    setEmail("");
    setPassword("");
    setPasswordError(undefined);
    setRole(defaultRole);
    setSimple(false);
    setLocale("sv");
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
    if (password !== "" && password.length < PASSWORD_MIN_LENGTH) {
      setPasswordError(`Minst ${PASSWORD_MIN_LENGTH} tecken.`);
      return;
    }
    setPasswordError(undefined);
    setError(undefined);
    startTransition(async () => {
      const result = await inviteMember({
        email: address,
        role,
        password: password === "" ? undefined : password,
        viewMode: simple ? "simple" : "full",
        locale,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const emailSent = result.data?.emailSent !== false;
      toast({
        title: emailSent ? `Inbjudan skickad till ${address}` : `Inbjudan sparad för ${address}`,
        description: password
          ? `${ROLE_LABEL[role]}. Lösenordet är satt: personen loggar in med det och godkänner inbjudan.`
          : !emailSent
            ? `${ROLE_LABEL[role]}. Mejlet gick inte iväg. Tryck Skicka ny länk om en stund.`
            : devMailbox
              ? `${ROLE_LABEL[role]}. Lokalt sparas mejlet i .data/mail.`
              : `${ROLE_LABEL[role]}. Länken gäller i 7 dagar.`,
        tone: emailSent || password ? "ok" : "neutral",
      });
      close();
      router.refresh();
    });
  };

  return (
    <>
      <Button variant="primary" iconLeft="plus" onClick={() => setOpen(true)}>
        Bjud in
      </Button>
      <Modal open={open} onClose={close} eyebrow={organizationName} title="Bjud in">
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
            ref={emailRef}
          />
          <RoleChoice roles={roles} value={role} onChange={setRole} />
          <div className="flex flex-col gap-3 border-t border-line pt-4">
            <label className="flex min-h-11 cursor-pointer items-start gap-3">
              <input
                type="checkbox"
                checked={simple}
                onChange={(e) => setSimple(e.target.checked)}
                className="mt-1 size-5 shrink-0 accent-current"
              />
              <span className="flex flex-col">
                <span className="text-base text-fg">{t.team.simpleView}</span>
                <span className="text-sm text-muted">{t.team.simpleViewHint}</span>
              </span>
            </label>
            <label className="flex min-h-11 items-center justify-between gap-3">
              <span className="text-base text-fg">{t.team.inviteLanguage}</span>
              <select
                name="invite-locale"
                value={locale}
                onChange={(e) => setLocale(e.target.value as Locale)}
                className="h-11 rounded-sm border border-line-control bg-bg px-3 text-fg"
                style={{ fontSize: 16 }}
              >
                {LOCALES.map((l) => (
                  <option key={l} value={l}>
                    {LOCALE_NAME[l]}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <details className="group" open={passwordError !== undefined || undefined}>
            <summary className="cursor-pointer text-sm text-muted hover:text-fg">
              Sätt lösenord (valfritt)
            </summary>
            <div className="mt-4">
              <Input
                label="Lösenord"
                type="text"
                name="invite-password"
                autoComplete="off"
                spellCheck={false}
                value={password}
                onChange={(e) => {
                  setPassword(e.target.value);
                  setPasswordError(undefined);
                }}
                hint={`Ge det till personen. Minst ${PASSWORD_MIN_LENGTH} tecken.`}
                error={passwordError}
              />
            </div>
          </details>
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
