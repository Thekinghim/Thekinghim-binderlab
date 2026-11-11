/**
 * Innehållet i ett larmutskick, per kanal: push (kort), e-post (ämne, HTML och text) och sms.
 * Rent och utan I/O, så att det kan testas. Samma uppgifter i alla kanaler: vad, var, när,
 * underlaget (regeln) och länken till sidan som förklarar siffran.
 *
 * E-posten följer reglerna i docs/design.md avsnitt 8: alltid ljus, inline-stilar, inga
 * klasser, inga bilder eller svg, under 100 kB. Signalen bara på det som kräver åtgärd
 * (kritiska larm), alltid med text bredvid.
 */

import type { AlertDelivery, AlertNotification, AlertSeverity } from "@/analytics/alerts";
import { whenText } from "@/analytics/health";
import { EMAIL_COLOR, EMAIL_FONT, EMAIL_WIDTH } from "@/emails/theme";
import { sentence, weekdayName } from "@/analytics/todos/text";
import { addDays, dayOfWeek, type IsoDate } from "@/domain";
import { formatInt, NBSP } from "@/lib/format";

import type { PushPayload } from "./push";
import { SMS_MAX_LENGTH } from "./sms";

export const SEVERITY_LABEL: Record<AlertSeverity, string> = {
  critical: "Kritisk",
  warning: "Varning",
  info: "Info",
};

const REASON_LABEL: Record<AlertNotification["reason"], string> = {
  new: "Nytt",
  reminder: "Påminnelse",
  escalated: "Allvarligare",
  reopened: "Tillbaka",
  resolved: "Löst",
};

/** Absolut länk till en sökväg i appen (larmens länkar är alltid lokala sökvägar). */
export function absoluteLink(baseUrl: string, link: string): string {
  const path = link.startsWith("/") && !link.startsWith("//") ? link : "/drift";
  return `${baseUrl.replace(/\/+$/, "")}${path}`;
}

function worst(items: readonly AlertNotification[]): AlertSeverity {
  if (items.some((i) => i.severity === "critical" && i.reason !== "resolved")) return "critical";
  if (items.some((i) => i.severity === "warning" && i.reason !== "resolved")) return "warning";
  return "info";
}

/** Push: en notis per utskick. Fler larm än ett sammanfattas i texten. */
export function pushPayload(delivery: AlertDelivery): PushPayload {
  const first = delivery.items[0];
  const more = delivery.items.length - 1;
  const body = first
    ? `${first.detail}${more > 0 ? ` Och ${formatInt(more)}${NBSP}larm till.` : ""}`
    : "";
  return {
    title: delivery.subject,
    body: body.length > 240 ? `${body.slice(0, 239)}…` : body,
    url: delivery.items.length === 1 && first ? first.link : "/drift#larm",
    tag: delivery.items.length === 1 && first ? first.key : `larm-${delivery.sendAt}`,
    severity: worst(delivery.items),
  };
}

// ---------------------------------------------------------------------------
// Push om påfyllning: en notis per automat
// ---------------------------------------------------------------------------

/** Automatens läge just nu: öppna lagerlarm (inte bara de som är nya i utskicket). */
export interface PushMachineOpen {
  /** Titlar som är slut. */
  readonly empty: number;
  /** Titlar som tar slut snart. */
  readonly soon: number;
  /** Dagarna då titlarna i `soon` tar slut (en per titel, om känd). */
  readonly soonDates: readonly IsoDate[];
}

export interface PushMachine {
  /** Automatens namn som i resten av panelen, t.ex. "BL-003 Sega gubben". */
  readonly name: string;
  /** Kort namn i listan över flera automater, t.ex. "BL-003". Saknas den används `name`. */
  readonly short?: string;
  /** Namnet som står i larmens rubriker ("… är slut i <namn>"), om det skiljer sig. */
  readonly alertName?: string;
  /** Butiken den står i, om någon. */
  readonly store: string | null;
  /** Saknas den räknas notisen på larmen i utskicket. */
  readonly open?: PushMachineOpen;
}

/** Det push-notisen behöver utöver utskicket. Utan det blir notisen som förut. */
export interface PushContext {
  readonly machines?: ReadonlyMap<string, PushMachine>;
  /** Dagens datum i organisationens tidszon ("i dag", "i morgon"). */
  readonly today?: IsoDate;
  /**
   * Mottagarens språk (profilen). Notisen om påfyllning skrivs på engelska för den som har
   * engelska (delägaren i enkla vyn); övriga larm är på svenska som förut.
   */
  readonly lang?: "sv" | "en";
}

const WEEKDAYS_EN = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"];

/** Sidan med veckans besök: dit går notisen när flera automater behöver fyllas på. */
export const VISIT_PLAN_LINK = "/drift/besok";

/** Länken till Fyll på för en automat. */
export function fillLink(machineId: string): string {
  return `/fyll-pa/${machineId}`;
}

/** Samma tagg per automat: en ny notis om automaten ersätter den gamla. */
export function fillTag(machineId: string): string {
  return `fyll-${machineId}`;
}

function isRefill(n: AlertNotification): n is AlertNotification & { machineId: string } {
  return n.kind === "low_stock" && n.reason !== "resolved" && n.machineId !== null;
}

/** "BL-003 Sega gubben". Butiken skrivs inte två gånger om den redan står i namnet. */
export function machineLabel(m: PushMachine | undefined, fallback: string): string {
  if (!m) return fallback;
  const store = m.store?.trim() ?? "";
  if (store === "" || m.name.toLocaleLowerCase("sv").includes(store.toLocaleLowerCase("sv"))) {
    return m.name;
  }
  return `${m.name} ${store}`;
}

/** "i dag", "i morgon", "på lördag" eller "snart" (okänd dag, eller olika dagar). */
function soonWord(
  dates: readonly IsoDate[],
  count: number,
  today: IsoDate | undefined,
  en: boolean,
): string {
  const first = dates[0];
  const soon = en ? "soon" : "snart";
  if (!today || first === undefined || dates.length < count) return soon;
  if (dates.some((d) => d !== first)) return soon;
  if (first <= today) return en ? "today" : "i dag";
  if (first === addDays(today, 1)) return en ? "tomorrow" : "i morgon";
  return en
    ? `on ${WEEKDAYS_EN[dayOfWeek(first) - 1] ?? ""}`
    : `på ${weekdayName(dayOfWeek(first))}`;
}

interface RefillMachine {
  readonly machineId: string;
  readonly label: string;
  readonly empty: number;
  readonly soon: number;
  readonly soonDates: readonly IsoDate[];
  readonly items: readonly AlertNotification[];
}

function refillMachines(
  items: readonly (AlertNotification & { machineId: string })[],
  ctx: PushContext,
): RefillMachine[] {
  const byMachine = new Map<string, AlertNotification[]>();
  for (const n of items) {
    const list = byMachine.get(n.machineId);
    if (list) list.push(n);
    else byMachine.set(n.machineId, [n]);
  }
  const out: RefillMachine[] = [];
  for (const [machineId, list] of byMachine) {
    const m = ctx.machines?.get(machineId);
    const own: PushMachineOpen = {
      empty: list.filter((n) => n.severity === "critical").length,
      soon: list.filter((n) => n.severity !== "critical").length,
      soonDates: list
        .filter((n) => n.severity !== "critical")
        .flatMap((n) => (n.evidence.dates?.[0] ? [n.evidence.dates[0]] : [])),
    };
    // Läget i databasen kan ha hunnit ändras (påfyllt sedan larmet köades): aldrig färre än
    // det utskicket själv säger, så att notisen inte blir tom.
    const open = m?.open && m.open.empty + m.open.soon >= list.length ? m.open : own;
    out.push({
      machineId,
      label: machineLabel(m, list[0]?.title ?? "Automaten"),
      empty: open.empty,
      soon: open.soon,
      soonDates: open.soonDates,
      items: list,
    });
  }
  // Värst först: flest slut, sedan flest titlar, sedan namnet.
  return out.sort(
    (a, b) =>
      b.empty - a.empty ||
      b.empty + b.soon - (a.empty + a.soon) ||
      a.label.localeCompare(b.label, "sv"),
  );
}

/** "3 slut, 2 tar slut i morgon" ("3 empty, 2 run out tomorrow"). */
function countsText(m: RefillMachine, today: IsoDate | undefined, en: boolean): string {
  const parts: string[] = [];
  if (m.empty > 0) parts.push(`${formatInt(m.empty)}${NBSP}${en ? "empty" : "slut"}`);
  if (m.soon > 0) {
    const when = soonWord(m.soonDates, m.soon, today, en);
    parts.push(
      en
        ? `${formatInt(m.soon)}${NBSP}${m.soon === 1 ? "runs" : "run"} out ${when}`
        : `${formatInt(m.soon)}${NBSP}tar slut ${when}`,
    );
  }
  return parts.join(", ");
}

/**
 * Notisen om påfyllning, eller null när utskicket inte har några lagerlarm.
 *   en automat:    "BL-003 Sega gubben" · "3 slut, 2 tar slut i morgon. Tryck för att fylla på."
 *                  → /fyll-pa/<automat>, samma tagg per automat (en ny ersätter den gamla)
 *   flera:         "3 automater behöver fyllas på" · "BL-003 (5), BL-007 (2), BL-001 (1)"
 *                  → besöksplanen, värst först
 * Med `ctx.lang` "en": "3 empty, 2 run out tomorrow. Tap to refill." och
 * "3 machines need refilling".
 */
export function refillPush(delivery: AlertDelivery, ctx: PushContext = {}): PushPayload | null {
  const machines = refillMachines(delivery.items.filter(isRefill), ctx);
  const first = machines[0];
  if (!first) return null;
  const severity = machines.some((m) => m.empty > 0) ? "critical" : "warning";
  const en = ctx.lang === "en";
  const lang = en ? { lang: "en" as const } : {};
  if (machines.length === 1) {
    // På engelska alltid antal: larmets rubrik (med titelns namn) finns bara på svenska.
    const only = !en && first.empty + first.soon === 1 ? first.items[0] : undefined;
    // En enda titel: säg vilken. Automatens namn står redan i rubriken.
    const m = ctx.machines?.get(first.machineId);
    // Längst namn först, så att "i BL-003 Sega gubben" inte lämnar kvar "BL-003".
    const names = [m?.name, m?.alertName]
      .filter((n): n is string => typeof n === "string" && n !== "")
      .sort((x, y) => y.length - x.length);
    const what = only
      ? sentence(names.reduce((t, n) => t.replace(` i ${n}`, ""), only.title))
      : sentence(countsText(first, ctx.today, en));
    return {
      title: first.label,
      body: `${what} ${en ? "Tap to refill." : "Tryck för att fylla på."}`,
      url: fillLink(first.machineId),
      tag: fillTag(first.machineId),
      severity,
      ...lang,
    };
  }
  const body = machines
    .map((m) => {
      const known = ctx.machines?.get(m.machineId);
      return `${known?.short ?? known?.name ?? m.label} (${formatInt(m.empty + m.soon)})`;
    })
    .join(", ");
  return {
    title: en
      ? `${formatInt(machines.length)}${NBSP}machines need refilling`
      : `${formatInt(machines.length)}${NBSP}automater behöver fyllas på`,
    body: body.length > 240 ? `${body.slice(0, 239)}…` : body,
    url: VISIT_PLAN_LINK,
    tag: "fyll-flera",
    severity,
    ...lang,
  };
}

/**
 * Alla push-notiser för ett utskick: en om påfyllning (per automat, se refillPush) och en
 * för övriga larm (som förut). Högst två.
 */
export function pushPayloads(delivery: AlertDelivery, ctx: PushContext = {}): PushPayload[] {
  const refill = refillPush(delivery, ctx);
  if (!refill) return [pushPayload(delivery)];
  const rest = delivery.items.filter((n) => !isRefill(n));
  if (rest.length === 0) return [refill];
  const first = rest[0];
  const subject =
    rest.length > 1 && first ? `${rest.length} larm: ${first.title} med flera` : (first?.title ?? "");
  return [refill, pushPayload({ ...delivery, items: rest, subject })];
}

// ---------------------------------------------------------------------------
// Push om butikens felanmälan
// ---------------------------------------------------------------------------

export interface FaultPushInput {
  readonly incidentId: string;
  readonly machineId: string;
  /** Butikens namn, eller automatens när den inte står i någon butik. */
  readonly place: string;
  /** Vad som är fel, t.ex. "Betalningen fungerar inte" (FAULT_LABEL). */
  readonly fault: string;
  /** Butikens telefonnummer, om det finns. */
  readonly phone: string | null;
  /**
   * Får mottagaren öppna ärendet i Inkorgen (ägare och admin)? Påfyllaren får det inte:
   * den får numret i texten och länken till automaten i Fyll på.
   */
  readonly canOpenCase: boolean;
}

/** Länken till ärendet i Inkorgen. */
export function caseLink(incidentId: string): string {
  return `/inkorg/${incidentId}`;
}

/**
 * Notisen när butiken felanmäler en automat:
 *   ägare/admin: "Sega gubben: Betalningen fungerar inte" · "Tryck för att ringa butiken."
 *                → ärendet i Inkorgen (där numret är en länk som ringer)
 *   utan nummer: "Tryck för att öppna ärendet."
 *   påfyllaren:  "Ring butiken: 040-12 34 56." → Fyll på för automaten
 */
export function faultPush(input: FaultPushInput): PushPayload {
  const phone = input.phone?.trim() ?? "";
  const body = input.canOpenCase
    ? phone !== ""
      ? "Butiken har felanmält automaten. Tryck för att ringa butiken."
      : "Butiken har felanmält automaten. Tryck för att öppna ärendet."
    : phone !== ""
      ? `Butiken har felanmält automaten. Ring butiken: ${phone}.`
      : "Butiken har felanmält automaten. Säg till ägaren.";
  const title = `${input.place}: ${input.fault}`;
  return {
    title: title.length > 120 ? `${title.slice(0, 119)}…` : title,
    body,
    url: input.canOpenCase ? caseLink(input.incidentId) : fillLink(input.machineId),
    tag: `fel-${input.incidentId}`,
    severity: "critical",
  };
}

/** Sms: ämnet, första larmets text och länken. Högst tre sms-delar. */
export function smsText(delivery: AlertDelivery, baseUrl: string): string {
  const first = delivery.items[0];
  const parts = [
    `Binderlab: ${sentence(delivery.subject)}`,
    first ? first.detail : "",
    absoluteLink(baseUrl, delivery.items.length === 1 && first ? first.link : "/drift"),
  ].filter(Boolean);
  const text = parts.join(" ");
  return text.length > SMS_MAX_LENGTH ? `${text.slice(0, SMS_MAX_LENGTH - 1)}…` : text;
}

function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function style(s: Record<string, string | number>): string {
  return Object.entries(s)
    .map(([k, v]) => `${k.replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}:${v}`)
    .join(";");
}

const label = style({
  fontFamily: EMAIL_FONT.mono,
  fontSize: "11px",
  lineHeight: "16px",
  letterSpacing: "0.08em",
  textTransform: "uppercase",
  color: EMAIL_COLOR.subtle,
});

export interface AlertEmail {
  readonly subject: string;
  readonly preheader: string;
  readonly html: string;
  readonly text: string;
}

/** E-post för ett utskick: en rad per larm med allvar, text, underlag och länk. */
export function alertEmail(
  delivery: AlertDelivery,
  options: { baseUrl: string; timeZone: string; organizationName: string },
): AlertEmail {
  const when = whenText(Date.parse(delivery.sendAt), options.timeZone);
  const preheader = delivery.items[0]?.detail ?? delivery.subject;
  const rows = delivery.items
    .map((n, i) => {
      const critical = n.severity === "critical" && n.reason !== "resolved";
      const marker = critical
        ? `<span style="${style({ display: "inline-block", width: "8px", height: "8px", background: EMAIL_COLOR.signal, marginRight: "6px" })}"></span>`
        : "";
      const tag = `${critical ? "Kräver åtgärd · " : ""}${SEVERITY_LABEL[n.severity]} · ${REASON_LABEL[n.reason]}`;
      return `<tr><td style="${style({ padding: "16px 0", borderTop: i === 0 ? "0" : `1px solid ${EMAIL_COLOR.line}` })}">
<div style="${label}">${marker}${esc(tag)}</div>
<div style="${style({ fontFamily: EMAIL_FONT.sans, fontSize: "16px", lineHeight: "24px", color: EMAIL_COLOR.fg, marginTop: "4px" })}">${esc(sentence(n.title))}</div>
<div style="${style({ fontFamily: EMAIL_FONT.sans, fontSize: "14px", lineHeight: "20px", color: EMAIL_COLOR.muted, marginTop: "4px" })}">${esc(n.detail)}</div>
<div style="${style({ fontFamily: EMAIL_FONT.sans, fontSize: "12px", lineHeight: "16px", color: EMAIL_COLOR.subtle, marginTop: "8px" })}">Underlag: ${esc(n.evidence.rule)}</div>
<div style="${style({ fontFamily: EMAIL_FONT.sans, fontSize: "14px", lineHeight: "20px", marginTop: "8px" })}"><a href="${esc(absoluteLink(options.baseUrl, n.link))}" style="${style({ color: EMAIL_COLOR.fg })}">Öppna underlaget →</a></div>
</td></tr>`;
    })
    .join("\n");

  const html = `<!doctype html>
<html lang="sv"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(delivery.subject)}</title></head>
<body style="${style({ margin: 0, padding: 0, background: EMAIL_COLOR.bg })}">
<div style="${style({ display: "none", maxHeight: 0, overflow: "hidden" })}">${esc(preheader)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${style({ background: EMAIL_COLOR.bg })}"><tr><td align="center" style="${style({ padding: "24px 0" })}">
<table role="presentation" width="${EMAIL_WIDTH}" cellpadding="0" cellspacing="0" style="${style({ width: "100%", maxWidth: `${EMAIL_WIDTH}px`, background: EMAIL_COLOR.surface, border: `1px solid ${EMAIL_COLOR.line}` })}">
<tr><td style="${style({ padding: "24px" })}">
<div style="${label}">Binderlab · ${esc(options.organizationName)} · Larm</div>
<h1 style="${style({ fontFamily: EMAIL_FONT.sans, fontSize: "24px", lineHeight: "32px", fontWeight: 500, color: EMAIL_COLOR.fg, margin: "12px 0 0" })}">${esc(sentence(delivery.subject))} <span style="${style({ color: EMAIL_COLOR.subtle })}">${esc(`${formatInt(delivery.items.length)}${NBSP}${delivery.items.length === 1 ? "larm" : "larm"}, ${when}.`)}</span></h1>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${style({ marginTop: "16px" })}">
${rows}
</table>
<div style="${style({ fontFamily: EMAIL_FONT.sans, fontSize: "12px", lineHeight: "16px", color: EMAIL_COLOR.subtle, marginTop: "16px", borderTop: `1px solid ${EMAIL_COLOR.line}`, paddingTop: "12px" })}">Du får larmet eftersom du prenumererar på det. Ändra vilka larm, automater och tider: <a href="${esc(absoluteLink(options.baseUrl, "/drift/larm"))}" style="${style({ color: EMAIL_COLOR.fg })}">Larminställningar →</a></div>
</td></tr></table>
</td></tr></table>
</body></html>`;

  const text = [
    sentence(delivery.subject),
    `${formatInt(delivery.items.length)} larm, ${when}. ${options.organizationName}.`,
    "",
    ...delivery.items.flatMap((n) => [
      `${n.severity === "critical" && n.reason !== "resolved" ? "! " : ""}${SEVERITY_LABEL[n.severity]} · ${REASON_LABEL[n.reason]}`,
      sentence(n.title),
      n.detail,
      `Underlag: ${n.evidence.rule}`,
      absoluteLink(options.baseUrl, n.link),
      "",
    ]),
    `Larminställningar: ${absoluteLink(options.baseUrl, "/drift/larm")}`,
  ].join("\n");

  return { subject: `Larm: ${delivery.subject}`, preheader, html, text };
}
