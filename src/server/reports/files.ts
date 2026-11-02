/**
 * Filerna en rapport kan laddas ner som: PDF (alla), Excel och SIE 4 (bokföringsunderlag).
 * Excel och SIE räknas fram ur ögonblicksbilden varje gång, så de blir identiska med det
 * som granskades och godkändes. Ren modul (exceljs i minnet, ingen disk).
 */

import { buildAccountantWorkbook, exportSie4 } from "@/reports";

import type { ReportSnapshot } from "./snapshot";

export type ReportFileKind = "pdf" | "xlsx" | "sie";

export const CONTENT_TYPE: Record<ReportFileKind, string> = {
  pdf: "application/pdf",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  sie: "text/plain; charset=IBM437",
};

const EXTENSION: Record<ReportFileKind, string> = { pdf: "pdf", xlsx: "xlsx", sie: "se" };

export class ReportFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReportFileError";
  }
}

/** "nordstan-centrum" av "Nordstan Centrum (exempel)". */
export function slug(text: string): string {
  return (
    text
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[̀-ͯ]/g, "")
      .replace(/\(.*?\)/g, " ")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "rapport"
  );
}

/** Filnamn: "binderlab-butik-nordstan-2026-10.pdf", "binderlab-bokforing-2026-10.se". */
export function reportFileName(snapshot: ReportSnapshot, kind: ReportFileKind): string {
  const scope = snapshot.type === "butik" ? `butik-${slug(snapshot.store.name)}` : snapshot.type;
  return `binderlab-${scope}-${snapshot.month}.${EXTENSION[kind]}`;
}

/** Vilka filer rapporttypen har. */
export function fileKindsOf(snapshot: ReportSnapshot): ReportFileKind[] {
  return snapshot.type === "bokforing" ? ["pdf", "xlsx", "sie"] : ["pdf"];
}

/** Excel-arbetsboken för ett bokföringsunderlag. */
export async function excelOf(snapshot: ReportSnapshot): Promise<Uint8Array> {
  if (snapshot.type !== "bokforing") {
    throw new ReportFileError("Excel finns bara för bokföringsunderlaget.");
  }
  return new Uint8Array(await buildAccountantWorkbook(snapshot.report));
}

/** SIE 4-filen för ett bokföringsunderlag. Kastar om konton saknas i kontoplanen. */
export function sieOf(snapshot: ReportSnapshot): Uint8Array {
  if (snapshot.type !== "bokforing") {
    throw new ReportFileError("SIE finns bara för bokföringsunderlaget.");
  }
  if (snapshot.missingAccounts.length > 0) {
    throw new ReportFileError(
      `SIE kan inte skapas: konto saknas för ${snapshot.missingAccounts.join(", ")} i kontoplanen.`,
    );
  }
  return new Uint8Array(exportSie4(snapshot.report, snapshot.sie));
}
