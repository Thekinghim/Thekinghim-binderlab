/**
 * Tillåtna push-tjänster. Servern gör en POST till prenumerationens endpoint (larmjobbet och
 * provlarmet), så en godtycklig https-adress skulle låta en användare få servern att anropa
 * interna adresser (SSRF). Bara webbläsarnas egna push-tjänster godtas:
 *
 * - Chrome, Edge (Chromium), Samsung, Opera: fcm.googleapis.com
 * - Firefox: *.push.services.mozilla.com
 * - Safari (macOS, iOS 16.4+): *.push.apple.com
 * - Edge (äldre), Windows: *.notify.windows.com
 *
 * Samma regel finns i databasen (private.push_endpoint_allowed) som check på
 * push_subscriptions.endpoint.
 */

const HOSTS: readonly RegExp[] = [
  /^fcm\.googleapis\.com$/,
  /^([a-z0-9-]+\.)*push\.services\.mozilla\.com$/,
  /^([a-z0-9-]+\.)*push\.apple\.com$/,
  /^([a-z0-9-]+\.)*notify\.windows\.com$/,
];

/** Sant när adressen är https till en känd push-tjänst (standardport, inga inloggningsuppgifter). */
export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (endpoint.length > 2000 || /\s/.test(endpoint)) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:") return false;
  if (url.username || url.password) return false;
  if (url.port !== "" && url.port !== "443") return false;
  const host = url.hostname.toLowerCase();
  return HOSTS.some((re) => re.test(host));
}
