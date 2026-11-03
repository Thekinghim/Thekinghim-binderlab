/**
 * Månadspaketet (ZIP) som skickas till Talenom/Fortnox:
 *
 *   verifikation-ÅÅÅÅ-MM.si      SIE 4I (Fortnox → Bokföring → Importera SIE); saknas när
 *                               månaden inte har några transaktioner
 *   sammanfattning-ÅÅÅÅ-MM.pdf   en sida: med eller utan VMB, VMB steg för steg (när VMB
 *                               är på), butikernas andel, resultat
 *                               (.html om PDF inte kan skapas i miljön)
 *   rader-ÅÅÅÅ-MM.xlsx           verifikationens rader, butiker, dagar, kvitton
 *   kvitton/NNN-namn.ext         månadens kvitton
 *   kvitton/index.csv            förteckning över kvittona
 *   LAS-MIG.txt                  hur paketet används
 *
 * Utan databas: kvittonas innehåll och PDF-utskriften ges av anroparen.
 */

import { monthEnd } from "@/domain";
import { monthText } from "@/reports";

import { buildMonthWorkbook, type ReceiptIndexRow } from "./excel";
import type { MonthBook } from "./month";
import { accountName, PLAN_KEYS, type AccountPlan } from "./plan";
import { zipReceiptName } from "./receipts";
import { buildSieFile, monthVerification, type MonthVerification } from "./sie";
import { summaryHtml } from "./summary";
import { buildZip, type ZipEntry } from "./zip";

export interface PackageReceipt {
  readonly fileName: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly uploadedOn: string;
  readonly data: Uint8Array;
}

export interface MonthPackageInput {
  readonly company: string;
  readonly orgNumber: string | null;
  readonly book: MonthBook;
  readonly plan: AccountPlan;
  readonly series: string;
  /** Verifikationsnumret (månadens ordning i räkenskapsåret). */
  readonly number: number;
  readonly fiscalYear: { readonly start: string; readonly end: string };
  readonly generatedOn: string;
  readonly sentOn: string | null;
  readonly receipts: readonly PackageReceipt[];
  /** HTML → PDF. null = PDF kan inte skapas här (sammanfattningen läggs som HTML). */
  readonly renderPdf: ((html: string) => Promise<Uint8Array>) | null;
  /** Varför paketet bara är preliminärt (en rad), eller null när det är klart. */
  readonly preliminary?: string | null;
}

export interface MonthPackage {
  readonly fileName: string;
  readonly bytes: Uint8Array;
  readonly entries: readonly string[];
  readonly verification: MonthVerification;
  readonly pdf: boolean;
}

export function accountNames(plan: AccountPlan): Map<string, string> {
  const m = new Map<string, string>();
  for (const k of PLAN_KEYS) if (!m.has(plan[k])) m.set(plan[k], accountName(plan, k));
  return m;
}

const csvCell = (v: string | number) => {
  // Ett uppladdat filnamn som "=HYPERLINK(...)" ska inte bli en formel i Excel.
  const s = typeof v === "string" && /^[=+\-@\t\r]/.test(v) ? `'${v}` : String(v);
  return /[;"\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

export async function buildMonthPackage(input: MonthPackageInput): Promise<MonthPackage> {
  const { book, plan } = input;
  const m = book.month;
  const verification = monthVerification(book, plan, input.series, input.number);
  const names = accountNames(plan);
  const sie = buildSieFile({
    company: input.company,
    orgNumber: input.orgNumber,
    fiscalYear: input.fiscalYear,
    plan,
    verifications: [verification],
    generatedOn: input.generatedOn,
  });

  const receiptRows: (ReceiptIndexRow & { sha256: string; data: Uint8Array })[] =
    input.receipts.map((r, i) => ({
      file: `kvitton/${zipReceiptName(i + 1, r.fileName, r.contentType)}`,
      originalName: r.fileName,
      uploadedOn: r.uploadedOn,
      sizeBytes: r.sizeBytes,
      sha256: r.sha256,
      data: r.data,
    }));

  const html = summaryHtml({
    company: input.company,
    orgNumber: input.orgNumber,
    book,
    verification,
    accountNames: names,
    receipts: receiptRows.length,
    generatedOn: input.generatedOn,
    sentOn: input.sentOn,
  });
  let summary: ZipEntry;
  let pdf = false;
  if (input.renderPdf) {
    try {
      summary = { name: `sammanfattning-${m}.pdf`, data: await input.renderPdf(html) };
      pdf = true;
    } catch {
      summary = { name: `sammanfattning-${m}.html`, data: new TextEncoder().encode(html) };
    }
  } else {
    summary = { name: `sammanfattning-${m}.html`, data: new TextEncoder().encode(html) };
  }

  const xlsx = await buildMonthWorkbook({
    book,
    verification,
    accountNames: names,
    receipts: receiptRows,
  });

  const index =
    "﻿" +
    [
      ["Fil", "Uppladdat namn", "Uppladdad", "Storlek (byte)", "SHA-256"].join(";"),
      ...receiptRows.map((r) =>
        [r.file, r.originalName, r.uploadedOn, r.sizeBytes, r.sha256].map(csvCell).join(";"),
      ),
    ].join("\r\n") +
    "\r\n";

  const sieName = `verifikation-${m}.si`;
  const hasVoucher = verification.rows.length > 0;
  const preliminary = input.preliminary ?? null;
  const readme = [
    `Bokföring ${monthText(m)} – ${input.company}`,
    ...(preliminary ? [`PRELIMINÄR: ${preliminary} Bokför inte förrän ett nytt paket finns.`] : []),
    "",
    hasVoucher
      ? `${sieName}: importera i Fortnox under Bokföring → Importera SIE. Filen har kontonamn ` +
        "(#KONTO); välj att inte skriva över Fortnox egna kontonamn vid importen."
      : "Ingen verifikation: månaden har inga transaktioner att bokföra.",
    book.vmbEnabled
      ? "Med VMB: försäljningen bokförs med VMB-moms (samlad beräkning per månad)."
      : "Utan VMB: ingen VMB-moms och inget underskott i verifikationen.",
    book.vmbEnabled
      ? `${summary.name}: VMB-momsen steg för steg, butikernas andel och resultatet.`
      : `${summary.name}: resultatet och butikernas andel.`,
    `rader-${m}.xlsx: verifikationens rader, butiker, dagar och kvitton.`,
    `kvitton/: ${receiptRows.length} kvitton, förteckning i kvitton/index.csv.`,
    "",
    `Verifikationsserie ${input.series}, nummer ${input.number} (månadens ordning i räkenskapsåret).`,
    "Kontoplanen och serien är ett förslag enligt BAS och kontrolleras av Talenom.",
    "Ingående moms på butikernas fakturor bokförs från fakturan.",
    "",
  ].join("\r\n");

  const entries: ZipEntry[] = [
    ...(hasVoucher ? [{ name: sieName, data: sie }] : []),
    summary,
    { name: `rader-${m}.xlsx`, data: xlsx },
    ...receiptRows.map((r) => ({ name: r.file, data: r.data })),
    { name: "kvitton/index.csv", data: new TextEncoder().encode(index) },
    { name: "LAS-MIG.txt", data: new TextEncoder().encode(readme) },
  ];
  const bytes = buildZip(entries, new Date(`${monthEnd(m)}T12:00:00Z`));
  return {
    fileName: preliminary ? `bokforing-${m}-preliminar.zip` : `bokforing-${m}.zip`,
    bytes,
    entries: entries.map((e) => e.name),
    verification,
    pdf,
  };
}
