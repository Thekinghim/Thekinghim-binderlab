import type { Metadata } from "next";
import Link from "next/link";
import type { ReactNode } from "react";

import { ROLE_LABEL, ROLE_SUMMARY } from "@/app/(app)/installningar/anvandare/model";
import { AuthFrame } from "@/app/logga-in/auth-frame";
import { getServerEnv } from "@/lib/env";
import { describeInvitation } from "@/server/invitations";
import { getSessionUser } from "@/server/session";

import { AcceptForm, SwitchAccount } from "./accept-form";
import { devAccountExists } from "./account";

export const metadata: Metadata = { title: "Inbjudan" };

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

const INVALID: Record<"missing" | "expired" | "accepted", { aside: string; body: string }> = {
  // Okänd token: återkallad, ersatt av en ny länk ("Skicka igen") eller avklippt.
  // Sidan kan inte skilja dem åt utan att avslöja mer, så texten är neutral.
  missing: {
    aside: "Länken gäller inte längre.",
    body: "Den kan ha återkallats eller ersatts av en nyare länk. Be den som bjöd in dig om en ny, eller kontrollera att hela länken kom med från mejlet.",
  },
  expired: {
    aside: "Den har gått ut.",
    body: "En inbjudan gäller i 7 dagar. Be den som bjöd in dig om en ny.",
  },
  accepted: {
    aside: "Den har redan använts.",
    body: "Har du redan gått med loggar du in som vanligt.",
  },
};

function Eyebrow() {
  return (
    <>
      <span className="tnum text-fg">01</span>
      <span aria-hidden className="text-faint">
        /
      </span>
      <span>Inbjudan</span>
    </>
  );
}

function Facts({ rows }: { rows: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="flex flex-col border-y border-line">
      {rows.map((r, i) => (
        <div
          key={r.label}
          className={`flex items-baseline justify-between gap-4 py-2 ${i > 0 ? "border-t border-line" : ""}`}
        >
          <dt className="label shrink-0 text-subtle">{r.label}</dt>
          <dd className="meta min-w-0 truncate text-right text-fg">{r.value}</dd>
        </div>
      ))}
    </dl>
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

  if (lookup.status !== "valid") {
    const copy = INVALID[lookup.status];
    return (
      <AuthFrame eyebrow={<Eyebrow />} title="Inbjudan gäller inte." aside={copy.aside}>
        <div className="flex flex-col gap-5">
          <p className="text-base text-muted">{copy.body}</p>
          <Link
            href={user ? "/" : "/logga-in"}
            className="inline-flex h-9 w-fit items-center rounded-sm border border-line-strong bg-surface px-3.5 text-base font-medium text-fg hover:border-line-control hover:bg-hover"
          >
            {user ? "Öppna Binderlab" : "Till inloggningen"}
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
      <div className="flex flex-col gap-5">
        <p className="text-base text-muted">
          Det finns redan ett konto för {lookup.email}. Logga in, så kommer du tillbaka hit. Sedan
          räcker ett klick för att gå med.
        </p>
        <Link
          href={loginHref}
          className="inline-flex h-9 w-full items-center justify-center rounded-sm border border-inverse bg-inverse px-3.5 text-base font-medium text-on-inverse hover:bg-inverse-hover"
        >
          Logga in och gå med
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
      <div className="flex flex-col gap-5">
        <p className="text-base text-muted">
          Logga in med {lookup.email} för att gå med, eller öppna länken direkt från mejlet.
        </p>
        <Link
          href={loginHref}
          className="inline-flex h-9 w-full items-center justify-center rounded-sm border border-inverse bg-inverse px-3.5 text-base font-medium text-on-inverse hover:bg-inverse-hover"
        >
          Logga in
        </Link>
      </div>
    );
  }

  return (
    <AuthFrame
      eyebrow={<Eyebrow />}
      title="Du är inbjuden."
      aside={`${lookup.organizationName} som ${ROLE_LABEL[lookup.role].toLowerCase()}.`}
    >
      <div className="flex flex-col gap-8">
        <div className="flex flex-col gap-3">
          <Facts
            rows={[
              { label: "Organisation", value: lookup.organizationName },
              { label: "Roll", value: ROLE_LABEL[lookup.role] },
              { label: "E-post", value: lookup.email },
            ]}
          />
          <p className="text-sm text-muted">{ROLE_SUMMARY[lookup.role]}</p>
        </div>
        {body}
      </div>
    </AuthFrame>
  );
}
