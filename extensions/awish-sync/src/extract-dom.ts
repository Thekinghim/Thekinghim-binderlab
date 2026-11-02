/**
 * Document → ExtractedPage med webbläsarens egen HTML-tolkning. Körs
 * - i tilläggets offscreen-dokument (./offscreen.ts) på HTML som hämtats med fetch,
 *   eftersom en service worker inte har DOMParser;
 * - i en öppen Awish-flik via chrome.scripting.executeScript (reserven i ./awish.ts),
 *   på den färdigritade sidan.
 * Samma utdata som tokeniseraren i ./extract-html.ts.
 *
 * extractDocument är självständig (inga hjälpfunktioner utanför den), eftersom
 * chrome.scripting serialiserar funktionen och kör den i fliken. Utan argument läses
 * flikens eget dokument.
 */

import type { ExtractedPage } from "./reader.js";

export function extractDocument(doc: Document = document): ExtractedPage {
  /** Cellens text med radbrytningar för <br> och block, utan skript och dolda element. */
  const cellText = (el: Element): string => {
    const parts: string[] = [];
    const walk = (node: Node) => {
      if (node.nodeType === 3) {
        parts.push(node.textContent ?? "");
        return;
      }
      if (node.nodeType !== 1) return;
      const e = node as Element;
      const tag = e.tagName.toLowerCase();
      if (tag === "script" || tag === "style" || tag === "template") return;
      if (
        e.getAttribute("hidden") !== null ||
        /display\s*:\s*none/i.test(e.getAttribute("style") ?? "")
      ) {
        return;
      }
      if (tag === "br") parts.push("\n");
      const block = ["div", "p", "li"].includes(tag);
      if (block) parts.push("\n");
      e.childNodes.forEach(walk);
      if (block) parts.push("\n");
    };
    el.childNodes.forEach(walk);
    return parts
      .join("")
      .replace(/[ \t\r\f\v ]+/g, " ")
      .replace(/ *\n */g, "\n")
      .replace(/\n{2,}/g, "\n")
      .trim();
  };

  const rowsOf = (section: Element | null, table: HTMLTableElement): HTMLTableRowElement[] => {
    const all = Array.from((section ?? table).querySelectorAll("tr"));
    // Bara raderna i den här tabellen, inte i tabeller inuti cellerna.
    return all.filter((tr) => tr.closest("table") === table) as HTMLTableRowElement[];
  };

  const cells = (tr: HTMLTableRowElement): Element[] =>
    Array.from(tr.children).filter((c) => /^(td|th)$/i.test(c.tagName));

  const tables: ExtractedPage["tables"] = [];
  for (const table of Array.from(doc.querySelectorAll("table"))) {
    const t = table as HTMLTableElement;
    const head = t.tHead;
    const headRows = head ? rowsOf(head, t) : [];
    const all = rowsOf(null, t);
    let headerRow = headRows[headRows.length - 1] ?? null;
    if (!headerRow) {
      const first = all[0];
      if (
        first &&
        cells(first).length > 0 &&
        cells(first).every((c) => c.tagName.toLowerCase() === "th")
      ) {
        headerRow = first;
      }
    }
    const body = all.filter((tr) => tr !== headerRow && !headRows.includes(tr));
    tables.push({
      headers: headerRow ? cells(headerRow).map(cellText) : [],
      rows: body.map((tr) => cells(tr).map(cellText)).filter((r) => r.length > 0),
    });
  }
  const links: ExtractedPage["links"] = Array.from(doc.querySelectorAll("a[href]")).map((a) => ({
    href: a.getAttribute("href") ?? "",
    text: (a.textContent ?? "").replace(/\s+/g, " ").trim(),
    rel: a.getAttribute("rel") ?? "",
    className:
      `${a.getAttribute("class") ?? ""} ${a.closest("li")?.getAttribute("class") ?? ""}`.trim(),
  }));
  return {
    tables,
    links,
    hasPasswordInput: doc.querySelector('input[type="password" i]') !== null,
    title: (doc.title ?? "").trim(),
    text: (doc.body?.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 20_000),
  };
}
