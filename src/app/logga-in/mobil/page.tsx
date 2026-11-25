import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

import { getServiceDb } from "@/db/client";
import { qrAccountName } from "@/server/auth/phone-login";
import { STAFF_QR_COOKIE } from "@/server/auth/phone-qr-cookie";

import { getSessionUser } from "@/server/session";

import { AuthFrame } from "../auth-frame";

import { PhoneLoginForm } from "./phone-form";

export const metadata: Metadata = { title: "Logga in med mobilnummer" };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Inloggning för påfyllare i butiken. QR-koden på automaten (/m/<nyckel>) leder hit med
 * nyckeln i en cookie: då räcker PIN-koden. Annars mobilnummer och PIN-kod. Den som redan
 * är inloggad skickas till Fyll på.
 */
export default async function PhoneLoginPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const user = await getSessionUser().catch(() => null);
  if (user) redirect("/pafyll");
  const token = (await cookies()).get(STAFF_QR_COOKIE)?.value;
  const qrName =
    token && params.nummer !== "1"
      ? await qrAccountName(getServiceDb, token).catch(() => null)
      : null;
  const notice =
    params.ute === "1"
      ? "Du är utloggad. Logga in igen."
      : token && !qrName && params.nummer !== "1"
        ? "QR-koden gäller inte längre. Logga in med mobilnummer, eller be den som gav dig kontot om en ny QR-kod."
        : undefined;
  return (
    <AuthFrame
      title="Fyll på automaten"
      // Med QR-koden säger formuläret redan "Hej …! Skriv din PIN-kod.": ingen rad till.
      aside={qrName ? undefined : "Logga in med ditt mobilnummer och din PIN-kod."}
      systemStatus={false}
    >
      <PhoneLoginForm notice={notice} qrName={qrName ?? undefined} />
      <p className="mt-4 flex flex-col gap-2 text-v2-sm text-v2-mute">
        {qrName ? (
          <a href="/logga-in/mobil?nummer=1" className="v2-auth-link">
            Inte du? Logga in med mobilnummer
          </a>
        ) : null}
        <a href="/logga-in" className="text-v2-mute underline">
          Ägare: logga in med e-post
        </a>
      </p>
    </AuthFrame>
  );
}
