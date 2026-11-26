/**
 * Länkar ut ur appen (V2): Ring och kartan (Apple Kartor på iPhone och iPad, annars Google Maps).
 * Inget skickas från servern; webbläsaren öppnar länken när personen trycker. Ingen API-nyckel.
 */

/** Kartappen länken öppnar. */
export type MapsProvider = "google" | "apple";

/**
 * iPhone, iPad eller iPod (även iPad som säger att den är en Mac): där öppnar maps.apple.com
 * appen Kartor direkt, också från appen på hemskärmen. Det finns ingen mediefråga för vilken
 * kartapp telefonen har, så här läses webbläsarens plattform.
 */
export function isAppleMobile(nav: {
  readonly userAgent?: string;
  readonly platform?: string;
  readonly maxTouchPoints?: number;
}): boolean {
  const ua = nav.userAgent ?? "";
  if (/iPhone|iPad|iPod/.test(ua)) return true;
  return /Mac/.test(nav.platform ?? ua) && (nav.maxTouchPoints ?? 0) > 1;
}

/** "tel:" med bara siffror och +. null utan telefonnummer. */
export function telHref(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/[^\d+]/g, "");
  return digits.length >= 5 ? `tel:${digits}` : null;
}

/**
 * En plats i kartan (adress, eller koordinater när adress saknas). Google: platsen. Apple:
 * vägen dit med bil från där man står (knappen heter "Kör dit").
 */
export function mapsSearchUrl(
  place: {
    readonly address?: string | null;
    readonly city?: string | null;
    readonly lat?: number | null;
    readonly lng?: number | null;
  },
  provider: MapsProvider = "google",
): string | null {
  const text = [place.address, place.city].filter((p) => p && p.trim()).join(", ");
  const query = text || (place.lat != null && place.lng != null ? `${place.lat},${place.lng}` : "");
  if (!query) return null;
  if (provider === "apple") return appleDirUrl(query);
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

function appleDirUrl(destination: string, origin?: string | null): string {
  const q = new URLSearchParams({ daddr: destination, dirflg: "d" });
  if (origin) q.set("saddr", origin);
  return `https://maps.apple.com/?${q.toString()}`;
}

/**
 * Hela rutten i Google Maps: start (lagret), stoppen i ordning och tillbaka. Google tar högst
 * 9 mellanstopp; fler kortas av (resten öppnas stopp för stopp). null utan stopp.
 *
 * Apple Kartor tar inga mellanstopp i en länk: med Apple och ett enda stopp (utan start)
 * öppnas Kartor, annars Google Maps (som klarar hela rutten).
 */
export function mapsDirUrl(
  stops: ReadonlyArray<string>,
  origin?: string | null,
  provider: MapsProvider = "google",
): string | null {
  const points = stops.map((s) => s.trim()).filter(Boolean);
  if (points.length === 0) return null;
  const start = origin?.trim() || null;
  if (provider === "apple" && points.length === 1 && !start) return appleDirUrl(points[0]!);
  const destination = start ?? points[points.length - 1]!;
  const waypoints = (start ? points : points.slice(0, -1)).slice(0, 9);
  const q = new URLSearchParams({ api: "1", destination, travelmode: "driving" });
  if (start) q.set("origin", start);
  if (waypoints.length) q.set("waypoints", waypoints.join("|"));
  return `https://www.google.com/maps/dir/?${q.toString()}`;
}
