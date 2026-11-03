/**
 * Kvitton: filtyper, kontroll av innehållet och sökvägen i bucketen 'receipts'. Rena
 * funktioner.
 *
 * Sökvägen är "{organization_id}/{ÅÅÅÅ-MM}/{sha256}.{ext}": servern namnger filen själv och
 * samma innehåll hamnar på samma ställe. Typen avgörs av innehållet (magiska bytes), inte av
 * webbläsarens uppgift.
 */

import { isValidStoragePath } from "@/import/file-store";

export const RECEIPT_TYPES: Readonly<Record<string, string>> = {
  "application/pdf": "pdf",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/heic": "heic",
  "image/heif": "heif",
};

/** Största kvitto (10 MB). */
export const MAX_RECEIPT_BYTES = 10 * 1024 * 1024;

/** Det som filväljaren tar emot (bilder från kameran och PDF). */
export const RECEIPT_ACCEPT =
  "application/pdf,image/jpeg,image/png,image/heic,image/heif,.pdf,.jpg,.jpeg,.png,.heic,.heif";

const HEIC_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis"]);
const HEIF_BRANDS = new Set(["mif1", "msf1", "heif"]);

/** Filtypen enligt innehållet, eller null om den inte tas emot. */
export function sniffReceipt(bytes: Uint8Array): string | null {
  const starts = (sig: number[], at = 0) => sig.every((b, i) => bytes[at + i] === b);
  if (starts([0x25, 0x50, 0x44, 0x46, 0x2d])) return "application/pdf"; // %PDF-
  if (starts([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (starts([0xff, 0xd8, 0xff])) return "image/jpeg";
  // ISO-BMFF: [storlek]"ftyp"[varumärke]
  if (bytes.length >= 12 && starts([0x66, 0x74, 0x79, 0x70], 4)) {
    const brand = String.fromCharCode(...bytes.slice(8, 12));
    if (HEIC_BRANDS.has(brand)) return "image/heic";
    if (HEIF_BRANDS.has(brand)) return "image/heif";
  }
  return null;
}

export type ReceiptCheck =
  | { readonly ok: true; readonly contentType: string }
  | { readonly ok: false; readonly error: string };

/** Kontrollerar storlek och typ. */
export function checkReceipt(bytes: Uint8Array): ReceiptCheck {
  if (bytes.byteLength === 0) return { ok: false, error: "Filen är tom." };
  if (bytes.byteLength > MAX_RECEIPT_BYTES) {
    return { ok: false, error: "Filen är för stor (högst 10 MB)." };
  }
  const contentType = sniffReceipt(bytes);
  if (!contentType) return { ok: false, error: "Bara PDF, JPG, PNG eller HEIC." };
  return { ok: true, contentType };
}

export function receiptStoragePath(
  organizationId: string,
  month: string,
  sha256: string,
  contentType: string,
): string {
  const ext = RECEIPT_TYPES[contentType];
  if (!ext) throw new RangeError(`Filtypen ${contentType} tas inte emot.`);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw new RangeError("Ogiltig månad.");
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new RangeError("Ogiltig kontrollsumma.");
  const p = `${organizationId}/${month}/${sha256}.${ext}`;
  if (!isValidStoragePath(p)) throw new RangeError(`Ogiltig sökväg för fil: ${p}`);
  return p;
}

/** Filnamnet som det visas och sparas: utan katalog och styrtecken, högst 200 tecken. */
export function cleanFileName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? "";
  const clean = base.replace(/[\u0000-\u001f\u007f]/g, "").trim();
  return (clean || "kvitto").slice(0, 200);
}

/** Filnamnet i ZIP-arkivet: löpnummer + ASCII-säkert namn + rätt filändelse. */
export function zipReceiptName(index: number, fileName: string, contentType: string): string {
  const ext = RECEIPT_TYPES[contentType] ?? "bin";
  const stem = (fileName.split(/[\\/]/).pop() ?? "")
    .replace(/\.[A-Za-z0-9]{1,5}$/, "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "")
    .slice(0, 60);
  return `${String(index).padStart(3, "0")}-${stem || "kvitto"}.${ext}`;
}
