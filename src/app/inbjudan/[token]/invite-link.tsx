"use client";

import Link from "next/link";

import { Notice } from "@/components/v2/notice";
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
    <div className="fade-in flex flex-col gap-3">
      {fragment.kind === "error" ? (
        <div role="alert">
          <Notice tone="critical" title={t.invite.linkFailed} />
        </div>
      ) : null}
      <Link href={loginHref} className="v2-btn lg act w-full">
        {t.invite.loginAs(email)}
      </Link>
    </div>
  );
}
