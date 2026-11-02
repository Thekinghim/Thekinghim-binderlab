"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition, type FormEvent } from "react";

import { FormError } from "@/app/logga-in/form-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { logout } from "@/server/actions/auth";

import { acceptInvitation } from "./actions";
import type { AcceptState } from "./state";

/** Samma gräns som servern (src/server/auth/password.ts, MIN_PASSWORD_LENGTH). */
const MIN_PASSWORD = 12;

/**
 * - accept: inloggad med inbjudans adress, ett klick.
 * - create: lokalt utan konto, välj lösenord (kontot skapas för inbjudans adress).
 * - link: Supabase-länk (token_hash); lösenord är valfritt för en ny användare.
 */
export function AcceptForm({
  token,
  mode,
  organizationName,
  tokenHash,
  linkType,
  loginHref,
}: {
  token: string;
  mode: "accept" | "create" | "link";
  organizationName: string;
  tokenHash?: string;
  linkType?: string;
  loginHref?: string;
}) {
  const [state, action, pending] = useActionState<AcceptState, FormData>(acceptInvitation, {});
  const asksPassword = mode !== "accept";
  const passwordRequired = mode === "create";
  // Styrda fält: React nollställer annars formuläret efter varje svar, även vid fel.
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [local, setLocal] = useState<AcceptState>({});
  const shown: AcceptState = local.error ? local : state;

  /** Samma kontroller som servern, med svenska texter i stället för webbläsarens. */
  const check = (e: FormEvent<HTMLFormElement>) => {
    const problem = asksPassword ? passwordProblem(password, confirm, passwordRequired) : null;
    setLocal(problem ?? {});
    if (problem) e.preventDefault();
  };

  return (
    <form action={action} onSubmit={check} noValidate className="flex flex-col gap-5">
      <input type="hidden" name="token" value={token} />
      {tokenHash ? <input type="hidden" name="token_hash" value={tokenHash} /> : null}
      {linkType ? <input type="hidden" name="type" value={linkType} /> : null}
      {asksPassword ? (
        <>
          <Input
            label={passwordRequired ? "Välj lösenord" : "Välj lösenord (valfritt)"}
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required={passwordRequired}
            hint={
              passwordRequired
                ? `Minst ${MIN_PASSWORD} tecken.`
                : `Minst ${MIN_PASSWORD} tecken. Utan lösenord loggar du in med länk i mejlet.`
            }
            error={shown.field === "password" ? shown.error : undefined}
            autoFocus
          />
          <Input
            label="Upprepa lösenord"
            name="confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required={passwordRequired}
            error={shown.field === "confirm" ? shown.error : undefined}
          />
        </>
      ) : null}
      <FormError message={shown.field ? undefined : shown.error} />
      <Button type="submit" variant="primary" loading={pending} className="w-full">
        {mode === "create" ? "Skapa konto och gå med" : `Gå med i ${organizationName}`}
      </Button>
      {loginHref ? (
        <p className="text-sm text-muted">
          {state.accountExists ? "Kontot finns redan. " : "Har du redan ett konto? "}
          <Link
            href={loginHref}
            className="text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg"
          >
            Logga in och gå med
          </Link>
        </p>
      ) : null}
    </form>
  );
}

function passwordProblem(password: string, confirm: string, required: boolean): AcceptState | null {
  if (password === "" && confirm === "") {
    return required
      ? { error: `Välj ett lösenord, minst ${MIN_PASSWORD} tecken.`, field: "password" }
      : null;
  }
  if (password.length < MIN_PASSWORD) {
    return { error: `Lösenordet måste ha minst ${MIN_PASSWORD} tecken.`, field: "password" };
  }
  if (password !== confirm) {
    return { error: "Lösenorden är inte lika.", field: "confirm" };
  }
  return null;
}

/** Inloggad med en annan adress än inbjudans: logga ut och visa sidan igen. */
export function SwitchAccount({
  currentEmail,
  invitedEmail,
}: {
  currentEmail: string;
  invitedEmail: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col gap-5">
      <p className="text-base text-muted">
        Du är inloggad som <span className="text-fg">{currentEmail}</span>. Inbjudan gäller{" "}
        <span className="text-fg">{invitedEmail}</span>. Logga ut och fortsätt med den adressen.
      </p>
      <Button
        variant="primary"
        className="w-full"
        loading={pending}
        onClick={() =>
          startTransition(async () => {
            await logout();
            router.refresh();
          })
        }
      >
        Logga ut och fortsätt
      </Button>
    </div>
  );
}
