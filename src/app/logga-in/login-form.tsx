"use client";

import { useActionState, useEffect, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";

import { requestMagicLink, requestPasswordReset, signIn } from "./actions";
import { FormError } from "./form-error";
import type { LoginState, MagicLinkState } from "./state";

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export type LoginMode = "password" | "magic-link" | "forgot";

type FieldErrors = { email?: string; password?: string };

/** Flyttar fokus till fältet med namnet `name` i formuläret. */
function focusField(form: HTMLFormElement, name: string): void {
  const el = form.elements.namedItem(name);
  if (el instanceof HTMLElement) el.focus();
}

function value(form: HTMLFormElement, name: string): string {
  const v = new FormData(form).get(name);
  return typeof v === "string" ? v : "";
}

/** Fältkontroller före anropet, med svenska texter i stället för webbläsarens. */
export function emailProblem(email: string): string | undefined {
  if (email.trim() === "") return "Skriv din e-post.";
  if (!EMAIL.test(email.trim())) return "Det ser inte ut som en e-post.";
  return undefined;
}

const LINK =
  "text-fg underline decoration-line-strong underline-offset-4 max-md:tap hover:decoration-fg";
const BIG = "h-12 w-full text-lg";

/**
 * Formuläret på /logga-in: länk i mejlet (Supabase), lösenord och "Glömt
 * lösenord?". Fungerar utan JavaScript (form action). Felen är desamma för
 * okänd adress och fel lösenord, och länkarna svarar likadant oavsett om
 * adressen har ett konto.
 */
export function LoginForm({
  next,
  initialMode,
  canUseLinks,
  notice,
}: {
  /** Lokal sökväg efter inloggning ("" = startsidan). Redan kontrollerad på servern. */
  next: string;
  initialMode: LoginMode;
  /** Supabase: länk i mejlet och "Glömt lösenord?" finns. */
  canUseLinks: boolean;
  /** Meddelande från ?fel=, t.ex. en länk som inte gick. */
  notice?: string;
}) {
  const [mode, setMode] = useState<LoginMode>(canUseLinks ? initialMode : "password");

  // Skickade Supabase hit en länk (t.ex. till sajtens adress i stället för
  // /logga-in/bekrafta) tas den emot där, med fragmentet kvar.
  useEffect(() => {
    const { hash } = window.location;
    if (/(^#|&)(access_token|error_code)=/.test(hash)) {
      window.location.replace(`/logga-in/bekrafta${hash}`);
    }
  }, []);

  if (mode === "magic-link") {
    return (
      <LinkForm
        kind="login"
        next={next}
        notice={notice}
        footer={
          <button type="button" onClick={() => setMode("password")} className={LINK}>
            Logga in med lösenord
          </button>
        }
      />
    );
  }
  if (mode === "forgot") {
    return (
      <LinkForm
        kind="reset"
        next={next}
        footer={
          <button type="button" onClick={() => setMode("password")} className={LINK}>
            Tillbaka
          </button>
        }
      />
    );
  }
  return (
    <PasswordForm
      next={next}
      notice={notice}
      footer={
        canUseLinks ? (
          <>
            <button type="button" onClick={() => setMode("forgot")} className={LINK}>
              Glömt lösenord?
            </button>
            <button type="button" onClick={() => setMode("magic-link")} className={LINK}>
              Få länk i mejlet
            </button>
          </>
        ) : null
      }
    />
  );
}

function PasswordForm({
  next,
  notice,
  footer,
}: {
  next: string;
  notice?: string;
  footer: React.ReactNode;
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
    if (next.email || next.password) {
      e.preventDefault();
      // Fokus till första fältet med fel, så att felet läses upp och kan rättas direkt.
      focusField(e.currentTarget, next.email ? "email" : "password");
    }
  };
  return (
    <form action={action} onSubmit={check} noValidate className="fade-in flex flex-col gap-5">
      <input type="hidden" name="next" value={next} />
      <Input
        label="E-post"
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
      <Button type="submit" variant="primary" loading={pending} className={BIG}>
        Logga in
      </Button>
      {footer ? (
        <p className="flex flex-wrap justify-between gap-x-6 gap-y-2 text-sm">{footer}</p>
      ) : null}
    </form>
  );
}

/** "Skicka länk" (inloggning) och "Glömt lösenord?" (länk för nytt lösenord). */
function LinkForm({
  kind,
  next,
  notice,
  footer,
}: {
  kind: "login" | "reset";
  next: string;
  notice?: string;
  footer: React.ReactNode;
}) {
  const [state, action, pending] = useActionState<MagicLinkState, FormData>(
    kind === "login" ? requestMagicLink : requestPasswordReset,
    { status: "idle" },
  );
  const [emailError, setEmailError] = useState<string>();

  if (state.status === "sent") {
    return (
      <div className="fade-in flex flex-col gap-5" role="status">
        <p className="flex items-center gap-3 text-lg text-fg">
          <span className="flex size-8 shrink-0 items-center justify-center rounded-full bg-up/15 text-up">
            <Icon name="check" size={16} />
          </span>
          Kolla mejlen.
        </p>
        <dl className="flex flex-col border-y border-line">
          <div className="flex items-baseline justify-between gap-4 py-2">
            <dt className="label text-subtle">Till</dt>
            <dd className="meta truncate text-fg">{state.email}</dd>
          </div>
          <div className="flex items-baseline justify-between gap-4 border-t border-line py-2">
            <dt className="label text-subtle">Gäller</dt>
            <dd className="meta text-fg">1 timme</dd>
          </div>
        </dl>
        <form action={action}>
          <input type="hidden" name="next" value={next} />
          <input type="hidden" name="email" value={state.email ?? ""} />
          <Button type="submit" loading={pending}>
            Skicka igen
          </Button>
        </form>
        <p className="text-sm">{footer}</p>
      </div>
    );
  }

  const error = state.error ?? (state.email === undefined ? notice : undefined);
  const check = (e: FormEvent<HTMLFormElement>) => {
    const problem = emailProblem(value(e.currentTarget, "email"));
    setEmailError(problem);
    if (problem) {
      e.preventDefault();
      focusField(e.currentTarget, "email");
    }
  };
  return (
    <form action={action} onSubmit={check} noValidate className="fade-in flex flex-col gap-5">
      <input type="hidden" name="next" value={next} />
      <Input
        label="E-post"
        name="email"
        type="email"
        autoComplete="email"
        error={emailError}
        inputMode="email"
        spellCheck={false}
        defaultValue={state.email}
        required
        autoFocus
      />
      <FormError message={emailError ? undefined : error} />
      <Button type="submit" variant="primary" loading={pending} className={BIG}>
        {kind === "login" ? "Skicka länk" : "Skicka länk för nytt lösenord"}
      </Button>
      <p className="text-sm">{footer}</p>
    </form>
  );
}
