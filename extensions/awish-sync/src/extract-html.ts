/**
 * HTML → ExtractedPage utan DOM: en tolerant tokeniserare för tabeller, länkar och
 * lösenordsfält. Används när offscreen-dokumentet (DOMParser, ./extract-dom.ts) inte går
 * att starta, och i enhetstesterna. Klarar celler med inbäddade taggar, <br>, entiteter,
 * thead/tbody, saknade sluttaggar för <td>/<tr> och flera tabeller på sidan (Bootstrap
 * Table och Layui ritar rubriken och raderna i två olika <table>).
 */

import type { ExtractedPage, Grid, PageLink } from "./reader.js";

const ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  yen: "¥",
  middot: "·",
  laquo: "«",
  raquo: "»",
  lsaquo: "‹",
  rsaquo: "›",
  hellip: "…",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code =
        e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

function attr(tag: string, name: string): string {
  const m = new RegExp(`\\s${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return decodeEntities(m?.[1] ?? m?.[2] ?? m?.[3] ?? "");
}

const BLOCK = new Set(["br", "p", "div", "li", "tr"]);

interface TableBuild {
  headerRows: string[][];
  bodyRows: string[][];
  inHead: boolean;
  row: string[] | null;
  rowIsHeader: boolean;
  cell: string[] | null;
}

function finishCell(t: TableBuild): void {
  if (t.cell && t.row) {
    t.row.push(t.cell.join(""));
  }
  t.cell = null;
}

function finishRow(t: TableBuild): void {
  finishCell(t);
  if (t.row && t.row.length > 0) {
    (t.inHead || t.rowIsHeader ? t.headerRows : t.bodyRows).push(t.row);
  }
  t.row = null;
  t.rowIsHeader = false;
}

function tidy(text: string): string {
  return text
    .replace(/[ \t\r\f\v ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Tolkar HTML till tabeller, länkar och lösenordsfält. */
export function extractHtml(html: string): ExtractedPage {
  // Kommentarer, skript och stilar tas bort först.
  const src = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|template|noscript)\b[\s\S]*?<\/\1\s*>/gi, "");
  const tables: Grid[] = [];
  const links: PageLink[] = [];
  const stack: TableBuild[] = [];
  let hasPasswordInput = false;
  let title = "";
  let inTitle = false;
  const text: string[] = [];
  let link: { href: string; rel: string; className: string; text: string[] } | null = null;
  let liClass = "";

  const pushText = (t: string) => {
    const top = stack[stack.length - 1];
    if (top?.cell) top.cell.push(t);
    if (link) link.text.push(t);
    if (inTitle) title += t;
    if (text.length < 4000) text.push(t);
  };

  const re = /<\/?([a-zA-Z][a-zA-Z0-9-]*)\b[^>]*>|([^<]+)|</g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src)) !== null) {
    if (m[2] !== undefined || m[0] === "<") {
      pushText(decodeEntities(m[2] ?? "<"));
      continue;
    }
    const tag = m[0];
    const name = (m[1] ?? "").toLowerCase();
    const closing = tag.startsWith("</");
    const top = stack[stack.length - 1];

    if (name === "title") {
      inTitle = !closing;
      continue;
    }
    if (name === "input" && !closing && attr(tag, "type").toLowerCase() === "password") {
      hasPasswordInput = true;
    }
    if (name === "li" && !closing) liClass = attr(tag, "class");
    if (name === "a") {
      if (!closing) {
        link = {
          href: attr(tag, "href"),
          rel: attr(tag, "rel"),
          className: `${attr(tag, "class")} ${liClass}`.trim(),
          text: [],
        };
      } else if (link) {
        links.push({
          href: link.href,
          rel: link.rel,
          className: link.className,
          text: tidy(link.text.join("")),
        });
        link = null;
      }
      continue;
    }
    if (name === "table") {
      if (!closing) {
        stack.push({
          headerRows: [],
          bodyRows: [],
          inHead: false,
          row: null,
          rowIsHeader: false,
          cell: null,
        });
      } else if (top) {
        finishRow(top);
        stack.pop();
        // Rubriken är sista raden med <th> (eller i <thead>). Utan rubrik avgör
        // normalizeTables i ./reader.ts om första raden är rubriken.
        const headers = top.headerRows[top.headerRows.length - 1] ?? [];
        tables.push({ headers: headers.map(tidy), rows: top.bodyRows.map((r) => r.map(tidy)) });
      }
      continue;
    }
    if (!top) {
      if (BLOCK.has(name)) pushText("\n");
      continue;
    }
    switch (name) {
      case "thead":
        if (closing) finishRow(top);
        top.inHead = !closing;
        break;
      case "tbody":
      case "tfoot":
        if (!closing) {
          finishRow(top);
          top.inHead = false;
        }
        break;
      case "tr":
        finishRow(top);
        if (!closing) top.row = [];
        break;
      case "th":
      case "td":
        finishCell(top);
        if (!closing) {
          if (!top.row) top.row = [];
          if (name === "th" && top.row.length === 0) top.rowIsHeader = true;
          if (name === "td") top.rowIsHeader = false;
          top.cell = [];
        }
        break;
      default:
        if (BLOCK.has(name)) pushText("\n");
    }
  }
  return {
    tables,
    links,
    hasPasswordInput,
    title: tidy(title),
    text: tidy(text.join(" ")).slice(0, 20_000),
  };
}
