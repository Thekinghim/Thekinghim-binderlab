/**
 * Proxy (Next 16:s efterföljare till middleware).
 *
 * Skickar oinloggade till /logga-in?next=… för skyddade sökvägar och förnyar
 * Supabase-sessionen. Öppna sökvägar: /logga-in, /inbjudan/*, /design*,
 * /datamodell, /rapport/* och statiska filer.
 *
 * Proxyn är BARA en bekvämlighet. Behörigheten kontrolleras alltid i
 * serverkoden (requireUser/requireRole och RLS), eftersom en matcher eller en
 * flyttad server action tyst kan hamna utanför proxyn.
 */

import { NextResponse, type NextRequest } from "next/server";

import { getServerEnv } from "@/lib/env";
import { LOGIN_PATH, isPublicPath, loginRedirectPath } from "@/server/auth/paths";
import { checkProxySession } from "@/server/auth/proxy-session";

let reportedEnvError = false;

export async function proxy(request: NextRequest): Promise<NextResponse> {
  const { pathname, search } = request.nextUrl;
  if (isPublicPath(pathname)) {
    return NextResponse.next();
  }

  let authenticated = false;
  let response = NextResponse.next();
  try {
    const result = await checkProxySession(request, getServerEnv(), (req) =>
      NextResponse.next({ request: req }),
    );
    authenticated = result.authenticated;
    response = result.response;
  } catch (error) {
    // Felaktig miljö eller otillgänglig auth-tjänst: behandla som utloggad.
    if (!reportedEnvError) {
      reportedEnvError = true;
      console.error("[proxy] Sessionen kunde inte kontrolleras:", error);
    }
  }

  if (authenticated) {
    return response;
  }

  const target = request.nextUrl.clone();
  const [path, query = ""] = loginRedirectPath(pathname, search).split("?");
  target.pathname = path ?? LOGIN_PATH;
  target.search = query ? `?${query}` : "";
  const redirect = NextResponse.redirect(target);
  // Bär med eventuella cookies som Supabase rensade eller förnyade.
  for (const cookie of response.cookies.getAll()) {
    redirect.cookies.set(cookie);
  }
  return redirect;
}

export const config = {
  matcher: [
    // Allt utom Next:s interna filer och vanliga statiska filer.
    "/((?!_next/static|_next/image|favicon\\.ico|icon\\.svg|apple-icon\\.png|robots\\.txt|sitemap\\.xml).*)",
  ],
};
