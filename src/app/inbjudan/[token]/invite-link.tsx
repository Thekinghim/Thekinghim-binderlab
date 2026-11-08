"use client";

import Link from "next/link";

import { useT } from "@/i18n/client";

import { LinkPending, useLinkFragment } from "@/app/logga-in/link-landing";

import { AcceptForm } from "./accept-form";

/**
 * Supabase utan inloggning: inbjudningslänken med standardmallen landar med
 * sessionen i fragmentet. Finns den: "Gå med" direkt. Annars logga in.
 */
export function InviteLink({
  token,
  organizationName,
  email,
  loginHref,
}: {
  token: string;
  organizationName: string;
  email: string;
  loginHref: string;
}) {
  const t = useT();
  const fragment = useLinkFragment();
  if (fragment === null) return <LinkPending />;
  if (fragment.kind === "tokens") {
    return (
      <AcceptForm
        token={token}
        mode="link"
        organizationName={organizationName}
        linkTokens={{ accessToken: fragment.accessToken, refreshToken: fragment.refreshToken }}
        loginHref={loginHref}
      />
    );
  }
  return (
    <div className="fade-in flex flex-col gap-4">
      {fragment.kind === "error" ? (
        <p role="alert" className="text-base text-signal-fg">
          {t.invite.linkFailed}
        </p>
      ) : null}
      <Link
        href={loginHref}
        className="inline-flex h-12 w-full items-center justify-center rounded-sm border border-inverse bg-inverse px-4 text-base font-medium text-on-inverse hover:bg-inverse-hover"
      >
        {t.invite.loginAs(email)}
      </Link>
    </div>
  );
}
