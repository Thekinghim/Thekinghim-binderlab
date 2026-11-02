"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition, type FormEvent } from "react";

import { FormError } from "@/app/logga-in/form-error";
import { Logo } from "@/components/shell/logo";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { logout } from "@/server/actions/auth";
import { createOrganization } from "@/server/onboarding/actions";

/**
 * Visas i stället för appen när den inloggade användaren inte är medlem i någon
 * organisation: ett nytt konto, eller ett borttaget medlemskap.
 *
 * En ny operatör skapar organisationen här (RPC:n create_organization, med användaren
 * som ägare) och kommer sedan till Kom igång. Den som ska in i en befintlig organisation
 * behöver en inbjudan från dess ägare. Fungerar med tangentbord: namnfältet har fokus,
 * Enter skapar.
 */
export function NoOrganization({ email }: { email: string }) {
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
        <span className="text-subtle"> {email} är inte med i någon organisation.</span>
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
          <span className="text-subtle"> Ägaren skickar den till {email}.</span>
        </h2>
        <p className="text-sm text-muted">
          Inbjudan öppnas från länken i mejlet och gäller en gång. Har medlemskapet tagits bort
          behövs en ny inbjudan.
        </p>
      </section>
    </main>
  );
}
