"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { FormError } from "@/app/logga-in/form-error";
import { Logo } from "@/components/shell/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { acceptMyInvitation, logout } from "@/server/actions/auth";
import type { MyInvitation } from "@/server/auth/flows";
import { createOrganization } from "@/server/onboarding/actions";

import { ROLE_LABEL } from "./installningar/anvandare/model";

/**
 * Visas i stället för appen när den inloggade användaren inte är medlem i någon
 * organisation: ett nytt konto, eller ett borttaget medlemskap.
 *
 * En ny operatör skapar organisationen här (RPC:n create_organization, med användaren
 * som ägare) och kommer sedan till Kom igång. Den som ska in i en befintlig organisation
 * behöver en inbjudan från dess ägare. Fungerar med tangentbord: namnfältet har fokus,
 * Enter skapar.
 *
 * Har personen en egen inbjudan (t.ex. delägaren som fick lösenord av ägaren och
 * loggade in utan mejlet) visas den först: ett tryck och man är med.
 */
export function NoOrganization({
  email,
  invitations = [],
}: {
  email: string;
  invitations?: readonly MyInvitation[];
}) {
  if (invitations.length > 0) {
    return <Invited email={email} invitations={invitations} />;
  }
  return <CreateOrganization email={email} />;
}

function Invited({ email, invitations }: { email: string; invitations: readonly MyInvitation[] }) {
  const router = useRouter();
  const [pending, startJoin] = useTransition();
  const [joining, setJoining] = useState<string>();
  const [error, setError] = useState<string>();
  const [leaving, startLeave] = useTransition();
  const join = (id: string) => {
    setError(undefined);
    setJoining(id);
    startJoin(async () => {
      const result = await acceptMyInvitation(id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.replace("/");
      router.refresh();
    });
  };
  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh w-full max-w-[520px] flex-col justify-center gap-8 px-4 py-16"
    >
      <Logo />
      <h1 className="rise text-3xl font-medium text-balance text-fg">Du är inbjuden.</h1>
      <ul className="flex flex-col gap-3">
        {invitations.map((inv, i) => (
          <li
            key={inv.id}
            className="rise flex flex-col gap-3 rounded-md border border-line bg-surface p-4"
            style={{ "--i": i + 1 } as React.CSSProperties}
          >
            <p className="flex items-baseline justify-between gap-3">
              <span className="text-lg font-medium text-fg">{inv.organizationName}</span>
              <span className="label text-subtle">{inv.storeName ?? ROLE_LABEL[inv.role]}</span>
            </p>
            <Button
              variant="primary"
              className="h-12 w-full text-lg"
              loading={pending && joining === inv.id}
              onClick={() => join(inv.id)}
            >
              Gå med
            </Button>
          </li>
        ))}
      </ul>
      <FormError message={error} />
      <p className="meta wrap-anywhere text-subtle">
        {unbreakable(email)} ·{" "}
        <button
          type="button"
          disabled={leaving}
          className="underline decoration-line-strong underline-offset-4 hover:text-fg"
          onClick={() =>
            startLeave(async () => {
              await logout();
              router.replace("/logga-in");
            })
          }
        >
          Logga ut
        </button>
      </p>
    </main>
  );
}

function CreateOrganization({ email }: { email: string }) {
  const router = useRouter();
  const [creating, startCreate] = useTransition();
  const [leaving, startLeave] = useTransition();
  const [fieldError, setFieldError] = useState<string>();
  const [error, setError] = useState<string>();

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const raw = new FormData(e.currentTarget).get("name");
    const name = typeof raw === "string" ? raw.trim() : "";
    setError(undefined);
    if (name.length < 2) {
      setFieldError("Ange organisationens namn.");
      return;
    }
    setFieldError(undefined);
    startCreate(async () => {
      const result = await createOrganization({ name });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      router.replace("/kom-igang");
      router.refresh();
    });
  };

  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh w-full max-w-[640px] flex-col justify-center px-4 py-16"
    >
      <div className="mb-8">
        <Logo />
      </div>
      <h1 className="text-2xl font-medium text-balance hyphens-none text-fg">
        Inget medlemskap.
        <span className="text-subtle">
          {" "}
          <span className="wrap-anywhere">{unbreakable(email)}</span> är inte med i någon
          organisation.
        </span>
      </h1>

      <section aria-labelledby="ny-organisation" className="mt-10 flex flex-col gap-6">
        <div className="flex flex-col gap-3">
          <p className="label text-muted">
            <span className="text-fg">01</span>
            <span className="text-faint"> / </span>
            Ny operatör
          </p>
          <h2
            id="ny-organisation"
            className="text-lg font-medium text-balance hyphens-none text-fg"
          >
            Skapa organisationen.
            <span className="text-subtle"> Du blir ägare och kan bjuda in fler.</span>
          </h2>
          <p className="text-sm text-muted">
            Sedan läggs butik, automat, datakälla och inköpspriser in, steg för steg.
          </p>
        </div>
        <form onSubmit={submit} noValidate className="flex flex-col gap-5">
          <Input
            label="Organisationens namn"
            name="name"
            autoComplete="organization"
            maxLength={120}
            hint="Står i menyn, i rapporterna och i mejlen."
            error={fieldError}
            required
            autoFocus
          />
          <FormError message={error} />
          <div className="flex flex-col-reverse gap-3 sm:flex-row sm:items-center sm:justify-between">
            <Button
              type="button"
              variant="ghost"
              loading={leaving}
              onClick={() =>
                startLeave(async () => {
                  await logout();
                  router.replace("/logga-in");
                })
              }
            >
              Logga ut
            </Button>
            <Button type="submit" variant="primary" loading={creating}>
              Skapa organisation
            </Button>
          </div>
        </form>
      </section>

      <section
        aria-labelledby="inbjudan"
        className="mt-12 flex flex-col gap-3 border-t border-line pt-8"
      >
        <p className="label text-muted">
          <span className="text-fg">02</span>
          <span className="text-faint"> / </span>
          Befintlig organisation
        </p>
        <h2 id="inbjudan" className="text-md font-medium text-balance hyphens-none text-fg">
          Gå med via en inbjudan.
          <span className="text-subtle">
            {" "}
            Ägaren skickar den till <span className="wrap-anywhere">{unbreakable(email)}</span>.
          </span>
        </h2>
        <p className="text-sm text-muted">
          Inbjudan öppnas från länken i mejlet och gäller en gång. Har medlemskapet tagits bort
          behövs en ny inbjudan.
        </p>
      </section>
    </main>
  );
}

/** Adressen bryts aldrig vid bindestreck (hårt bindestreck, U+2011), bara där den måste. */
function unbreakable(email: string): string {
  return email.replaceAll("-", "\u2011");
}
