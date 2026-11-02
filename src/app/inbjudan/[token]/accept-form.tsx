"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useTransition } from "react";

import { FormError } from "@/app/logga-in/form-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { logout } from "@/server/actions/auth";

import { acceptInvitation } from "./actions";
import type { AcceptState } from "./state";

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

  return (
    <form action={action} className="flex flex-col gap-5">
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
            minLength={MIN_PASSWORD}
            required={passwordRequired}
            hint={
              passwordRequired
                ? `Minst ${MIN_PASSWORD} tecken.`
                : `Minst ${MIN_PASSWORD} tecken. Utan lösenord loggar du in med länk i mejlet.`
            }
            error={state.field === "password" ? state.error : undefined}
            autoFocus
          />
          <Input
            label="Upprepa lösenord"
            name="confirm"
            type="password"
            autoComplete="new-password"
            required={passwordRequired}
            error={state.field === "confirm" ? state.error : undefined}
          />
        </>
      ) : null}
      <FormError message={state.field ? undefined : state.error} />
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
