"use client";

import { useRouter } from "next/navigation";
import { useTransition } from "react";
import { Logo } from "@/components/shell/logo";
import { StateMessage } from "@/components/ui/state-message";
import { logout } from "@/server/actions/auth";

/**
 * Visas i stället för appen när den inloggade användaren inte är medlem i någon
 * organisation (t.ex. ett borttaget medlemskap). Inget annat går att göra än att logga ut.
 */
export function NoOrganization({ email }: { email: string }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  return (
    <main
      id="main"
      className="mx-auto flex min-h-dvh w-full max-w-[640px] flex-col justify-center px-4 py-16"
    >
      <div className="mb-8">
        <Logo />
      </div>
      <h1 className="text-2xl font-medium text-balance text-fg">
        Inget medlemskap.
        <span className="text-subtle"> {email} är inte med i någon organisation.</span>
      </h1>
      <StateMessage
        className="mt-6"
        kind="denied"
        message="Be ägaren av organisationen om en ny inbjudan, eller logga in med ett annat konto."
        action={{
          label: "Logga ut",
          loading: pending,
          onClick: () =>
            startTransition(async () => {
              await logout();
              router.replace("/logga-in");
            }),
        }}
      />
    </main>
  );
}
