"use client";

import { useActionState, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";

import { requestMagicLink, signIn } from "./actions";
import { FormError } from "./form-error";
import type { LoginState, MagicLinkState } from "./state";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

type FieldErrors = { email?: string; password?: string };

function value(form: HTMLFormElement, name: string): string {
  const v = new FormData(form).get(name);
  return typeof v === "string" ? v : "";
}

/** Fältkontroller före anropet, med svenska texter i stället för webbläsarens. */
function emailProblem(email: string): string | undefined {
  if (email.trim() === "") return "Skriv din e-postadress.";
  if (!EMAIL.test(email.trim())) return "Det ser inte ut som en e-postadress.";
  return undefined;
}

/**
 * Formuläret på /logga-in. Fungerar utan JavaScript (form action). Felen är
 * desamma för okänd adress och fel lösenord, och länkläget svarar likadant
 * oavsett om adressen har ett konto.
 */
export function LoginForm({
  next,
  initialMode,
  notice,
}: {
  /** Lokal sökväg efter inloggning ("" = startsidan). Redan kontrollerad på servern. */
  next: string;
  initialMode: "password" | "magic-link";
  /** Meddelande från ?fel=, t.ex. en länk som gått ut. */
  notice?: string;
}) {
  const [mode, setMode] = useState(initialMode);
  const canUseMagicLink = initialMode === "magic-link";
  return mode === "magic-link" ? (
    <MagicLinkForm next={next} notice={notice} onUsePassword={() => setMode("password")} />
  ) : (
    <PasswordForm
      next={next}
      notice={notice}
      onUseMagicLink={canUseMagicLink ? () => setMode("magic-link") : undefined}
    />
  );
}

function PasswordForm({
  next,
  notice,
  onUseMagicLink,
}: {
  next: string;
  notice?: string;
  onUseMagicLink?: () => void;
}) {
  const [state, action, pending] = useActionState<LoginState, FormData>(signIn, {});
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const error = state.error ?? (state.email === undefined ? notice : undefined);
  const check = (e: FormEvent<HTMLFormElement>) => {
    const next: FieldErrors = {
      email: emailProblem(value(e.currentTarget, "email")),
      password: value(e.currentTarget, "password") === "" ? "Skriv ditt lösenord." : undefined,
    };
    setFieldErrors(next);
    if (next.email || next.password) e.preventDefault();
  };
  return (
    <form action={action} onSubmit={check} noValidate className="flex flex-col gap-5">
      <input type="hidden" name="next" value={next} />
      <Input
        label="E-postadress"
        name="email"
        type="email"
        autoComplete="username"
        inputMode="email"
        spellCheck={false}
        defaultValue={state.email}
        error={fieldErrors.email}
        required
        autoFocus
      />
      <Input
        label="Lösenord"
        name="password"
        type="password"
        autoComplete="current-password"
        error={fieldErrors.password}
        required
      />
      <FormError message={fieldErrors.email || fieldErrors.password ? undefined : error} />
      <Button type="submit" variant="primary" loading={pending} className="w-full">
        Logga in
      </Button>
      {onUseMagicLink ? (
        <p className="text-sm text-muted">
          Glömt lösenordet?{" "}
          <button
            type="button"
            onClick={onUseMagicLink}
            className="text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg"
          >
            Få en inloggningslänk
          </button>
        </p>
      ) : null}
    </form>
  );
}

function MagicLinkForm({
  next,
  notice,
  onUsePassword,
}: {
  next: string;
  notice?: string;
  onUsePassword: () => void;
}) {
  const [state, action, pending] = useActionState<MagicLinkState, FormData>(requestMagicLink, {
    status: "idle",
  });
  const [emailError, setEmailError] = useState<string>();

  if (state.status === "sent") {
    return (
      <div className="flex flex-col gap-5" role="status">
        <dl className="flex flex-col border-y border-line">
          <div className="flex items-baseline justify-between gap-4 py-2">
            <dt className="label text-subtle">Till</dt>
            <dd className="meta truncate text-fg">{state.email}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 border-t border-line py-2">
            <dt className="label text-subtle">Gäller</dt>
            <dd className="meta text-fg">1 timme, en gång</dd>
          </div>
        </dl>
        <p className="text-base text-muted">
          Om adressen har ett konto har vi skickat en länk. Öppna den i den här webbläsaren. Kommer
          inget inom några minuter: kontrollera adressen eller skräpposten.
        </p>
        <form action={action}>
          <input type="hidden" name="next" value={next} />
          <input type="hidden" name="email" value={state.email ?? ""} />
          <Button type="submit" loading={pending}>
            Skicka igen
          </Button>
        </form>
      </div>
    );
  }

  const error = state.error ?? (state.email === undefined ? notice : undefined);
  const check = (e: FormEvent<HTMLFormElement>) => {
    const problem = emailProblem(value(e.currentTarget, "email"));
    setEmailError(problem);
    if (problem) e.preventDefault();
  };
  return (
    <form action={action} onSubmit={check} noValidate className="flex flex-col gap-5">
      <input type="hidden" name="next" value={next} />
      <Input
        label="E-postadress"
        name="email"
        type="email"
        autoComplete="email"
        error={emailError}
        inputMode="email"
        spellCheck={false}
        defaultValue={state.email}
        hint="Vi skickar en länk som loggar in dig. Inget lösenord behövs."
        required
        autoFocus
      />
      <FormError message={emailError ? undefined : error} />
      <Button type="submit" variant="primary" loading={pending} className="w-full">
        Skicka inloggningslänk
      </Button>
      <p className="text-sm text-muted">
        Har du ett lösenord?{" "}
        <button
          type="button"
          onClick={onUsePassword}
          className="text-fg underline decoration-line-strong underline-offset-4 hover:decoration-fg"
        >
          Logga in med lösenord
        </button>
      </p>
    </form>
  );
}
