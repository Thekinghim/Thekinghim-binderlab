import type { Metadata } from "next";

import { SectionHeader } from "@/components/ui/section-header";
import { loadContext } from "@/server/data/core";

import { PasswordForm } from "../_components/password-form";
import { ROLE_LABEL } from "../anvandare/model";

export const metadata: Metadata = { title: "Mitt konto" };

/**
 * Mitt konto: e-post, roll och byte av lösenord. Alla roller (loadContext kräver bara
 * inloggning och medlemskap). Lösenordet byts via auth-providern (changePasswordFlow).
 */
export default async function AccountPage() {
  const ctx = await loadContext();
  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 px-4 pt-8 pb-16 md:gap-12 md:px-8 md:pt-12">
      <SectionHeader
        className="rise"
        as="h1"
        size="xl"
        eyebrow="Mitt konto"
        title={ctx.user.displayName ?? ctx.user.email}
        meta={[
          { label: "E-post", value: ctx.user.email },
          { label: "Roll", value: ROLE_LABEL[ctx.role] },
          { label: "Organisation", value: ctx.organization.name },
        ]}
      />
      <section
        aria-labelledby="losenord"
        className="rise flex max-w-2xl flex-col gap-6"
        style={{ "--i": 1 } as React.CSSProperties}
      >
        <SectionHeader id="losenord" size="md" title="Byt lösenord." />
        <PasswordForm />
      </section>
    </div>
  );
}
