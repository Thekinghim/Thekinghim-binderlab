/**
 * Besöksplanen ut ur appen: vägbeskrivning i Google Maps och kalenderfil (.ics).
 *
 *   Google Maps = https://www.google.com/maps/dir/?api=1 med destination (sista stoppet)
 *                 och waypoints (stoppen före, i besöksordning). Ingen API-nyckel. Utan
 *                 origin startar Maps där telefonen är. Plats: koordinater om butiken har
 *                 dem, annars "adress, ort". Högst MAX_WAYPOINTS mellanstopp per länk;
 *                 fler stopp delas på flera länkar.
 *   Kalender    = en heldagshändelse per besöksdag (RFC 5545), med stoppen i ordning och
 *                 kartlänken i beskrivningen. UID är stabilt per organisation och dag, så
 *                 att en ny import uppdaterar händelsen i stället för att lägga en till.
 *
 * Rena funktioner utan I/O.
 */

import type { IsoDate } from "@/domain";

import type { GeoPoint } from "./route";

/** Ett stopp som det skickas till kartan och kalendern. */
export interface RouteStop {
  readonly machineId: string;
  /** T.ex. "BL‑001 Automat 1". */
  readonly label: string;
  readonly storeId: string | null;
  readonly storeName: string | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly location: GeoPoint | null;
  readonly packs: number;
}

/** Google tar emot högst 9 mellanstopp i en länk (utöver destinationen). */
export const MAX_WAYPOINTS = 9;

/** Det kartan söker på: koordinater, annars "adress, ort", annars null. */
export function mapsQuery(stop: Pick<RouteStop, "address" | "city" | "location">): string | null {
  if (stop.location) return `${round6(stop.location.lat)},${round6(stop.location.lng)}`;
  // "|" skiljer mellanstoppen i länken och får inte finnas i en adress.
  const address = stop.address?.replace(/\s*\|\s*/g, " ").trim();
  if (!address) return null;
  const city = stop.city?.replace(/\s*\|\s*/g, " ").trim();
  return city && !address.toLocaleLowerCase("sv").includes(city.toLocaleLowerCase("sv"))
    ? `${address}, ${city}`
    : address;
}

function round6(n: number): string {
  return String(Math.round(n * 1e6) / 1e6);
}

/** Stoppen som saknar både adress och plats (kartan kan inte hitta dem). */
export function stopsWithoutPlace(stops: readonly RouteStop[]): RouteStop[] {
  return stops.filter((s) => mapsQuery(s) === null);
}

function directionsUrl(queries: readonly string[], origin: string | null): string {
  const params = new URLSearchParams({ api: "1", travelmode: "driving" });
  if (origin) params.set("origin", origin);
  params.set("destination", queries[queries.length - 1] as string);
  if (queries.length > 1) params.set("waypoints", queries.slice(0, -1).join("|"));
  return `https://www.google.com/maps/dir/?${params.toString()}`;
}

/**
 * Länkarna för stoppen i ordning (stopp utan plats hoppas över). En länk tar upp till
 * MAX_WAYPOINTS + 1 stopp; nästa länk startar (origin) vid förra länkens sista stopp, så att
 * rutten hänger ihop. Tom lista = inga stopp med plats.
 */
export function googleMapsUrls(stops: readonly RouteStop[]): string[] {
  const queries = stops.map(mapsQuery).filter((q): q is string => q !== null);
  const per = MAX_WAYPOINTS + 1;
  const urls: string[] = [];
  for (let start = 0; start < queries.length; start += per) {
    const chunk = queries.slice(start, start + per);
    urls.push(directionsUrl(chunk, start === 0 ? null : (queries[start - 1] as string)));
  }
  return urls;
}

// ---------------------------------------------------------------------------
// Kalender
// ---------------------------------------------------------------------------

/** En besöksdag i kalendern. */
export interface CalendarDay {
  readonly date: IsoDate;
  /** T.ex. "Påfyllning: 3 besök, 46 pack". */
  readonly summary: string;
  readonly stops: readonly RouteStop[];
}

/** Texten escapad enligt RFC 5545 3.3.11. */
export function icsText(s: string): string {
  return s
    .replace(/\\/g, "\\\\")
    .replace(/;/g, "\\;")
    .replace(/,/g, "\\,")
    .replace(/\r?\n/g, "\\n");
}

/** Viker en rad till högst 75 oktetter (RFC 5545 3.1), utan att dela ett tecken. */
export function foldLine(line: string): string {
  const enc = new TextEncoder();
  if (enc.encode(line).length <= 75) return line;
  const out: string[] = [];
  let current = "";
  let bytes = 0;
  let limit = 75;
  for (const ch of line) {
    const n = enc.encode(ch).length;
    if (bytes + n > limit) {
      out.push(current);
      current = "";
      bytes = 0;
      limit = 74; // fortsättningsraden börjar med ett mellanslag
    }
    current += ch;
    bytes += n;
  }
  out.push(current);
  return out.join("\r\n ");
}

function compactDate(d: IsoDate): string {
  return d.replace(/-/g, "");
}

function nextDay(d: IsoDate): IsoDate {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + 1);
  return t.toISOString().slice(0, 10) as IsoDate;
}

function stamp(now: Date): string {
  return now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

/** Beskrivningen: stoppen i ordning med adress och pack, sedan kartlänken. */
export function dayDescription(day: CalendarDay): string {
  const lines = day.stops.map((s, i) => {
    const where = [s.storeName, mapsQuery({ ...s, location: null })].filter(Boolean).join(", ");
    return `${i + 1}. ${s.label}${where ? ` – ${where}` : ""} (${s.packs} pack)`;
  });
  const urls = googleMapsUrls(day.stops);
  urls.forEach((u, i) => lines.push(urls.length > 1 ? `Karta ${i + 1}: ${u}` : `Karta: ${u}`));
  return lines.join("\n");
}

/**
 * Kalenderfilen för dagarna. `uidBase` (t.ex. organisationens id) gör UID stabilt per dag.
 */
export function visitIcs(days: readonly CalendarDay[], uidBase: string, now: Date): string {
  const lines = [
    "BEGIN:VCALENDAR",
    "VERSION:2.0",
    "PRODID:-//Binderlab//Besöksplan//SV",
    "CALSCALE:GREGORIAN",
    "METHOD:PUBLISH",
  ];
  for (const day of days) {
    const first = day.stops.find((s) => mapsQuery(s) !== null);
    const location = first ? [first.storeName, mapsQuery({ ...first, location: null })] : [];
    lines.push(
      "BEGIN:VEVENT",
      `UID:besok-${compactDate(day.date)}-${uidBase}@binderlab`,
      `DTSTAMP:${stamp(now)}`,
      `DTSTART;VALUE=DATE:${compactDate(day.date)}`,
      `DTEND;VALUE=DATE:${compactDate(nextDay(day.date))}`,
      `SUMMARY:${icsText(day.summary)}`,
      `DESCRIPTION:${icsText(dayDescription(day))}`,
    );
    const loc = location.filter(Boolean).join(", ");
    if (loc) lines.push(`LOCATION:${icsText(loc)}`);
    lines.push("TRANSP:TRANSPARENT", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  return `${lines.map(foldLine).join("\r\n")}\r\n`;
}

// ---------------------------------------------------------------------------
// Plats ur en kartlänk eller koordinater
// ---------------------------------------------------------------------------

function point(lat: number, lng: number): GeoPoint | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  return { lat, lng };
}

/**
 * Plats ur det man klistrar in: "55.7047, 13.1910", en Google Maps-länk med "@lat,lng",
 * "!3dlat!4dlng" eller "q=lat,lng"/"ll=lat,lng". Tomt = null (ingen plats). Ogiltigt =
 * undefined.
 */
export function parseLocation(raw: string | null | undefined): GeoPoint | null | undefined {
  const s = (raw ?? "").trim();
  if (s === "") return null;
  const num = "(-?\\d{1,3}(?:\\.\\d+)?)";
  const patterns = [
    new RegExp(`!3d${num}!4d${num}`),
    new RegExp(`@${num},${num}`),
    new RegExp(`[?&](?:q|ll|query|destination)=${num}(?:,|%2C)\\s*${num}`, "i"),
    new RegExp(`^${num}\\s*[,;\\s]\\s*${num}$`),
  ];
  for (const re of patterns) {
    const m = re.exec(s);
    if (m) {
      const p = point(Number(m[1]), Number(m[2]));
      if (p) return p;
    }
  }
  return undefined;
}
