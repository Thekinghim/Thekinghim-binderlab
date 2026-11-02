import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getServerEnv } from "@/lib/env";
import { safeRedirectPath } from "@/server/auth/paths";
import { getSessionUser } from "@/server/session";

import { AuthFrame } from "./auth-frame";
import { LoginForm } from "./login-form";
import { LOGIN_NOTICES } from "./state";

export const metadata: Metadata = { title: "Logga in" };

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Inloggning. Lokalt (AUTH_PROVIDER=dev) med e-post och lösenord; med
 * Supabase i första hand med en länk i mejlet, och lösenord som alternativ
 * (för den som valt ett när inbjudan togs emot).
 *
 * `?next=` tas bara emot som lokal sökväg (safeRedirectPath). Den som redan
 * är inloggad skickas dit direkt.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const params = await searchParams;
  const next = safeRedirectPath(first(params.next));
  if (await getSessionUser()) {
    redirect(next);
  }
  const notice = LOGIN_NOTICES[first(params.fel) ?? ""];
  let mode: "password" | "magic-link" = "password";
  try {
    mode = getServerEnv().AUTH_PROVIDER === "supabase" ? "magic-link" : "password";
  } catch {
    // Felkonfigurerad miljö: formuläret visas, och inloggningen svarar med ett fel.
  }

  return (
    <AuthFrame
      eyebrow={
        <>
          <span className="tnum text-fg">01</span>
          <span aria-hidden className="text-faint">
            /
          </span>
          <span>Inloggning</span>
        </>
      }
      title="Logga in."
      aside="Försäljning, lager och lönsamhet för varje automat."
    >
      <LoginForm next={next === "/" ? "" : next} initialMode={mode} notice={notice} />
    </AuthFrame>
  );
}
