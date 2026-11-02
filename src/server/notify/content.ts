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

/** Sms: ämnet, första larmets text och länken. Högst tre sms-delar. */
export function smsText(delivery: AlertDelivery, baseUrl: string): string {
  const first = delivery.items[0];
  const parts = [
    `Binderlab: ${delivery.subject}.`,
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
<div style="${style({ fontFamily: EMAIL_FONT.sans, fontSize: "16px", lineHeight: "24px", color: EMAIL_COLOR.fg, marginTop: "4px" })}">${esc(n.title)}.</div>
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
<h1 style="${style({ fontFamily: EMAIL_FONT.sans, fontSize: "24px", lineHeight: "32px", fontWeight: 500, color: EMAIL_COLOR.fg, margin: "12px 0 0" })}">${esc(delivery.subject)}. <span style="${style({ color: EMAIL_COLOR.subtle })}">${esc(`${formatInt(delivery.items.length)}${NBSP}${delivery.items.length === 1 ? "larm" : "larm"}, ${when}.`)}</span></h1>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="${style({ marginTop: "16px" })}">
${rows}
</table>
<div style="${style({ fontFamily: EMAIL_FONT.sans, fontSize: "12px", lineHeight: "16px", color: EMAIL_COLOR.subtle, marginTop: "16px", borderTop: `1px solid ${EMAIL_COLOR.line}`, paddingTop: "12px" })}">Du får larmet eftersom du prenumererar på det. Ändra vilka larm, automater och tider: <a href="${esc(absoluteLink(options.baseUrl, "/drift/larm"))}" style="${style({ color: EMAIL_COLOR.fg })}">Larminställningar →</a></div>
</td></tr></table>
</td></tr></table>
</body></html>`;

  const text = [
    `${delivery.subject}.`,
    `${formatInt(delivery.items.length)} larm, ${when}. ${options.organizationName}.`,
    "",
    ...delivery.items.flatMap((n) => [
      `${n.severity === "critical" && n.reason !== "resolved" ? "! " : ""}${SEVERITY_LABEL[n.severity]} · ${REASON_LABEL[n.reason]}`,
      `${n.title}.`,
      n.detail,
      `Underlag: ${n.evidence.rule}`,
      absoluteLink(options.baseUrl, n.link),
      "",
    ]),
    `Larminställningar: ${absoluteLink(options.baseUrl, "/drift/larm")}`,
  ].join("\n");

  return { subject: `Larm: ${delivery.subject}`, preheader, html, text };
}
