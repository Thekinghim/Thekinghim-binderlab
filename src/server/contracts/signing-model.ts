/**
 * Digital signering på plats: de rena delarna (token, signaturbilden, signaturbladet).
 * Tjänsten står i ./signing.ts och reglerna i databasen i
 * supabase/migrations/20261104233200_avtal_signering.sql.
 */

import { createHash, randomBytes } from "node:crypto";

import { escapeHtml } from "@/reports/contract-pdf";

/** Så länge en signeringslänk gäller. */
export const SIGNING_LINK_DAYS = 7;
/** Så länge butiken kan ladda ner den signerade PDF:en med länken efter signeringen. */
export const SIGNED_DOWNLOAD_DAYS = 30;
/** Största signaturbild (PNG), samma gräns som databasen. */
export const MAX_SIGNATURE_BYTES = 300_000;

const TOKEN = /^[0-9a-f]{64}$/;
const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

/** En ny token: 32 slumpbyte som hex. Visas en gång; bara hashen sparas. */
export function newSigningToken(): string {
  return randomBytes(32).toString("hex");
}

export function isSigningToken(token: unknown): token is string {
  return typeof token === "string" && TOKEN.test(token);
}

/** Samma hash som databasen (sha256 av token som UTF-8, hex). */
export function hashSigningToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

export class SignatureInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SignatureInputError";
  }
}

/**
 * Signaturen från ritytan: en data-URL med PNG. Kontrollerar formatet, storleken,
 * PNG-signaturen och att bilden har rimliga mått. Kastar SignatureInputError.
 */
export function parseSignaturePng(dataUrl: unknown): Uint8Array {
  const prefix = "data:image/png;base64,";
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(prefix)) {
    throw new SignatureInputError("Rita din signatur.");
  }
  const b64 = dataUrl.slice(prefix.length);
  if (
    b64.length > Math.ceil((MAX_SIGNATURE_BYTES * 4) / 3) + 4 ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)
  ) {
    throw new SignatureInputError("Signaturen gick inte att läsa. Rita den igen.");
  }
  const bytes = new Uint8Array(Buffer.from(b64, "base64"));
  if (bytes.byteLength < 67 || bytes.byteLength > MAX_SIGNATURE_BYTES) {
    throw new SignatureInputError("Signaturen gick inte att läsa. Rita den igen.");
  }
  if (!PNG_MAGIC.every((b, i) => bytes[i] === b)) {
    throw new SignatureInputError("Signaturen gick inte att läsa. Rita den igen.");
  }
  // IHDR: bredd och höjd (big endian) på byte 16–23.
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  if (width < 50 || height < 20 || width > 4000 || height > 2000) {
    throw new SignatureInputError("Signaturen gick inte att läsa. Rita den igen.");
  }
  return bytes;
}

/** Namnet som det sparas: trimmat, ett mellanslag mellan orden, 2–100 tecken. */
export function normalizeSignerName(name: unknown): string {
  const v = typeof name === "string" ? name.replace(/\s+/g, " ").trim() : "";
  if (v.length < 2 || v.length > 100) throw new SignatureInputError("Skriv ditt namn.");
  return v;
}

export interface SignatureSheetInput {
  readonly organizationName: string;
  readonly storeName: string;
  readonly contractTitle: string;
  /** Avtalets referens (första 8 tecknen i id:t, versaler). */
  readonly reference: string;
  readonly signerName: string;
  readonly signedAt: Date;
  readonly timezone: string;
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** sha256 av PDF:en som visades och signerades. */
  readonly documentSha256: string;
  readonly documentName: string | null;
  readonly signatureId: string;
  readonly signaturePng: Uint8Array;
}

/** Tiden som den står på bladet, t.ex. "4 november 2026 kl. 14:05:09 (Europe/Stockholm)". */
export function signedAtText(at: Date, timezone: string): string {
  const d = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(at);
  const t = new Intl.DateTimeFormat("sv-SE", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(at);
  return `${d} kl. ${t} (${timezone})`;
}

const SHEET_CSS = `
  .bl-sig { font: 10.5pt/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif; color: #111; }
  .bl-sig h1 { font-size: 18pt; font-weight: 600; margin: 0 0 2mm; }
  .bl-sig .lead { color: #333; margin: 0 0 8mm; }
  .bl-sig .img { border-bottom: 1px solid #111; height: 34mm; display: flex; align-items: flex-end; margin-bottom: 2mm; }
  .bl-sig .img img { max-height: 32mm; max-width: 100%; }
  .bl-sig .who { font-size: 12pt; font-weight: 600; margin: 0 0 8mm; }
  .bl-sig table { border-collapse: collapse; width: 100%; font-size: 9.5pt; }
  .bl-sig td { border-top: 1px solid #ddd; padding: 2mm 0; vertical-align: top; }
  .bl-sig td.k { color: #555; width: 42mm; padding-right: 4mm; }
  .bl-sig .mono { font-family: "SFMono-Regular", Menlo, Consolas, monospace; font-size: 8.5pt; word-break: break-all; }
  .bl-sig .foot { color: #555; font-size: 8.5pt; margin-top: 8mm; }
`;

/** Signaturbladet som ett fragment (för att läggas sist i avtalets HTML). */
export function signatureSheetFragment(input: SignatureSheetInput): string {
  const img = `data:image/png;base64,${Buffer.from(input.signaturePng).toString("base64")}`;
  const rows: [string, string, boolean?][] = [
    ["Avtal", `${input.contractTitle} · ${input.reference}`],
    ["Parter", `${input.organizationName} och ${input.storeName}`],
    ["Signerat av", input.signerName],
    ["Tid", signedAtText(input.signedAt, input.timezone)],
    ["IP-adress", input.ip ?? "okänd"],
    ["Webbläsare", input.userAgent ?? "okänd", true],
    ["Dokument", input.documentName ?? "Avtalet (PDF)"],
    ["Dokumentets SHA-256", input.documentSha256, true],
    ["Signaturens id", input.signatureId, true],
  ];
  return `<section class="bl-sig">
<h1>Signaturblad</h1>
<p class="lead">${escapeHtml(input.storeName)} har läst avtalet och signerat det digitalt i Binderlab.</p>
<div class="img"><img alt="Signatur" src="${img}"></div>
<p class="who">${escapeHtml(input.signerName)}, ${escapeHtml(input.storeName)}</p>
<table>${rows
    .map(
      ([k, v, mono]) =>
        `<tr><td class="k">${escapeHtml(k)}</td><td${mono ? ' class="mono"' : ""}>${escapeHtml(v)}</td></tr>`,
    )
    .join("")}</table>
<p class="foot">Dokumentets SHA-256 är kontrollsumman för PDF:en som visades vid signeringen. Samma kontrollsumma betyder samma fil.</p>
</section>`;
}

/**
 * Den signerade PDF:ens HTML: avtalets text (HTML:en som PDF:en skrevs ut från, om den
 * finns) och signaturbladet på en egen sida. Utan avtalets HTML blir det bara bladet, som
 * pekar på PDF:en med kontrollsumman.
 */
export function signedDocumentHtml(
  contractHtml: string | null,
  sheet: SignatureSheetInput,
): string {
  const fragment = signatureSheetFragment(sheet);
  const style = `<style>${SHEET_CSS} .bl-sig-page { break-before: page; }</style>`;
  if (contractHtml && /<\/body>/i.test(contractHtml) && /<\/head>/i.test(contractHtml)) {
    return contractHtml
      .replace(/<\/head>/i, `${style}</head>`)
      .replace(/<\/body>(?![\s\S]*<\/body>)/i, `<div class="bl-sig-page">${fragment}</div></body>`);
  }
  return `<!doctype html>
<html lang="sv">
<head>
<meta charset="utf-8">
<title>Signaturblad ${escapeHtml(sheet.storeName)}</title>
<style>@page { size: A4; margin: 22mm 20mm; } * { box-sizing: border-box; } body { margin: 0; }${SHEET_CSS}</style>
</head>
<body>
${fragment}
</body>
</html>`;
}

/** Filnamnet för den signerade PDF:en. */
export function signedFileName(storeName: string): string {
  const clean = storeName
    .replace(/[\\/\u0000-\u001f"]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `Signerat avtal ${clean || "butik"}.pdf`;
}
