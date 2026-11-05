/**
 * Läser en ZIP-fil (bara för tester): katalogen i slutet, varje fils lokala huvud och
 * innehållet (deflate eller okomprimerat). Kontrollerar CRC-32 och storlek, så att
 * testerna bevisar att arkivet är giltigt och inte bara att skrivaren är konsekvent.
 */

import { inflateRawSync } from "node:zlib";

import { crc32 } from "../zip";

export interface UnzippedFile {
  name: string;
  bytes: Uint8Array;
  text: string;
}

export function unzip(zip: Uint8Array): UnzippedFile[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  let end = -1;
  for (let i = zip.length - 22; i >= 0; i -= 1) {
    if (view.getUint32(i, true) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("Ingen slutpost (EOCD).");
  const count = view.getUint16(end + 10, true);
  let at = view.getUint32(end + 16, true);
  const decoder = new TextDecoder();
  const files: UnzippedFile[] = [];
  for (let n = 0; n < count; n += 1) {
    if (view.getUint32(at, true) !== 0x02014b50) throw new Error("Fel i katalogen.");
    const method = view.getUint16(at + 10, true);
    const crc = view.getUint32(at + 16, true);
    const compressedSize = view.getUint32(at + 20, true);
    const size = view.getUint32(at + 24, true);
    const nameLength = view.getUint16(at + 28, true);
    const extra = view.getUint16(at + 30, true);
    const comment = view.getUint16(at + 32, true);
    const offset = view.getUint32(at + 42, true);
    const name = decoder.decode(zip.subarray(at + 46, at + 46 + nameLength));
    if (view.getUint32(offset, true) !== 0x04034b50) throw new Error(`Fel lokalt huvud: ${name}`);
    const localName = view.getUint16(offset + 26, true);
    const localExtra = view.getUint16(offset + 28, true);
    const start = offset + 30 + localName + localExtra;
    const data = zip.subarray(start, start + compressedSize);
    const bytes = method === 8 ? new Uint8Array(inflateRawSync(data)) : data;
    if (bytes.length !== size) throw new Error(`Fel storlek: ${name}`);
    if (crc32(bytes) !== crc) throw new Error(`Fel CRC: ${name}`);
    files.push({ name, bytes, text: decoder.decode(bytes) });
    at += 46 + nameLength + extra + comment;
  }
  return files;
}

/** En CSV från exporten som rader av fält (semikolon, citattecken enligt RFC 4180). */
export function parseExportCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  const s = text.replace(/^﻿/, "");
  for (let i = 0; i < s.length; i += 1) {
    const ch = s[i]!;
    if (quoted) {
      if (ch === '"' && s[i + 1] === '"') {
        field += '"';
        i += 1;
      } else if (ch === '"') {
        quoted = false;
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      quoted = true;
    } else if (ch === ";") {
      row.push(field);
      field = "";
    } else if (ch === "\r" && s[i + 1] === "\n") {
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
      i += 1;
    } else {
      field += ch;
    }
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}
