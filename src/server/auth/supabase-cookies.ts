/**
 * Flaggor för Supabase-sessionens cookies. @supabase/ssr sätter som standard
 * httpOnly=false (för createBrowserClient) och ingen Secure. Appen läser
 * sessionen bara på servern, så cookien kan vara httpOnly: en XSS kan då inte
 * läsa refresh-token.
 */
export function supabaseCookieOptions(secure: boolean) {
  return { httpOnly: true, secure, sameSite: "lax" as const, path: "/" };
}
