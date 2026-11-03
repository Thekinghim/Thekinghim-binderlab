/**
 * Läser det Supabase lämnar efter sig när någon öppnar en länk ur mejlet med
 * standardmallen (implicit flöde): `#access_token=…&refresh_token=…&type=…`,
 * eller ett fel (`#error=…&error_code=otp_expired`, ibland i frågesträngen).
 *
 * Fragmentet når aldrig servern av sig självt: sidan läser det här, tar bort
 * det ur adressfältet och skickar tokens med ett formulär (POST). Servern
 * verifierar åtkomsttoken innan något sparas. E-postadressen nedan läses ur
 * token utan verifiering och används BARA för att visa "Logga in som …".
 */

export type LinkFragment =
  | {
      kind: "tokens";
      accessToken: string;
      refreshToken: string;
      /** "magiclink", "invite", "recovery", "signup" … eller null. */
      type: string | null;
      email: string | null;
    }
  | { kind: "error"; code: string | null }
  | { kind: "none" };

function params(raw: string): URLSearchParams {
  return new URLSearchParams(raw.replace(/^[#?]/, ""));
}

/** E-post ur JWT:ns nyttolast (base64url), utan verifiering. Bara för visning. */
export function unverifiedEmail(jwt: string): string | null {
  const part = jwt.split(".")[1];
  if (!part) return null;
  try {
    const base64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const padded = base64 + "=".repeat((4 - (base64.length % 4)) % 4);
    const json = decodeURIComponent(
      Array.from(atob(padded), (c) => `%${c.charCodeAt(0).toString(16).padStart(2, "0")}`).join(""),
    );
    const email = (JSON.parse(json) as { email?: unknown }).email;
    return typeof email === "string" && email !== "" ? email : null;
  } catch {
    return null;
  }
}

export function parseLinkFragment(hash: string, search = ""): LinkFragment {
  const h = params(hash);
  const q = params(search);
  const error = h.get("error") ?? h.get("error_code") ?? q.get("error") ?? q.get("error_code");
  if (error) {
    return { kind: "error", code: h.get("error_code") ?? q.get("error_code") ?? error };
  }
  const accessToken = h.get("access_token");
  const refreshToken = h.get("refresh_token");
  if (accessToken && refreshToken) {
    return {
      kind: "tokens",
      accessToken,
      refreshToken,
      type: h.get("type"),
      email: unverifiedEmail(accessToken),
    };
  }
  return { kind: "none" };
}
