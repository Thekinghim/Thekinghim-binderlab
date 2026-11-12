/**
 * Bygger en liten PDF av rader med celler, uppställd som de PDF-filer Nayax skickar
 * (wkhtmltopdf/Qt): PDF 1.4, Flate-packat sidinnehåll, ett typsnitt med ToUnicode-tabell och
 * ett tecken per Tj med flytt (Td) emellan. Bara för tester: så går hela vägen från byte
 * till utbetalning att prova utan en riktig rapport.
 */

import { deflateSync } from "node:zlib";

import { NAYAX_OCTOBER } from "./nayax-fixture";

export type FixtureLine = readonly [
  page: number,
  y: number,
  cells: readonly (readonly [x: number, xEnd: number, text: string])[],
];

const hex4 = (n: number) => n.toString(16).toUpperCase().padStart(4, "0");

export function buildPdf(lines: readonly FixtureLine[]): Uint8Array {
  const codes = new Map<string, number>();
  const code = (ch: string) => {
    if (!codes.has(ch)) codes.set(ch, codes.size + 1);
    return codes.get(ch)!;
  };
  const pages = [...new Set(lines.map((l) => l[0]))].sort((a, b) => a - b);
  const contents = pages.map((page) => {
    const ops: string[] = ["q", "1 0 0 1 0 0 cm"];
    for (const [p, y, cells] of lines) {
      if (p !== page) continue;
      for (const [x, xEnd, text] of cells) {
        const chars = [...text];
        // Alla tecken är en halv fyrkant breda: storleken väljs så att cellen blir rätt bred.
        const advance = (xEnd - x) / chars.length;
        const size = advance * 2;
        ops.push("BT", `/F1 ${size.toFixed(4)} Tf 1 0 0 1 0 0 Tm`);
        chars.forEach((ch, i) => {
          const move = i === 0 ? `${x.toFixed(3)} ${(-y).toFixed(3)}` : `${advance.toFixed(4)} 0`;
          ops.push(`${move} Td <${hex4(code(ch))}> Tj`);
        });
        ops.push("ET");
      }
    }
    ops.push("Q");
    return deflateSync(Buffer.from(ops.join("\n"), "latin1"));
  });

  const cmap = [
    "/CIDInit /ProcSet findresource begin",
    "12 dict begin",
    "begincmap",
    "1 begincodespacerange",
    "<0000> <FFFF>",
    "endcodespacerange",
    "1 beginbfrange",
    `<0001> <${hex4(codes.size)}> [${[...codes.keys()]
      .map((ch) => `<${hex4(ch.charCodeAt(0))}>`)
      .join(" ")}]`,
    "endbfrange",
    "endcmap",
    "end",
    "end",
  ].join("\n");

  const chunks: Buffer[] = [Buffer.from("%PDF-1.4\n", "latin1")];
  const add = (id: number, dict: string, stream?: Buffer) => {
    chunks.push(Buffer.from(`${id} 0 obj\n${dict}\n`, "latin1"));
    if (stream) {
      chunks.push(
        Buffer.from("stream\n", "latin1"),
        stream,
        Buffer.from("\nendstream\n", "latin1"),
      );
    }
    chunks.push(Buffer.from("endobj\n", "latin1"));
  };
  // 1 katalog, 2 sidträd, 3 typsnitt, 4 CID-typsnitt, 5 ToUnicode, sedan sida + innehåll.
  const pageId = (i: number) => 6 + i * 2;
  add(1, "<< /Type /Catalog /Pages 2 0 R >>");
  add(
    2,
    `<< /Type /Pages /Kids [ ${pages.map((_, i) => `${pageId(i)} 0 R`).join(" ")} ] /Count ${pages.length} >>`,
  );
  add(
    3,
    "<< /Type /Font /Subtype /Type0 /BaseFont /Test /Encoding /Identity-H /DescendantFonts [4 0 R] /ToUnicode 5 0 R >>",
  );
  add(
    4,
    `<< /Type /Font /Subtype /CIDFontType2 /BaseFont /Test /CIDToGIDMap /Identity /DW 500 /W [0 [${Array(
      codes.size + 1,
    )
      .fill(500)
      .join(" ")}]] >>`,
  );
  add(5, `<< /Length ${cmap.length} >>`, Buffer.from(cmap, "latin1"));
  contents.forEach((stream, i) => {
    add(
      pageId(i),
      `<< /Type /Page /Parent 2 0 R /Contents ${pageId(i) + 1} 0 R /Resources << /Font << /F1 3 0 R >> >> /MediaBox [0 0 595 842] >>`,
    );
    add(pageId(i) + 1, `<< /Length ${stream.length} /Filter /FlateDecode >>`, stream);
  });
  chunks.push(Buffer.from("trailer\n<< /Size 99 /Root 1 0 R >>\n%%EOF\n", "latin1"));
  return new Uint8Array(Buffer.concat(chunks));
}

/** Rapportens rader med några celler utbytta: `edit(text) → ny text`, eller null = ta bort. */
export function editLines(
  lines: readonly FixtureLine[],
  edit: (text: string, line: FixtureLine) => string | null | undefined,
): FixtureLine[] {
  return lines.flatMap((line): FixtureLine[] => {
    const cells = line[2].flatMap((c): (readonly [number, number, string])[] => {
      const next = edit(c[2], line);
      if (next === null) return [];
      return [next === undefined ? c : [c[0], c[1], next]];
    });
    return cells.length > 0 ? [[line[0], line[1], cells]] : [];
  });
}

/** Oktoberrapporten (./nayax-fixture.ts) som PDF. */
export function octoberPdf(): Uint8Array {
  return buildPdf(NAYAX_OCTOBER);
}
