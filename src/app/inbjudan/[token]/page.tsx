import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { AuthFrame } from "@/app/logga-in/auth-frame";
import { KeyValues } from "@/components/v2/key-values";
import { messages, type Locale, type Messages } from "@/i18n";
import { getCookieLocale, getRequestLocale } from "@/i18n/request";
import { getServerEnv } from "@/lib/env";
import { describeInvitation } from "@/server/invitations";
import { getSessionUser } from "@/server/session";

import { AcceptForm, SwitchAccount } from "./accept-form";
import { devAccountExists } from "./account";
import { InviteLink } from "./invite-link";

export async function generateMetadata(): Promise<Metadata> {
  return { title: messages(await getRequestLocale()).invite.eyebrow };
}

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

// Okänd token: återkallad, ersatt av en ny länk ("Skicka igen") eller avklippt. Sidan kan
// inte skilja dem åt utan att avslöja mer, så texten är neutral.
function invalidCopy(
  t: Messages,
  status: "missing" | "expired" | "accepted",
): { aside: string; body: string } {
  if (status === "expired") return { aside: t.invite.expiredAside, body: t.invite.expiredBody };
  if (status === "accepted") return { aside: t.invite.acceptedAside, body: t.invite.acceptedBody };
  return { aside: t.invite.missingAside, body: t.invite.missingBody };
}

function Facts({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <KeyValues
      className="rounded-v2 bg-v2-hover px-3"
      items={rows.map((r) => ({
        key: r.label,
        label: r.label,
        value: <span className="block truncate">{r.value}</span>,
      }))}
    />
  );
}

/**
 * Inbjudan från mejlet. Visar organisation och roll (bara för en giltig
 * länk; token är beviset, se src/server/invitations.ts) och låter personen
 * gå med:
 * - inloggad med inbjudans adress: ett klick,
 * - inloggad med en annan adress: logga ut först,
 * - lokalt utan konto: välj lösenord (kontot skapas för inbjudans adress),
 * - Supabase: länken bär token_hash; ny användare kan välja lösenord.
 */
export default async function InvitationPage({
  params,
  searchParams,
}: {
  params: Promise<{ token: string }>;
  searchParams: Promise<SearchParams>;
}) {
  const { token } = await params;
  const query = await searchParams;
  const [lookup, user] = await Promise.all([describeInvitation(token), getSessionUser()]);
  const loginHref = `/logga-in?next=${encodeURIComponent(`/inbjudan/${token}`)}`;
  // Språket: personens eget val i webbläsaren, annars det ägaren valde på inbjudan, annars
  // webbläsarens språk.
  const locale: Locale =
    (await getCookieLocale()) ??
    (lookup.status === "valid" && lookup.locale === "en" ? "en" : await getRequestLocale());
  const t = messages(locale);

  if (lookup.status !== "valid") {
    const copy = invalidCopy(t, lookup.status);
    return (
      <AuthFrame title={t.invite.invalidTitle} aside={copy.aside} locale={locale}>
        <div className="flex flex-col gap-4">
          <p className="text-v2-md text-v2-mute">{copy.body}</p>
          <Link href={user ? "/" : "/logga-in"} className="v2-btn lg w-full">
            {user ? t.invite.openApp : t.invite.toLogin}
          </Link>
        </div>
      </AuthFrame>
    );
  }

  let provider: "dev" | "supabase" = "dev";
  try {
    provider = getServerEnv().AUTH_PROVIDER;
  } catch {
    // Felkonfigurerad miljö: formuläret svarar med ett fel.
  }
  const tokenHash = first(query.token_hash);
  const linkType = first(query.type);
  const sameEmail = user ? user.email.toLowerCase() === lookup.email.toLowerCase() : false;

  let body: ReactNode;
  if (user && sameEmail) {
    body = <AcceptForm token={token} mode="accept" organizationName={lookup.organizationName} />;
  } else if (user) {
    body = <SwitchAccount currentEmail={user.email} invitedEmail={lookup.email} />;
  } else if (provider === "dev" && (await devAccountExists(lookup.email))) {
    body = (
      <div className="flex flex-col gap-4">
        <p className="text-v2-md text-v2-mute">{t.invite.accountExists}</p>
        <Link href={loginHref} className="v2-btn lg act w-full">
          {t.invite.loginAndJoin}
        </Link>
      </div>
    );
  } else if (provider === "dev") {
    body = (
      <AcceptForm
        token={token}
        mode="create"
        organizationName={lookup.organizationName}
        loginHref={loginHref}
      />
    );
  } else if (tokenHash) {
    body = (
      <AcceptForm
        token={token}
        mode="link"
        tokenHash={tokenHash}
        linkType={linkType}
        organizationName={lookup.organizationName}
        loginHref={loginHref}
      />
    );
  } else {
    body = (
      <InviteLink
        token={token}
        organizationName={lookup.organizationName}
        email={lookup.email}
        loginHref={loginHref}
      />
    );
  }

  return (
    <AuthFrame
      title={t.invite.title}
      aside={
        lookup.storeName
          ? t.invite.storePortal(lookup.storeName)
          : t.invite.joinOrg(lookup.organizationName)
      }
      systemStatus={false}
      locale={locale}
      wide
    >
      <div className="flex flex-col gap-5">
        <div className="flex flex-col">
          <Facts
            rows={[
              { label: t.invite.organization, value: lookup.organizationName },
              ...(lookup.storeName ? [{ label: t.invite.store, value: lookup.storeName }] : []),
              { label: t.invite.role, value: t.invite.roles[lookup.role] },
              { label: t.invite.email, value: lookup.email },
            ]}
          />
        </div>
        {body}
      </div>
    </AuthFrame>
  );
}
