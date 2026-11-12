/**
 * Text ur en PDF, rad för rad med läge i sidled. Ren funktion utan beroenden utöver Nodes
 * zlib: ingen inbyggd binär, ingen worker och inget att bunta, så den går i en vanlig
 * server action (Node-runtime).
 *
 * Den läser den sortens PDF som Nayax skickar (skapad med wkhtmltopdf/Qt): PDF 1.4 med
 * vanliga objekt, Flate-packade sidinnehåll och typsnitt med ToUnicode-tabell. Det den inte
 * förstår (krypterad fil, objektströmmar, andra filter, typsnitt utan teckentabell) ger
 * `PdfTextError`, aldrig en gissad text. Den som tolkar texten kontrollerar dessutom att
 * summorna går ihop (./nayax-statement.ts).
 *
 * Resultatet är rader (uppifrån och ned per sida) med celler: text som står ihop. Ett
 * mellanrum som är bredare än ett par blanksteg börjar en ny cell, så att kolumnerna i en
 * tabell hålls isär.
 */

import { inflateSync } from "node:zlib";

export class PdfTextError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PdfTextError";
  }
}

export interface PdfCell {
  /** Vänsterkant och högerkant i punkter från sidans vänsterkant. */
  readonly x: number;
  readonly xEnd: number;
  readonly text: string;
}

export interface PdfLine {
  readonly page: number;
  /** Läge uppifrån (större = längre ned). Bara för ordning och jämförelse inom sidan. */
  readonly y: number;
  readonly cells: readonly PdfCell[];
}

/** Största uppackade ström (skydd mot en fil som sväller). */
const MAX_STREAM_BYTES = 30 * 1024 * 1024;
const MAX_PAGES = 50;

type Matrix = readonly [number, number, number, number, number, number];
const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/** m1 följt av m2. */
function mul(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

interface PdfObject {
  readonly dict: string;
  /** Strömmens råa byte (latin1-text), om objektet har en ström. */
  readonly stream: string | null;
}

interface Font {
  readonly twoByte: boolean;
  /** Teckenkod → text; null = koden är tecknets Latin-1-värde. */
  readonly toUnicode: Map<number, string> | null;
  /** Teckenkod → bredd i tusendelar av en fyrkant. */
  readonly widths: Map<number, number>;
  readonly defaultWidth: number;
}

interface Glyph {
  readonly x: number;
  readonly xEnd: number;
  readonly y: number;
  readonly em: number;
  readonly text: string;
}

function readObjects(src: string): Map<number, PdfObject> {
  const objects = new Map<number, PdfObject>();
  const re = /(\d+)\s+\d+\s+obj\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    const start = m.index + m[0].length;
    const endObj = src.indexOf("endobj", start);
    if (endObj < 0) break;
    const streamAt = src.slice(start, endObj).search(/stream\r?\n/);
    const id = Number(m[1]);
    if (streamAt < 0) {
      objects.set(id, { dict: src.slice(start, endObj), stream: null });
      re.lastIndex = endObj + 6;
      continue;
    }
    const dict = src.slice(start, start + streamAt);
    const dataStart = src.indexOf("\n", start + streamAt) + 1;
    const direct = /\/Length\s+(\d+)(?!\s+\d+\s+R)/.exec(dict);
    let dataEnd = -1;
    if (direct) {
      const end = dataStart + Number(direct[1]);
      if (/^\s*endstream/.test(src.slice(end, end + 16))) dataEnd = end;
    }
    if (dataEnd < 0) {
      dataEnd = src.indexOf("endstream", dataStart);
      if (dataEnd < 0) break;
      // Radbrytningen före endstream hör inte till strömmen.
      if (src[dataEnd - 1] === "\n") dataEnd -= src[dataEnd - 2] === "\r" ? 2 : 1;
    }
    objects.set(id, { dict, stream: src.slice(dataStart, dataEnd) });
    re.lastIndex = src.indexOf("endstream", dataEnd) + 9;
  }
  return objects;
}

function streamText(obj: PdfObject | undefined): string {
  if (!obj || obj.stream === null) throw new PdfTextError("En ström saknas i filen.");
  const filter = /\/Filter\s*(\[[^\]]*\]|\/\w+)/.exec(obj.dict)?.[1];
  if (!filter) return obj.stream;
  const names = filter.match(/\/\w+/g) ?? [];
  if (names.length !== 1 || names[0] !== "/FlateDecode") {
    throw new PdfTextError(`Filtret ${names.join(" ")} stöds inte.`);
  }
  try {
    return inflateSync(Buffer.from(obj.stream, "latin1"), {
      maxOutputLength: MAX_STREAM_BYTES,
    }).toString("latin1");
  } catch {
    throw new PdfTextError("En ström i filen går inte att packa upp.");
  }
}

function utf16Hex(hex: string): string {
  let out = "";
  for (let i = 0; i + 4 <= hex.length; i += 4) {
    out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  }
  return out;
}

function parseToUnicode(cmap: string): Map<number, string> {
  const map = new Map<number, string>();
  for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const pair of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      map.set(parseInt(pair[1]!, 16), utf16Hex(pair[2]!));
    }
  }
  for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    const re = /<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(?:<([0-9a-fA-F]+)>|\[([^\]]*)\])/g;
    for (const r of block[1]!.matchAll(re)) {
      const from = parseInt(r[1]!, 16);
      const to = parseInt(r[2]!, 16);
      if (to < from || to - from > 65_535) continue;
      if (r[3] !== undefined) {
        const base = utf16Hex(r[3]);
        const head = base.slice(0, -1);
        const last = base.charCodeAt(base.length - 1);
        for (let c = from; c <= to; c += 1) {
          map.set(c, head + String.fromCharCode(last + (c - from)));
        }
      } else {
        const list = [...r[4]!.matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => utf16Hex(x[1]!));
        for (let c = from; c <= to && c - from < list.length; c += 1) {
          map.set(c, list[c - from]!);
        }
      }
    }
  }
  return map;
}

function ref(dict: string, key: string): number | null {
  const m = new RegExp(`/${key}\\s+(\\d+)\\s+\\d+\\s+R`).exec(dict);
  return m ? Number(m[1]) : null;
}

function readFont(objects: Map<number, PdfObject>, id: number): Font {
  const obj = objects.get(id);
  if (!obj) throw new PdfTextError("Ett typsnitt saknas i filen.");
  const twoByte = /\/Subtype\s*\/Type0/.test(obj.dict);
  const uni = ref(obj.dict, "ToUnicode");
  const toUnicode = uni === null ? null : parseToUnicode(streamText(objects.get(uni)));
  if (twoByte && !toUnicode) {
    throw new PdfTextError("Ett typsnitt i filen saknar teckentabell.");
  }
  const widths = new Map<number, number>();
  let defaultWidth = twoByte ? 1000 : 500;
  if (twoByte) {
    const d = /\/DescendantFonts\s*\[\s*(\d+)\s+\d+\s+R/.exec(obj.dict);
    const cid = d ? objects.get(Number(d[1])) : undefined;
    if (cid) {
      const dw = /\/DW\s+(\d+)/.exec(cid.dict);
      if (dw) defaultWidth = Number(dw[1]);
      const wAt = cid.dict.search(/\/W\s*\[/);
      if (wAt >= 0) {
        // "/W [ c [w w w] c1 c2 w ... ]": läs till den yttre hakparentesen stängs.
        let depth = 0;
        let end = cid.dict.indexOf("[", wAt);
        const from = end + 1;
        for (; end < cid.dict.length; end += 1) {
          if (cid.dict[end] === "[") depth += 1;
          else if (cid.dict[end] === "]" && (depth -= 1) === 0) break;
        }
        const tokens = cid.dict.slice(from, end).match(/\[|\]|-?[\d.]+/g) ?? [];
        for (let i = 0; i < tokens.length;) {
          const first = Number(tokens[i]);
          if (tokens[i + 1] === "[") {
            let c = first;
            i += 2;
            while (i < tokens.length && tokens[i] !== "]") widths.set(c++, Number(tokens[i++]));
            i += 1;
          } else {
            const last = Number(tokens[i + 1]);
            const w = Number(tokens[i + 2]);
            if (!Number.isFinite(last) || !Number.isFinite(w) || last - first > 65_535) break;
            for (let c = first; c <= last; c += 1) widths.set(c, w);
            i += 3;
          }
        }
      }
    }
  } else {
    const first = /\/FirstChar\s+(\d+)/.exec(obj.dict);
    const w = /\/Widths\s*\[([^\]]*)\]/.exec(obj.dict);
    if (first && w) {
      (w[1]!.match(/-?[\d.]+/g) ?? []).forEach((x, i) =>
        widths.set(Number(first[1]) + i, Number(x)),
      );
    }
  }
  return { twoByte, toUnicode, widths, defaultWidth };
}

type Token =
  | { readonly t: "num"; readonly v: number }
  | { readonly t: "str"; readonly v: string }
  | { readonly t: "name"; readonly v: string }
  | { readonly t: "arr"; readonly v: Token[] }
  | { readonly t: "op"; readonly v: string };

const WHITE = /[\s\0]/;
const DELIM = /[\s\0()<>[\]{}/%]/;

/** Sidinnehållets operander och operatorer, i ordning. */
function* tokens(src: string): Generator<Token> {
  let i = 0;
  const n = src.length;
  const readString = (): string => {
    // src[i] === "("
    let depth = 1;
    let out = "";
    i += 1;
    while (i < n && depth > 0) {
      const ch = src[i]!;
      if (ch === "\\") {
        const next = src[i + 1] ?? "";
        const octal = /^[0-7]{1,3}/.exec(src.slice(i + 1, i + 4));
        if (octal) {
          out += String.fromCharCode(parseInt(octal[0], 8) & 0xff);
          i += 1 + octal[0].length;
          continue;
        }
        const map: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f" };
        if (next === "\n") out += "";
        else if (next === "\r") {
          if (src[i + 2] === "\n") i += 1;
        } else out += map[next] ?? next;
        i += 2;
        continue;
      }
      if (ch === "(") depth += 1;
      if (ch === ")") {
        depth -= 1;
        if (depth === 0) {
          i += 1;
          break;
        }
      }
      out += ch;
      i += 1;
    }
    return out;
  };
  const readHex = (): string => {
    const end = src.indexOf(">", i);
    const stop = end < 0 ? n : end;
    let hex = src.slice(i + 1, stop).replace(/[^0-9a-fA-F]/g, "");
    if (hex.length % 2 === 1) hex += "0";
    let out = "";
    for (let k = 0; k < hex.length; k += 2)
      out += String.fromCharCode(parseInt(hex.slice(k, k + 2), 16));
    i = stop + 1;
    return out;
  };
  const stack: Token[][] = [];
  const emit = function* (tok: Token): Generator<Token> {
    const top = stack[stack.length - 1];
    if (top) top.push(tok);
    else yield tok;
  };
  while (i < n) {
    const ch = src[i]!;
    if (WHITE.test(ch)) {
      i += 1;
    } else if (ch === "%") {
      while (i < n && src[i] !== "\n" && src[i] !== "\r") i += 1;
    } else if (ch === "(") {
      yield* emit({ t: "str", v: readString() });
    } else if (ch === "<" && src[i + 1] === "<") {
      // En inbäddad ordlista (t.ex. efter BDC): hoppas över.
      let depth = 0;
      for (; i < n; i += 1) {
        if (src[i] === "<" && src[i + 1] === "<") {
          depth += 1;
          i += 1;
        } else if (src[i] === ">" && src[i + 1] === ">") {
          depth -= 1;
          i += 1;
          if (depth === 0) {
            i += 1;
            break;
          }
        }
      }
    } else if (ch === "<") {
      yield* emit({ t: "str", v: readHex() });
    } else if (ch === "[") {
      stack.push([]);
      i += 1;
    } else if (ch === "]") {
      const arr = stack.pop();
      i += 1;
      if (arr) yield* emit({ t: "arr", v: arr });
    } else if (ch === "/") {
      let j = i + 1;
      while (j < n && !DELIM.test(src[j]!)) j += 1;
      yield* emit({ t: "name", v: src.slice(i + 1, j) });
      i = j;
    } else if (ch === ">" || ch === ")" || ch === "{" || ch === "}") {
      i += 1;
    } else {
      let j = i;
      while (j < n && !DELIM.test(src[j]!)) j += 1;
      const word = src.slice(i, j);
      i = j;
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(word)) {
        yield* emit({ t: "num", v: Number(word) });
      } else if (word === "BI") {
        // Inbäddad bild: hoppa till EI.
        const end = src.indexOf("EI", i);
        i = end < 0 ? n : end + 2;
      } else {
        yield* emit({ t: "op", v: word });
      }
    }
  }
}

function pageGlyphs(content: string, fonts: Map<string, Font>): Glyph[] {
  const glyphs: Glyph[] = [];
  let ctm: Matrix = IDENTITY;
  const saved: Matrix[] = [];
  let tm: Matrix = IDENTITY;
  let tlm: Matrix = IDENTITY;
  let font: Font | null = null;
  let size = 0;
  let leading = 0;
  let operands: Token[] = [];
  const num = (k: number): number => {
    const tok = operands[k];
    return tok && tok.t === "num" ? tok.v : 0;
  };
  const moveLine = (tx: number, ty: number) => {
    tlm = mul([1, 0, 0, 1, tx, ty], tlm);
    tm = tlm;
  };
  const show = (raw: string) => {
    if (!font) throw new PdfTextError("Text utan typsnitt i filen.");
    const step = font.twoByte ? 2 : 1;
    for (let k = 0; k + step <= raw.length; k += step) {
      const code = font.twoByte
        ? (raw.charCodeAt(k) << 8) | raw.charCodeAt(k + 1)
        : raw.charCodeAt(k);
      const text = font.toUnicode ? font.toUnicode.get(code) : String.fromCharCode(code);
      if (text === undefined) {
        throw new PdfTextError("Ett tecken i filen saknas i typsnittets teckentabell.");
      }
      const advance = ((font.widths.get(code) ?? font.defaultWidth) / 1000) * size;
      const at = mul(tm, ctm);
      const after = mul([1, 0, 0, 1, advance, 0], at);
      const em = Math.hypot(at[0], at[1]) * size;
      if (text !== "" && text !== "\0") {
        glyphs.push({ x: at[4], xEnd: after[4], y: -at[5], em, text });
      }
      tm = mul([1, 0, 0, 1, advance, 0], tm);
    }
  };
  for (const tok of tokens(content)) {
    if (tok.t !== "op") {
      operands.push(tok);
      continue;
    }
    switch (tok.v) {
      case "q":
        saved.push(ctm);
        break;
      case "Q":
        ctm = saved.pop() ?? ctm;
        break;
      case "cm":
        ctm = mul([num(0), num(1), num(2), num(3), num(4), num(5)], ctm);
        break;
      case "BT":
        tm = IDENTITY;
        tlm = IDENTITY;
        break;
      case "Tf": {
        const name = operands[0];
        font = name && name.t === "name" ? (fonts.get(name.v) ?? null) : null;
        size = num(1);
        break;
      }
      case "TL":
        leading = num(0);
        break;
      case "Td":
        moveLine(num(0), num(1));
        break;
      case "TD":
        leading = -num(1);
        moveLine(num(0), num(1));
        break;
      case "Tm":
        tlm = [num(0), num(1), num(2), num(3), num(4), num(5)];
        tm = tlm;
        break;
      case "T*":
        moveLine(0, -leading);
        break;
      case "Tj":
      case "'":
      case '"': {
        if (tok.v !== "Tj") moveLine(0, -leading);
        const s = operands[operands.length - 1];
        if (s && s.t === "str") show(s.v);
        break;
      }
      case "TJ": {
        const arr = operands[0];
        if (arr && arr.t === "arr") {
          for (const part of arr.v) {
            if (part.t === "str") show(part.v);
            else if (part.t === "num") tm = mul([1, 0, 0, 1, (-part.v / 1000) * size, 0], tm);
          }
        }
        break;
      }
      default:
        break;
    }
    operands = [];
  }
  return glyphs;
}

/** Tecknen på en sida till rader med celler. */
function toLines(page: number, glyphs: Glyph[]): PdfLine[] {
  const sorted = [...glyphs].sort((a, b) => a.y - b.y || a.x - b.x);
  const rows: Glyph[][] = [];
  for (const g of sorted) {
    const row = rows[rows.length - 1];
    if (row && g.y - row[0]!.y <= Math.max(1.5, row[0]!.em * 0.3)) row.push(g);
    else rows.push([g]);
  }
  return rows.flatMap((row) => {
    row.sort((a, b) => a.x - b.x);
    const cells: { x: number; xEnd: number; text: string }[] = [];
    for (const g of row) {
      const cell = cells[cells.length - 1];
      const gap = cell ? g.x - cell.xEnd : Infinity;
      if (!cell || gap > g.em * 0.75) {
        cells.push({ x: g.x, xEnd: g.xEnd, text: g.text });
      } else {
        // Ett litet mellanrum utan blankstegstecken är ändå ett ordmellanrum.
        if (gap > g.em * 0.15 && !cell.text.endsWith(" ") && g.text !== " ") cell.text += " ";
        cell.text += g.text;
        cell.xEnd = Math.max(cell.xEnd, g.xEnd);
      }
    }
    const clean = cells
      .map((c) => ({ x: c.x, xEnd: c.xEnd, text: c.text.replace(/\s+/g, " ").trim() }))
      .filter((c) => c.text !== "");
    return clean.length > 0 ? [{ page, y: row[0]!.y, cells: clean }] : [];
  });
}

/**
 * Läser texten i en PDF. Kastar `PdfTextError` om filen inte är en PDF eller är av en sort
 * som inte stöds.
 */
export function extractPdfLines(bytes: Uint8Array): PdfLine[] {
  const src = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("latin1");
  if (!src.startsWith("%PDF-")) throw new PdfTextError("Filen är inte en PDF.");
  if (/\/Encrypt\s/.test(src.slice(-4096))) throw new PdfTextError("PDF-filen är låst.");
  const objects = readObjects(src);
  if ([...objects.values()].some((o) => /\/Type\s*\/ObjStm/.test(o.dict))) {
    throw new PdfTextError("PDF-filen är packad på ett sätt som inte stöds.");
  }

  // Sidorna i ordning: från katalogen genom sidträdet.
  const pages: { dict: string; inherited: string }[] = [];
  const walk = (id: number, inherited: string, depth: number) => {
    const obj = objects.get(id);
    if (!obj || depth > 20 || pages.length > MAX_PAGES) return;
    if (/\/Type\s*\/Pages\b/.test(obj.dict)) {
      const kids = /\/Kids\s*\[([^\]]*)\]/.exec(obj.dict)?.[1] ?? "";
      const res = /\/Resources\b/.test(obj.dict) ? obj.dict : inherited;
      for (const kid of kids.matchAll(/(\d+)\s+\d+\s+R/g)) walk(Number(kid[1]), res, depth + 1);
    } else {
      pages.push({ dict: obj.dict, inherited });
    }
  };
  const catalog = [...objects.values()].find((o) => /\/Type\s*\/Catalog\b/.test(o.dict));
  const root = catalog ? ref(catalog.dict, "Pages") : null;
  if (root === null) throw new PdfTextError("PDF-filen saknar sidor.");
  walk(root, "", 0);
  if (pages.length === 0) throw new PdfTextError("PDF-filen saknar sidor.");
  if (pages.length > MAX_PAGES) throw new PdfTextError("PDF-filen har för många sidor.");

  const fontCache = new Map<number, Font>();
  const lines: PdfLine[] = [];
  pages.forEach((page, index) => {
    const holder = /\/Resources\b/.test(page.dict) ? page.dict : page.inherited;
    const resId = ref(holder, "Resources");
    const resources = resId === null ? holder : (objects.get(resId)?.dict ?? "");
    const fontId = ref(resources, "Font");
    const fontDict =
      fontId === null
        ? (/\/Font\s*<<([\s\S]*?)>>/.exec(resources)?.[1] ?? "")
        : (objects.get(fontId)?.dict ?? "");
    const fonts = new Map<string, Font>();
    for (const f of fontDict.matchAll(/\/([^\s/<>[\]]+)\s+(\d+)\s+\d+\s+R/g)) {
      const id = Number(f[2]);
      if (!fontCache.has(id)) fontCache.set(id, readFont(objects, id));
      fonts.set(f[1]!, fontCache.get(id)!);
    }
    const one = ref(page.dict, "Contents");
    const many = /\/Contents\s*\[([^\]]*)\]/.exec(page.dict)?.[1];
    const ids =
      one !== null
        ? [one]
        : [...(many ?? "").matchAll(/(\d+)\s+\d+\s+R/g)].map((x) => Number(x[1]));
    const content = ids.map((id) => streamText(objects.get(id))).join("\n");
    lines.push(...toLines(index + 1, pageGlyphs(content, fonts)));
  });
  return lines;
}
