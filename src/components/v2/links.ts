/**
 * Länkar ut ur appen (V2): Ring och Google Maps. Inget skickas från servern; webbläsaren öppnar
 * länken när personen trycker. Ingen API-nyckel.
 */

/** "tel:" med bara siffror och +. null utan telefonnummer. */
export function telHref(phone: string | null | undefined): string | null {
  const digits = (phone ?? "").replace(/[^\d+]/g, "");
  return digits.length >= 5 ? `tel:${digits}` : null;
}

/** En plats i Google Maps (adress, eller koordinater när adress saknas). */
export function mapsSearchUrl(place: {
  readonly address?: string | null;
  readonly city?: string | null;
  readonly lat?: number | null;
  readonly lng?: number | null;
}): string | null {
  const text = [place.address, place.city].filter((p) => p && p.trim()).join(", ");
  const query = text || (place.lat != null && place.lng != null ? `${place.lat},${place.lng}` : "");
  if (!query) return null;
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}

/**
 * Hela rutten i Google Maps: start (lagret), stoppen i ordning och tillbaka. Google tar högst
 * 9 mellanstopp; fler kortas av (resten öppnas stopp för stopp). null utan stopp.
 */
export function mapsDirUrl(stops: ReadonlyArray<string>, origin?: string | null): string | null {
  const points = stops.map((s) => s.trim()).filter(Boolean);
  if (points.length === 0) return null;
  const start = origin?.trim() || null;
  const destination = start ?? points[points.length - 1]!;
  const waypoints = (start ? points : points.slice(0, -1)).slice(0, 9);
  const q = new URLSearchParams({ api: "1", destination, travelmode: "driving" });
  if (start) q.set("origin", start);
  if (waypoints.length) q.set("waypoints", waypoints.join("|"));
  return `https://www.google.com/maps/dir/?${q.toString()}`;
}
