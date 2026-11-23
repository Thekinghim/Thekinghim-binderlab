/**
 * Notisen vid varje försäljning: texten och adresserna (rena funktioner, testas i
 * message.test.ts). Jobbet (./job.ts) läser orderna och skickar.
 *
 * - Ett köp: "Sålt: <titel>" och "<automat> · <butik> · <belopp> · <tid>", med packbilden som
 *   ikon (/packs/<nyckel>.webp; utan packbild service workerns appikon). Adresserna är
 *   relativa: service workern gör dem absoluta mot sin egen adress, alltså den adress som
 *   personen har installerat (inte cronens). iPhone visar alltid appens ikon.
 * - Flera köp i samma synk: "3 sålda · 447 kr" och upp till tre titlar (var och en kortad,
 *   så att "och 2 till" syns på en låst iPhone).
 * - Fler än SALE_PUSH_CAP: en sammanfattning ("24 sålda · 3 580 kr"), aldrig en lista.
 * - Utan kronor: "Sålt: <titel>" och bara automaten (ingen butik, ingen tid, inget belopp).
 *   Ingen roll får den i dag (jobbet skickar bara till ekonomirollerna), men byggaren tål det.
 * - En tagg per organisation och dag: en ny notis ersätter den förra på låsskärmen i stället
 *   för att lägga sig i en hög (Hem visar hela dagen).
 * - Personen med flera organisationer: organisationens namn sist i texten.
 *
 * Notisen öppnar Hem med I dag, eller I går när det nyaste köpet var i går (Enkel vy:
 * startsidan, Försäljning). Alltid på svenska (som appen; bara veckosammanfattningen och Enkel
 * vy finns på engelska).
 */

import { formatKronor } from "@/lib/format";
import { packImageSrc } from "@/lib/pack-image";
import type { PushPayload } from "@/server/notify/push";

/** Fler nya köp än så i en synk blir en enda sammanfattning. */
export const SALE_PUSH_CAP = 20;
/** Så många titlar räknas upp i en grupperad notis. */
export const SALE_PUSH_LIST = 3;
/** Så lång blir varje titel i en grupperad notis (låst iPhone: ungefär två rader). */
export const SALE_PUSH_TITLE_MAX = 28;

export interface SaleItem {
  readonly orderId: string;
  readonly title: string;
  readonly machineName: string | null;
  readonly storeName: string | null;
  readonly amountOre: number;
  /** ISO 8601. */
  readonly orderedAt: string;
}

export interface SalePushOptions {
  /** Belopp med: bara roller som får se ekonomi (ECONOMY_ROLES). */
  readonly kronor: boolean;
  readonly timeZone: string;
  /** Organisationens namn när personen har flera organisationer (annars utelämnat). */
  readonly orgName?: string | null;
  /** Organisationens id (för taggen: en notis per organisation och dag). */
  readonly orgId?: string;
  /** Enkel vy: startsidan är Försäljning, inte Hem med perioder. */
  readonly simple?: boolean;
  /** Nu (för "i går"). */
  readonly now: Date;
}

function kronor(ore: number): string {
  return formatKronor(ore / 100, { decimals: ore % 100 === 0 ? 0 : 2 });
}

function dayKey(d: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

/** Kalenderdagen före "2027-03-29" (via kalenderfälten, säkert över sommartidsskiftet). */
function previousDayKey(key: string): string {
  const [y, m, d] = key.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d - 1)).toISOString().slice(0, 10);
}

/** Köpets dag i förhållande till nu, i organisationens tidszon. */
function relativeDay(iso: string, timeZone: string, now: Date): "today" | "yesterday" | "other" {
  const day = dayKey(new Date(iso), timeZone);
  const today = dayKey(now, timeZone);
  if (day === today) return "today";
  return day === previousDayKey(today) ? "yesterday" : "other";
}

/** 14:32, eller "i går 23:58" när köpet var i går. */
export function saleTime(iso: string, timeZone: string, now: Date): string {
  const clock = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
  return relativeDay(iso, timeZone, now) === "yesterday" ? `i går ${clock}` : clock;
}

/** Sidan som notisen öppnar: Hem med I dag eller I går (Enkel vy: startsidan). */
export function saleHref(simple = false, day: "idag" | "igar" = "idag"): string {
  return simple ? "/" : `/?period=${day}`;
}

function clip(text: string, max: number): string {
  const t = text.replace(/[ \t\r\n]+/g, " ").trim();
  return t.length <= max ? t : `${t.slice(0, max - 1).trimEnd()}…`;
}

function soldCount(n: number): string {
  return `${n} ${n === 1 ? "såld" : "sålda"}`;
}

/** Notisen för köpen (nyast sist i listan). Kastar för en tom lista. */
export function salePushPayload(sales: readonly SaleItem[], options: SalePushOptions): PushPayload {
  if (sales.length === 0) throw new RangeError("salePushPayload: inga köp.");
  const ordered = [...sales].sort((a, b) => a.orderedAt.localeCompare(b.orderedAt));
  const last = ordered[ordered.length - 1]!;
  // Strax efter midnatt: köpen från i går syns under I går, inte under I dag.
  const url = saleHref(
    options.simple,
    relativeDay(last.orderedAt, options.timeZone, options.now) === "yesterday" ? "igar" : "idag",
  );
  // En tagg per organisation och dag: den nya notisen ersätter den förra (ingen hög).
  const day = dayKey(new Date(last.orderedAt), options.timeZone).replaceAll("-", "");
  const tag = `salj-${options.orgId ? `${options.orgId.slice(0, 8)}-` : ""}${day}`;
  const total = ordered.reduce((sum, s) => sum + s.amountOre, 0);
  const org = options.orgName?.trim() ? clip(options.orgName, 40) : null;
  const withOrg = (body: string) => (org ? (body ? `${body} · ${org}` : org) : body);

  if (ordered.length === 1) {
    const s = last;
    const image = packImageSrc(s.title);
    // Utan kronor bara automaten: ingen butik och ingen tid (inte mer än det som syns på Hem).
    const parts = options.kronor
      ? [
          s.machineName,
          s.storeName,
          kronor(s.amountOre),
          saleTime(s.orderedAt, options.timeZone, options.now),
        ]
      : [s.machineName];
    const body = parts.filter((p): p is string => Boolean(p && p.trim())).join(" · ");
    return {
      title: clip(`Sålt: ${s.title}`, 120),
      body: clip(withOrg(body), 240),
      url,
      tag,
      severity: "info",
      lang: "sv",
      // Bara ikonen: Android visar `image` som en bred banderoll (packen skulle beskäras).
      ...(image ? { icon: image } : {}),
    };
  }

  const title = options.kronor
    ? `${soldCount(ordered.length)} · ${kronor(total)}`
    : soldCount(ordered.length);
  const since = saleTime(ordered[0]!.orderedAt, options.timeZone, options.now);
  let body: string;
  if (ordered.length > SALE_PUSH_CAP) {
    body = `Sedan ${since}. Öppna Hem för listan.`;
  } else {
    // Nyast först, samma titel en gång med antal.
    const counts = new Map<string, number>();
    for (const s of [...ordered].reverse()) counts.set(s.title, (counts.get(s.title) ?? 0) + 1);
    const shown = [...counts].slice(0, SALE_PUSH_LIST);
    const rest = ordered.length - shown.reduce((sum, [, n]) => sum + n, 0);
    const names = shown.map(([name, n]) => {
      const short = clip(name, SALE_PUSH_TITLE_MAX);
      return n > 1 ? `${n} × ${short}` : short;
    });
    body = `${names.join(", ")}${rest > 0 ? ` och ${rest} till` : ""}`;
  }
  return { title, body: clip(withOrg(body), 240), url, tag, severity: "info", lang: "sv" };
}

/** Tyst 22–07 i organisationens tidszon. */
export function inQuietHours(now: Date, timeZone: string): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now),
  );
  return hour >= 22 || hour < 7;
}
