"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition, type FormEvent, type ReactNode } from "react";

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
 * - link: Supabase-länk (sessionen i fragmentet eller token_hash); lösenord är
 *   valfritt och ligger under "Välj lösenord".
 */
export function AcceptForm({
  token,
  mode,
  organizationName,
  tokenHash,
  linkType,
  linkTokens,
  loginHref,
}: {
  token: string;
  mode: "accept" | "create" | "link";
  organizationName: string;
  tokenHash?: string;
  linkType?: string;
  /** Sessionen från länkens fragment (Supabases standardmall). */
  linkTokens?: { accessToken: string; refreshToken: string };
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
    if (problem) {
      e.preventDefault();
      // Fokus till fältet med fel, så att felet läses upp och kan rättas direkt.
      const el = problem.field ? e.currentTarget.elements.namedItem(problem.field) : null;
      if (el instanceof HTMLElement) el.focus();
    }
  };

  return (
    <form action={action} onSubmit={check} noValidate className="flex flex-col gap-5">
      <input type="hidden" name="token" value={token} />
      {tokenHash ? <input type="hidden" name="token_hash" value={tokenHash} /> : null}
      {linkType ? <input type="hidden" name="type" value={linkType} /> : null}
      {linkTokens ? (
        <>
          <input type="hidden" name="access_token" value={linkTokens.accessToken} />
          <input type="hidden" name="refresh_token" value={linkTokens.refreshToken} />
        </>
      ) : null}
      {asksPassword ? (
        <PasswordFields optional={!passwordRequired}>
          <Input
            label="Välj lösenord"
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required={passwordRequired}
            hint={`Minst ${MIN_PASSWORD} tecken.`}
            error={shown.field === "password" ? shown.error : undefined}
            autoFocus={passwordRequired}
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
        </PasswordFields>
      ) : null}
      <FormError message={shown.field ? undefined : shown.error} />
      <Button type="submit" variant="primary" loading={pending} className="h-12 w-full text-lg">
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

/** Valfritt lösenord ligger hopfällt: ett steg, en knapp. Krävs det visas fälten direkt. */
function PasswordFields({ optional, children }: { optional: boolean; children: ReactNode }) {
  if (!optional) return <>{children}</>;
  return (
    <details className="group flex flex-col">
      <summary className="cursor-pointer text-sm text-muted hover:text-fg">
        Välj lösenord (valfritt)
      </summary>
      <div className="mt-4 flex flex-col gap-5">{children}</div>
    </details>
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
        Inloggad som <span className="text-fg">{currentEmail}</span>. Inbjudan gäller{" "}
        <span className="text-fg">{invitedEmail}</span>.
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
