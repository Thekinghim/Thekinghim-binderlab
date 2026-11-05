/**
 * En liten ZIP-skrivare (PKZIP 2.0, deflate) utan externa beroenden: zlib från Node och en
 * egen CRC-32. Räcker för exporten (några tiotal CSV-filer, under 4 GB totalt, ingen ZIP64).
 * Ren och deterministisk: samma filer och samma tid ger samma bytes (testas i zip.test.ts).
 */

import { deflateRawSync } from "node:zlib";

/** En fil i arkivet, redan komprimerad. */
export interface ZipEntry {
  readonly name: string;
  readonly crc32: number;
  readonly size: number;
  readonly compressed: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) {
    c = CRC_TABLE[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

/** Komprimerar en fil till en post (deflate nivå 6, som zip -6). */
export function zipEntry(name: string, content: string | Uint8Array): ZipEntry {
  if (!/^[A-Za-z0-9._/-]{1,200}$/.test(name) || name.startsWith("/") || name.includes("..")) {
    throw new TypeError(`Ogiltigt filnamn i ZIP: ${name}`);
  }
  const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
  return {
    name,
    crc32: crc32(bytes),
    size: bytes.length,
    compressed: new Uint8Array(deflateRawSync(bytes, { level: 6 })),
  };
}

/** MS-DOS-tid och datum (lokal tid i arkivet; vi skriver UTC-tiden som den är). */
function dosDateTime(at: Date): { time: number; date: number } {
  const year = Math.max(1980, at.getUTCFullYear());
  return {
    time: (at.getUTCHours() << 11) | (at.getUTCMinutes() << 5) | Math.floor(at.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((at.getUTCMonth() + 1) << 5) | at.getUTCDate(),
  };
}

const MAX_32 = 0xffffffff;

/**
 * Arkivets delar i ordning (lokala huvuden med data, katalogen, slutposten). Skicka dem
 * i följd (t.ex. som en ström) eller slå ihop dem med `zipBytes`.
 */
export function zipParts(entries: readonly ZipEntry[], at: Date): Uint8Array[] {
  if (entries.length > 0xffff) throw new RangeError("För många filer för ZIP utan ZIP64.");
  const { time, date } = dosDateTime(at);
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  const central: Uint8Array[] = [];
  let offset = 0;

  for (const e of entries) {
    if (e.size > MAX_32 || e.compressed.length > MAX_32 || offset > MAX_32) {
      throw new RangeError("Exporten är för stor för ZIP utan ZIP64.");
    }
    const name = encoder.encode(e.name);
    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version som behövs
    local.setUint16(6, 0x0800, true); // UTF-8-namn
    local.setUint16(8, 8, true); // deflate
    local.setUint16(10, time, true);
    local.setUint16(12, date, true);
    local.setUint32(14, e.crc32, true);
    local.setUint32(18, e.compressed.length, true);
    local.setUint32(22, e.size, true);
    local.setUint16(26, name.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), name, e.compressed);

    const dir = new DataView(new ArrayBuffer(46));
    dir.setUint32(0, 0x02014b50, true);
    dir.setUint16(4, 20, true); // skapad av
    dir.setUint16(6, 20, true);
    dir.setUint16(8, 0x0800, true);
    dir.setUint16(10, 8, true);
    dir.setUint16(12, time, true);
    dir.setUint16(14, date, true);
    dir.setUint32(16, e.crc32, true);
    dir.setUint32(20, e.compressed.length, true);
    dir.setUint32(24, e.size, true);
    dir.setUint16(28, name.length, true);
    dir.setUint32(42, offset, true);
    central.push(new Uint8Array(dir.buffer), name);

    offset += 30 + name.length + e.compressed.length;
  }

  const centralSize = central.reduce((n, p) => n + p.length, 0);
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, entries.length, true);
  end.setUint16(10, entries.length, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, offset, true);
  return [...parts, ...central, new Uint8Array(end.buffer)];
}

/** Hela arkivet i en buffert (tester och små arkiv). */
export function zipBytes(entries: readonly ZipEntry[], at: Date): Uint8Array {
  const parts = zipParts(entries, at);
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let i = 0;
  for (const p of parts) {
    out.set(p, i);
    i += p.length;
  }
  return out;
}
