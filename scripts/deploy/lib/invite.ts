/**
 * Första ägaren i ett Supabase-projekt (Auth admin-API:t med secret key).
 *
 * Varför inte POST /auth/v1/invite: Supabases inbjudningslänk
 * (`…?token_hash=…&type=invite`) tas i appen bara emot på
 * `/inbjudan/[token]`, som kräver en inbjudan till en organisation. Den
 * första ägaren har ingen organisation än, så länken skulle inte leda
 * någonstans. I stället skapas kontot med bekräftad e-post (ingen
 * självregistrering behövs), och ägaren loggar in med en inloggningslänk på
 * /logga-in och skapar organisationen under Kom igång
 * (`create_first_organization`).
 */

import { createApiClient, type FetchLike, type Sleep } from "./http";
import type { Logger } from "./log";

export interface InviteCtx {
  log: Logger;
  dryRun: boolean;
  fetch: FetchLike;
  sleep: Sleep;
}

interface AuthUser {
  id: string;
  email?: string;
  email_confirmed_at?: string | null;
  banned_until?: string | null;
}

export type OwnerResult = "skapad" | "bekräftad" | "fanns" | "planerad";

export async function ensureOwnerUser(
  ctx: InviteCtx,
  opts: { supabaseUrl: string; secretKey: string; email: string },
): Promise<OwnerResult> {
  const auth = createApiClient({
    service: "Supabase Auth",
    baseUrl: `${opts.supabaseUrl.replace(/\/+$/, "")}/auth/v1`,
    token: opts.secretKey,
    headers: { apikey: opts.secretKey },
    fetch: ctx.fetch,
    log: ctx.log,
    dryRun: ctx.dryRun,
    sleep: ctx.sleep,
  });
  const email = opts.email.toLowerCase();
  let found: AuthUser | undefined;
  for (let page = 1; page <= 50 && !found; page += 1) {
    const { data } = await auth.get<{ users?: AuthUser[] }>("/admin/users", {
      query: { page, per_page: 200 },
    });
    const users = data.users ?? [];
    found = users.find((u) => u.email?.toLowerCase() === email);
    if (users.length < 200) break;
  }
  if (found) {
    if (found.banned_until && Date.parse(found.banned_until) > Date.now()) {
      ctx.log.manual(
        `Ägarens konto ${email} är spärrat (banned_until ${found.banned_until}). Häv spärren i Supabase → Authentication → Users.`,
      );
    }
    if (found.email_confirmed_at) {
      ctx.log.ok(`Ägarens konto finns redan och e-posten är bekräftad.`);
      return "fanns";
    }
    if (ctx.dryRun) {
      ctx.log.plan(`bekräfta e-posten för det befintliga kontot ${email}`);
      return "planerad";
    }
    await auth.request("PUT", `/admin/users/${found.id}`, { body: { email_confirm: true } });
    ctx.log.ok(`Ägarens konto fanns; e-posten är nu bekräftad.`);
    return "bekräftad";
  }
  if (ctx.dryRun) {
    ctx.log.plan(`skapa kontot ${email} med bekräftad e-post (inget lösenord)`);
    return "planerad";
  }
  const { status, data } = await auth.request<{ code?: string; error_code?: string; msg?: string }>(
    "POST",
    "/admin/users",
    {
      body: { email, email_confirm: true, app_metadata: { binderlab_first_owner: true } },
      allow: [422],
    },
  );
  if (status === 422) {
    const code = data?.code ?? data?.error_code;
    if (code === "email_exists" || (!code && /already been registered/i.test(data?.msg ?? ""))) {
      // Skapades samtidigt (eller listan var ofullständig): räkna som klart.
      ctx.log.ok(`Ägarens konto finns redan.`);
      return "fanns";
    }
    throw new Error(
      `Supabase Auth: kontot ${email} kunde inte skapas (422${code ? ` ${code}` : ""}: ${ctx.log.redact(data?.msg ?? "okänt fel")}).`,
    );
  }
  ctx.log.ok(`Skapade ägarens konto ${email} (bekräftad e-post, inget lösenord).`);
  return "skapad";
}

export function ownerNextSteps(appUrl: string, email: string): string[] {
  return [
    `Öppna ${appUrl}/logga-in och skriv ${email}.`,
    `Tryck på "Skicka inloggningslänk" och öppna länken i mejlet i SAMMA webbläsare.`,
    `Första gången visas Kom igång (${appUrl}/kom-igang): skapa organisationen (du blir ägare), lägg upp datakällan och bjud in delägare under Inställningar → Användare.`,
    `Kontot har inget lösenord; logga in med länk varje gång.`,
  ];
}
