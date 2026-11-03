import type { Metadata } from "next";
import type { ReactNode } from "react";

import { Wordmark } from "@/components/brand/wordmark";
import { ThemeToggle } from "@/components/shell/theme-toggle";
import { describeSigningLink } from "@/server/contracts/signing";

import { SignForm, SignedReceipt } from "./sign-form";

export const metadata: Metadata = {
  title: "Signera avtal",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

export const dynamic = "force-dynamic";

const CLOSED: Record<"missing" | "expired" | "used" | "changed", { title: string; body: string }> =
  {
    // Okänd, ersatt av en ny länk eller avklippt: texten avslöjar inget.
    missing: { title: "Länken fungerar inte.", body: "Be om en ny länk." },
    expired: { title: "Länken har gått ut.", body: "Be om en ny länk." },
    used: { title: "Avtalet är redan signerat.", body: "Länken kan bara användas en gång." },
    changed: { title: "Avtalet har ändrats.", body: "Be om en ny länk." },
  };

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-dvh overflow-x-clip bg-bg">
      <div className="mx-auto flex min-h-dvh w-full max-w-[720px] flex-col px-4 md:px-8">
        <header className="flex h-16 items-center justify-between">
          <Wordmark size="md" />
          <ThemeToggle />
        </header>
        <main id="main" className="flex flex-1 flex-col pt-6 pb-16 md:pt-16">
          {children}
        </main>
      </div>
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
        <p className="label text-subtle">{lookup.organizationName}</p>
        <h1 className="mt-2 mb-8 text-2xl font-medium text-fg">
          {lookup.contractTitle} · {lookup.storeName}
        </h1>
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
        <div className="rise flex flex-col gap-3">
          <h1 className="text-2xl font-medium text-fg">{copy.title}</h1>
          <p className="text-base text-muted">
            {copy.body}
            {lookup.status !== "missing" && lookup.organizationName
              ? ` Kontakta ${lookup.organizationName}.`
              : ""}
          </p>
        </div>
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
      <div className="rise flex flex-col gap-2">
        <p className="label text-subtle">
          {lookup.organizationName} · Avtal {lookup.reference}
        </p>
        <h1 className="text-2xl font-medium text-balance text-fg">
          {lookup.contractTitle} för {lookup.storeName}
        </h1>
        <p className="text-sm text-muted">Länken gäller till {until}.</p>
      </div>

      {lookup.terms ? (
        <ul
          className="rise mt-6 flex flex-col gap-1.5 border-y border-line py-4 text-base text-fg"
          style={{ "--i": 1 } as React.CSSProperties}
        >
          {lookup.terms
            .split("\n")
            .filter((line) => line.trim() !== "")
            .map((line) => (
              <li key={line} className="flex gap-2">
                <span aria-hidden className="text-subtle">
                  ·
                </span>
                <span>{line}</span>
              </li>
            ))}
        </ul>
      ) : null}

      <div className="mt-8">
        <SignForm
          token={token}
          documentSha256={lookup.documentSha256}
          storeName={lookup.storeName}
        />
      </div>
    </Frame>
  );
}
