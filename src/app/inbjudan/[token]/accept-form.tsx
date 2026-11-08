"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useActionState, useState, useTransition, type FormEvent, type ReactNode } from "react";

import { FormError } from "@/app/logga-in/form-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { useT } from "@/i18n/client";
import type { Messages } from "@/i18n/sv";
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
  const t = useT();
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
    const problem = asksPassword ? passwordProblem(password, confirm, passwordRequired, t) : null;
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
            label={t.invite.choosePassword}
            name="password"
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required={passwordRequired}
            hint={t.invite.minChars(MIN_PASSWORD)}
            error={
              shown.field === "password" && shown.error ? t.serverError(shown.error) : undefined
            }
            autoFocus={passwordRequired}
          />
          <Input
            label={t.invite.repeatPassword}
            name="confirm"
            type="password"
            autoComplete="new-password"
            value={confirm}
            onChange={(e) => setConfirm(e.target.value)}
            required={passwordRequired}
            error={
              shown.field === "confirm" && shown.error ? t.serverError(shown.error) : undefined
            }
          />
        </PasswordFields>
      ) : null}
      <FormError message={shown.field || !shown.error ? undefined : t.serverError(shown.error)} />
      <Button type="submit" variant="primary" loading={pending} className="h-12 w-full text-lg">
        {mode === "create" ? t.invite.createAndJoin : t.invite.join(organizationName)}
      </Button>
      {loginHref ? (
        <p className="text-sm text-muted">
          {state.accountExists ? t.invite.accountExistsShort : t.invite.haveAccount}
          <Link
            href={loginHref}
            className="text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg max-md:tap"
          >
            {t.invite.loginAndJoin}
          </Link>
        </p>
      ) : null}
    </form>
  );
}

/** Valfritt lösenord ligger hopfällt: ett steg, en knapp. Krävs det visas fälten direkt. */
function PasswordFields({ optional, children }: { optional: boolean; children: ReactNode }) {
  const t = useT();
  if (!optional) return <>{children}</>;
  return (
    <details className="group flex flex-col">
      <summary className="cursor-pointer text-sm text-muted hover:text-fg">
        {t.invite.optionalPassword}
      </summary>
      <div className="mt-4 flex flex-col gap-5">{children}</div>
    </details>
  );
}

function passwordProblem(
  password: string,
  confirm: string,
  required: boolean,
  t: Messages,
): AcceptState | null {
  if (password === "" && confirm === "") {
    return required ? { error: t.invite.passwordRequired(MIN_PASSWORD), field: "password" } : null;
  }
  if (password.length < MIN_PASSWORD) {
    return { error: t.invite.passwordShort(MIN_PASSWORD), field: "password" };
  }
  if (password !== confirm) {
    return { error: t.invite.passwordMismatch, field: "confirm" };
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
  const t = useT();
  const [pending, startTransition] = useTransition();
  return (
    <div className="flex flex-col gap-5">
      <p className="text-base text-muted">
        {t.invite.signedInAs}
        <span className="text-fg">{currentEmail}</span>
        {t.invite.invitationFor}
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
        {t.invite.logoutContinue}
      </Button>
    </div>
  );
}
