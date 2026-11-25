import type { Metadata } from "next";
import type { ReactNode } from "react";

import { V2Logo } from "@/components/v2/shell/nav-icon";
import { describeSigningLink } from "@/server/contracts/signing";

import { SignForm, SignedReceipt } from "./sign-form";

import "@/app/logga-in/auth.css";

export const metadata: Metadata = {
  title: "Signera avtal",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

const CLOSED: Record<"missing" | "expired" | "used" | "changed", { title: string; body: string }> =
  {
    // Okänd, ersatt av en ny länk eller avklippt: texten avslöjar inget.
    missing: { title: "Länken fungerar inte", body: "Be om en ny länk." },
    expired: { title: "Länken har gått ut", body: "Be om en ny länk." },
    used: { title: "Avtalet är redan signerat", body: "Länken kan bara användas en gång." },
    changed: { title: "Avtalet har ändrats", body: "Be om en ny länk." },
  };

/** V2-ramen (som inloggningen): loggan överst och ett vitt kort mitt på den grå ytan. */
function Frame({ children }: { children: ReactNode }) {
  return (
    <div data-ui="v2" className="v2-auth">
      <header className="v2-auth-top">
        <span className="v2-auth-brand">
          <V2Logo size={28} />
          Binderlab
        </span>
      </header>
      <main id="main" className="v2-auth-main">
        <div className="v2-card v2-auth-card wide v2-enter">
          <div className="v2-card-body">{children}</div>
        </div>
      </main>
    </div>
  );
}

/**
 * Signera avtal på plats (utan inloggning). Butiksägaren öppnar länken eller QR-koden från
 * Binderlab på sin mobil. Token i adressen är beviset (src/server/contracts/signing.ts).
 */
export default async function SignPage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  const lookup = await describeSigningLink(token);

  if (lookup.status === "signed") {
    return (
      <Frame>
        <div className="v2-auth-hd">
          <h1>
            {lookup.contractTitle} · {lookup.storeName}
          </h1>
          <p>{lookup.organizationName}</p>
        </div>
        <SignedReceipt
          token={token}
          signerName={lookup.signerName}
          signedAt={lookup.signedAt.toISOString()}
        />
      </Frame>
    );
  }

  if (lookup.status !== "valid") {
    const copy = CLOSED[lookup.status];
    return (
      <Frame>
        <div className="v2-auth-hd">
          <h1>{copy.title}</h1>
          <p>
            {copy.body}
            {lookup.status !== "missing" && lookup.organizationName
              ? ` Kontakta ${lookup.organizationName}.`
              : ""}
          </p>
        </div>
        {/* En väg vidare, som på en ogiltig inbjudan. */}
        <a href="/logga-in" className="v2-btn touch mt-4 w-full justify-center">
          Till inloggningen
        </a>
      </Frame>
    );
  }

  const until = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm",
    day: "numeric",
    month: "long",
  }).format(lookup.expiresAt);

  return (
    <Frame>
      <div className="v2-auth-hd">
        <h1>
          {lookup.contractTitle} för {lookup.storeName}
        </h1>
        <p>
          {lookup.organizationName} · Avtal {lookup.reference} · Länken gäller till {until}.
        </p>
      </div>

      {lookup.terms ? (
        <ul className="flex flex-col gap-1.5 rounded-v2 bg-v2-hover px-3.5 py-3 text-v2-md text-v2-ink">
          {lookup.terms
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => (
              <li key={line} className="flex gap-2">
                <span aria-hidden className="text-v2-faint">
                  ·
                </span>
                <span>{line}</span>
              </li>
            ))}
        </ul>
      ) : null}

      <div className="mt-2">
        <SignForm
          token={token}
          documentSha256={lookup.documentSha256}
          storeName={lookup.storeName}
        />
      </div>
    </Frame>
  );
}
