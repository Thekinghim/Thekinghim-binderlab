import { ConfigMissing } from "@/components/ui/config-missing";
import { getConfigStatus } from "@/server/config-status";
import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { getServerEnv } from "@/lib/env";
import { safeRedirectPath } from "@/server/auth/paths";
import { getSessionUser } from "@/server/session";

import { AuthFrame } from "./auth-frame";
import { LoginForm, type LoginMode } from "./login-form";
import { LOGIN_NOTICES } from "./state";

export const metadata: Metadata = { title: "Logga in" };

type SearchParams = Record<string, string | string[] | undefined>;

function first(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

/**
 * Inloggning. Lokalt (AUTH_PROVIDER=dev) med e-post och lösenord; med
 * Supabase i första hand med en länk i mejlet, och lösenord som alternativ
 * (`?vy=losenord`), samt "Glömt lösenord?" (`?vy=glomt`).
 *
 * `?next=` tas bara emot som lokal sökväg (safeRedirectPath). Den som redan
 * är inloggad skickas dit direkt.
 */
export default async function LoginPage({ searchParams }: { searchParams: Promise<SearchParams> }) {
  const config = getConfigStatus();
  if (!config.ok) return <ConfigMissing issues={config.issues} />;
  const params = await searchParams;
  const next = safeRedirectPath(first(params.next));
  // Svarar inte databasen visas formuläret ändå (statusraden säger att databasen är nere),
  // i stället för en felsida: den inloggade skickas vidare när databasen svarar igen.
  const user = await getSessionUser().catch(() => null);
  if (user) {
    redirect(next);
  }
  const notice = LOGIN_NOTICES[first(params.fel) ?? ""];
  let canUseLinks = false;
  try {
    canUseLinks = getServerEnv().AUTH_PROVIDER === "supabase";
  } catch {
    // Felkonfigurerad miljö: formuläret visas, och inloggningen svarar med ett fel.
  }
  const view = first(params.vy);
  const mode: LoginMode =
    view === "losenord" ? "password" : view === "glomt" ? "forgot" : "magic-link";

  return (
    <AuthFrame eyebrow={<span>Binderlab</span>} title="Logga in.">
      <LoginForm
        next={next === "/" ? "" : next}
        initialMode={mode}
        canUseLinks={canUseLinks}
        notice={notice}
      />
    </AuthFrame>
  );
}
