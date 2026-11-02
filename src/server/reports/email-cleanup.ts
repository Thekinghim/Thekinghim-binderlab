/**
 * Städar det renderade rapportmejlet från fält som Binderlab saknar underlag för.
 *
 * Mallen i src/emails kräver fält som inte räknas fram än (andel i drift, avbrott, nästa
 * besök, avsändarens postadress, kassaflöde). Vi fyller dem aldrig med påhittade värden;
 * de blir "–" i mallen, och här tas de raderna bort helt så att mejlet till en extern
 * mottagare inte ser ofärdigt ut. Både HTML-delen och textdelen städas, med samma regler:
 *
 * - en rad (etikett + värde) vars värde saknas tas bort,
 * - en kolumn där alla värden saknas tas bort,
 * - en sektion som blir tom tas bort, och sektionerna numreras om,
 * - "–" i sidfotens avsändarrad tas bort.
 *
 * Ren modul utan DOM: HTML:en kommer från mallens renderToStaticMarkup och har en känd,
 * deterministisk form. Körs både i webbläsaren (/rapport/[id]/epost) och på servern.
 */

const DASH = "–";

/** Sant när texten innehåller ett saknat värde: ett fristående "–" (inte "12–15"). */
export function hasMissing(text: string): boolean {
  return /(^|[\s,(])–(?=$|[\s,.)])/.test(text);
}

/** Etiketter i "Drift och service" som alltid saknar underlag (inga avbrott registreras). */
const UNSUPPORTED_FACTS = new Set(["avbrott"]);

// ---------------------------------------------------------------------------
// HTML
// ---------------------------------------------------------------------------

interface Element {
  readonly name: string;
  /** Index för `<` i starttaggen. */
  readonly start: number;
  /** Index efter starttaggens `>`. */
  readonly openEnd: number;
  /** Index för `<` i sluttaggen. */
  closeStart: number;
  /** Index efter sluttaggens `>`. */
  end: number;
  readonly parent: Element | null;
  readonly children: Element[];
}

const TAG = /<(\/?)(table|thead|tbody|tr|td|th)\b[^>]*>/gi;

/** Tabellelementen i dokumentet som ett träd (bara table/thead/tbody/tr/td/th). */
function parseTables(html: string): Element[] {
  const roots: Element[] = [];
  const stack: Element[] = [];
  for (const m of html.matchAll(TAG)) {
    const name = m[2]!.toLowerCase();
    const at = m.index!;
    if (m[1] === "") {
      const parent = stack[stack.length - 1] ?? null;
      const el: Element = {
        name,
        start: at,
        openEnd: at + m[0].length,
        closeStart: -1,
        end: -1,
        parent,
        children: [],
      };
      (parent ? parent.children : roots).push(el);
      stack.push(el);
    } else {
      // Stäng närmaste öppna element med samma namn (HTML:en är välformad).
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i]!.name === name) {
          const el = stack[i]!;
          el.closeStart = at;
          el.end = at + m[0].length;
          stack.length = i;
          break;
        }
      }
    }
  }
  return roots;
}

function walk(els: readonly Element[], fn: (el: Element) => void): void {
  for (const el of els) {
    fn(el);
    walk(el.children, fn);
  }
}

function decode(text: string): string {
  return text
    .replace(/&nbsp;|&#xA0;|&#160;/gi, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'");
}

function textOf(html: string, el: Element): string {
  return decode(html.slice(el.openEnd, el.closeStart).replace(/<[^>]+>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

function cut(html: string, ranges: readonly (readonly [number, number])[]): string {
  const sorted = [...ranges].sort((a, b) => b[0] - a[0]);
  let out = html;
  let floor = Number.POSITIVE_INFINITY;
  for (const [a, b] of sorted) {
    if (b > floor) continue; // redan bortklippt inuti ett större intervall
    out = out.slice(0, a) + out.slice(b);
    floor = a;
  }
  return out;
}

const cells = (tr: Element) => tr.children.filter((c) => c.name === "td" || c.name === "th");
const rowsOf = (section: Element) => section.children.filter((c) => c.name === "tr");

/** Rader med etikett + värde där värdet saknas, och kolumner där alla värden saknas. */
function removeMissingRowsAndColumns(html: string): string {
  const ranges: [number, number][] = [];
  walk(parseTables(html), (el) => {
    if (el.name === "tr") {
      const c = cells(el);
      if (c.length === 2 && c[0]!.name === "td" && c[1]!.name === "td") {
        const label = textOf(html, c[0]!);
        const value = textOf(html, c[1]!);
        if (
          label.length > 0 &&
          label.length <= 40 &&
          (hasMissing(value) || UNSUPPORTED_FACTS.has(label.toLocaleLowerCase("sv-SE")))
        ) {
          ranges.push([el.start, el.end]);
        }
      }
    }
    if (el.name === "table") {
      const head = el.children.find((c) => c.name === "thead");
      const body = el.children.find((c) => c.name === "tbody");
      if (!head || !body) return;
      const headRow = rowsOf(head)[0];
      const bodyRows = rowsOf(body);
      if (!headRow || bodyRows.length === 0) return;
      const headCells = cells(headRow);
      for (let i = 1; i < headCells.length; i++) {
        const all = bodyRows.every((r) => {
          const cell = cells(r)[i];
          return cell !== undefined && textOf(html, cell) === DASH;
        });
        if (!all) continue;
        ranges.push([headCells[i]!.start, headCells[i]!.end]);
        for (const r of bodyRows) {
          const cell = cells(r)[i]!;
          ranges.push([cell.start, cell.end]);
        }
      }
    }
  });
  return cut(html, ranges);
}

const SECTION_LABEL = /^\d{2} \/ /;

/** Sektioner (rubrik + innehåll) vars innehåll blivit tomt, t.ex. kassaflödet. */
function removeEmptySections(html: string): string {
  const ranges: [number, number][] = [];
  walk(parseTables(html), (el) => {
    if (el.name !== "td") return;
    const tables = el.children.filter((c) => c.name === "table");
    if (tables.length < 2) return;
    const [label, ...content] = tables;
    if (!SECTION_LABEL.test(textOf(html, label!))) return;
    const empty = content.every((t) => {
      let rows = 0;
      walk(t.children, (x) => {
        if (x.name === "tr") rows += 1;
      });
      return rows === 0;
    });
    if (empty && el.parent?.name === "tr") ranges.push([el.parent.start, el.parent.end]);
  });
  return cut(html, ranges);
}

/** Numrerar sektionsrubrikerna "01 / …" i ordning. */
function renumberSections(html: string): string {
  let n = 0;
  return html.replace(
    /(<span[^>]*>)(\d{2})(<\/span><span[^>]*> \/ <\/span>)/g,
    (_m, open: string, _num: string, rest: string) => {
      n += 1;
      return `${open}${String(n).padStart(2, "0")}${rest}`;
    },
  );
}

/** Sidfotens "Namn · – · e-post" utan den saknade postadressen. */
function cleanFooter(html: string): string {
  return html.replace(/ · – · /g, " · ");
}

/** Vilken sorts mejl. Bokföringsunderlaget städas bara i sidfoten: där betyder "–" i en
 * kontorad att kontot saknas i kontoplanen, och det ska bokhållaren se. */
export type CleanupKind = "butik" | "bokforing" | "delagare";

/** Mejlets HTML utan rader, kolumner och sektioner som saknar underlag. */
export function cleanEmailHtml(html: string, kind: CleanupKind): string {
  const footer = cleanFooter(html);
  if (kind === "bokforing") return footer;
  return renumberSections(removeEmptySections(removeMissingRowsAndColumns(footer)));
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const TEXT_HEADING = /^(\d{2}) \/ (.+)$/;

/** Sektioner i textdelen där rader med saknat värde tas bort (versaler, som i texten). */
const TEXT_FACT_SECTIONS = new Set(["DRIFT OCH SERVICE", "VINST", "KASSAFLÖDE"]);

/** Textdelen med samma regler som HTML-delen. */
export function cleanEmailText(text: string, kind: CleanupKind): string {
  if (kind === "bokforing") return text.replace(/ · – · /g, " · ");
  const all = text.split("\n");
  // Länken till rapporten och sidfoten hör inte till sista sektionen.
  let cta = -1;
  all.forEach((line, i) => {
    if (/^Öppna (rapporten|underlaget|butiksportalen): /.test(line)) cta = i;
  });
  const trailerStart = cta > 0 && all[cta - 1] === "" ? cta - 1 : cta;
  const lines = trailerStart >= 0 ? all.slice(0, trailerStart) : all;
  const trailer = trailerStart >= 0 ? all.slice(trailerStart) : [];
  // Dela upp i block: inledning, sedan en sektion per rubrik.
  const blocks: { heading: string | null; lines: string[] }[] = [{ heading: null, lines: [] }];
  for (const line of lines) {
    if (TEXT_HEADING.test(line)) blocks.push({ heading: line, lines: [] });
    else blocks[blocks.length - 1]!.lines.push(line);
  }
  const out: string[] = [];
  let n = 0;
  for (const block of blocks) {
    const title = block.heading ? TEXT_HEADING.exec(block.heading)![2]! : null;
    const facts = title !== null && TEXT_FACT_SECTIONS.has(title);
    const kept = block.lines
      // Kolumnen "i drift" saknar underlag på varje rad i tabellen per automat.
      .map((line) => (title === "PER AUTOMAT" ? line.replace(/, i drift –(?=,|$)/g, "") : line))
      .filter((line) => {
        if (!facts) return true;
        const m = /^([^:]{1,40}): (.*)$/.exec(line);
        if (!m) return true;
        if (UNSUPPORTED_FACTS.has(m[1]!.trim().toLocaleLowerCase("sv-SE"))) return false;
        return !hasMissing(m[2]!);
      });
    if (title === null) {
      out.push(...kept);
      continue;
    }
    if (kept.every((l) => l.trim() === "")) continue;
    n += 1;
    out.push(`${String(n).padStart(2, "0")} / ${title}`, ...kept);
  }
  out.push(...trailer.map((line) => line.replace(/ · – · /g, " · ")));
  return out.join("\n").replace(/\n{3,}/g, "\n\n");
}
