/** Ren hjälpfunktion för MerHead (klientsäker, testas i split-number.test.ts). */

/**
 * Första fristående heltalet i rubriken ("2 personer har tillgång." → "", 2, " personer …").
 * Siffror som sitter ihop med bokstäver (ett namn som "wille1452", "BL-001") är inte tal och
 * räknas aldrig upp eller får tusentalsavgränsare.
 */
const NUMBER = /(?<![\p{L}\d_-])(?:\d{1,3}(?:[   ]\d{3})+|\d+)(?![\p{L}\d_])/u;

export function splitFirstNumber(text: string): {
  before: string;
  value: number | null;
  after: string;
} {
  const m = NUMBER.exec(text);
  if (!m) return { before: text, value: null, after: "" };
  const value = Number(m[0].replace(/[   ]/g, ""));
  if (!Number.isSafeInteger(value)) return { before: text, value: null, after: "" };
  return { before: text.slice(0, m.index), value, after: text.slice(m.index + m[0].length) };
}
