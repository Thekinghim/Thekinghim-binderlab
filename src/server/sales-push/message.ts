/**
 * Notisen vid varje försäljning: texten och adresserna (rena funktioner, testas i
 * message.test.ts). Jobbet (./job.ts) läser orderna och skickar.
 *
 * - Ett köp: "Sålt: <titel>" och "<automat> · <butik> · <belopp> · <tid>", med packbilden som
 *   ikon (absolut adress till /packs/<nyckel>.webp, annars appens ikon).
 * - Flera köp i samma synk: "3 sålda · 447 kr" och upp till tre titlar, "och 2 till".
 * - Fler än SALE_PUSH_CAP: en sammanfattning ("24 sålda · 3 580 kr"), aldrig en lista.
 * - Utan kronor (påfyllaren, som på Hem: bara vad som såldes): samma notiser utan belopp.
 *
 * Notisen öppnar Hem med I dag (i Enkel vy startsidan, Försäljning).
 */

import { formatKronor } from "@/lib/format";
import { packImageSrc } from "@/lib/pack-image";
import type { PushPayload } from "@/server/notify/push";

/** Fler nya köp än så i en synk blir en enda sammanfattning. */
export const SALE_PUSH_CAP = 20;
/** Så många titlar räknas upp i en grupperad notis. */
export const SALE_PUSH_LIST = 3;
/** Appens ikon när titeln saknar packbild. */
export const APP_ICON = "/icons/icon-192.png";

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
  /** Appens adress utan snedstreck på slutet, eller null (då relativa adresser). */
  readonly baseUrl: string | null;
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

/** 14:32, eller "i går 23:58" när köpet var en annan dag. */
export function saleTime(iso: string, timeZone: string, now: Date): string {
  const d = new Date(iso);
  const clock = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
  if (dayKey(d, timeZone) === dayKey(now, timeZone)) return clock;
  const yesterday = new Date(now.getTime() - 24 * 3600_000);
  return dayKey(d, timeZone) === dayKey(yesterday, timeZone) ? `i går ${clock}` : clock;
}

function absolute(path: string, baseUrl: string | null): string {
  return baseUrl ? `${baseUrl}${path}` : path;
}

/** Sidan som notisen öppnar: Hem med I dag (Enkel vy: startsidan). */
export function saleHref(simple = false): string {
  return simple ? "/" : "/?period=idag";
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
  const url = saleHref(options.simple);
  const ordered = [...sales].sort((a, b) => a.orderedAt.localeCompare(b.orderedAt));
  const last = ordered[ordered.length - 1]!;
  // En ny notis staplas (egen tagg per utskick); samma utskick som provas igen ersätter sig själv.
  const tag = `salj-${last.orderId.slice(0, 8)}`;
  const total = ordered.reduce((sum, s) => sum + s.amountOre, 0);

  if (ordered.length === 1) {
    const s = last;
    const image = packImageSrc(s.title);
    const body = [
      s.machineName,
      s.storeName,
      options.kronor ? kronor(s.amountOre) : null,
      saleTime(s.orderedAt, options.timeZone, options.now),
    ]
      .filter((p): p is string => Boolean(p && p.trim()))
      .join(" · ");
    return {
      title: clip(`Sålt: ${s.title}`, 120),
      body: clip(body, 240),
      url,
      tag,
      severity: "info",
      lang: "sv",
      icon: absolute(image ?? APP_ICON, options.baseUrl),
      ...(image ? { image: absolute(image, options.baseUrl) } : {}),
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
    const names = shown.map(([name, n]) => (n > 1 ? `${n} × ${name}` : name));
    body = `${names.join(", ")}${rest > 0 ? ` och ${rest} till` : ""}`;
  }
  return {
    title,
    body: clip(body, 240),
    url,
    tag,
    severity: "info",
    lang: "sv",
    icon: absolute(APP_ICON, options.baseUrl),
  };
}

/** Tyst 22–07 i organisationens tidszon. */
export function inQuietHours(now: Date, timeZone: string): boolean {
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", hourCycle: "h23" }).format(now),
  );
  return hour >= 22 || hour < 7;
}
