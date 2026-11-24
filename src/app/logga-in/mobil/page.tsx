import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getSessionUser } from "@/server/session";

import { AuthFrame } from "../auth-frame";

import { PhoneLoginForm } from "./phone-form";

export const metadata: Metadata = { title: "Logga in med mobilnummer" };

type SearchParams = Record<string, string | string[] | undefined>;

/**
 * Inloggning med mobilnummer och PIN-kod (påfyllare i butiken). QR-koden på automaten
 * leder hit (/m). Den som redan är inloggad skickas till Fyll på.
 */
export default async function PhoneLoginPage({
  searchParams,
}: {
  searchParams: Promise<SearchParams>;
}) {
  const params = await searchParams;
  const user = await getSessionUser().catch(() => null);
  if (user) redirect("/pafyll");
  const notice =
    params.ute === "1" ? "Du är utloggad. Logga in igen med mobilnummer och PIN-kod." : undefined;
  return (
    <AuthFrame
      title="Fyll på automaten"
      aside="Logga in med ditt mobilnummer och din PIN-kod."
      systemStatus={false}
    >
      <PhoneLoginForm notice={notice} />
      <p className="mt-4 text-v2-sm">
        <a href="/logga-in" className="v2-auth-link">
          Logga in med e-post
        </a>
      </p>
    </AuthFrame>
  );
}
