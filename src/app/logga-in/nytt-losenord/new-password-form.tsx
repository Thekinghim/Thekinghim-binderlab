"use client";

import { useActionState, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";

import { setNewPassword } from "../actions";
import { FormError } from "../form-error";
import { LinkFailed, LinkPending, useLinkFragment } from "../link-landing";
import type { NewPasswordState } from "../state";

/** Samma gräns som servern (src/server/auth/password.ts). */
const MIN_PASSWORD = 12;

/** Nytt lösenord från "Glömt lösenord?"-länken. Sparar och loggar in. */
export function NewPasswordForm() {
  const [state, action, pending] = useActionState<NewPasswordState, FormData>(setNewPassword, {});
  const fragment = useLinkFragment();
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [local, setLocal] = useState<{ field: "password" | "confirm"; error: string } | null>(null);

  if (fragment === null) return <LinkPending />;
  if (fragment.kind !== "tokens" || state.failed) {
    return <LinkFailed retryHref="/logga-in?vy=glomt" />;
  }

  const check = (e: FormEvent<HTMLFormElement>) => {
    const problem =
      password.length < MIN_PASSWORD
        ? { field: "password" as const, error: `Minst ${MIN_PASSWORD} tecken.` }
        : password !== confirm
          ? { field: "confirm" as const, error: "Lösenorden är inte lika." }
          : null;
    setLocal(problem);
    if (problem) e.preventDefault();
  };

  return (
    <form action={action} onSubmit={check} noValidate className="flex flex-col gap-5">
      <input type="hidden" name="access_token" value={fragment.accessToken} />
      <input type="hidden" name="refresh_token" value={fragment.refreshToken} />
      {fragment.email ? (
        <input type="hidden" name="username" autoComplete="username" value={fragment.email} />
      ) : null}
      <Input
        label="Nytt lösenord"
        name="password"
        type="password"
        autoComplete="new-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        hint={`Minst ${MIN_PASSWORD} tecken.`}
        error={local?.field === "password" ? local.error : undefined}
        autoFocus
      />
      <Input
        label="Upprepa"
        name="confirm"
        type="password"
        autoComplete="new-password"
        value={confirm}
        onChange={(e) => setConfirm(e.target.value)}
        error={local?.field === "confirm" ? local.error : undefined}
      />
      <FormError message={local ? undefined : state.error} />
      <Button type="submit" variant="primary" loading={pending} className="h-12 w-full text-lg">
        Spara och logga in
      </Button>
    </form>
  );
}
