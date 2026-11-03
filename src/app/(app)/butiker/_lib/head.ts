/**
 * Första heltalet i en rubrik ("2 av 3 butiker …" → före "", 2, efter " av 3 …"), så att
 * det kan räkna upp. Tusental med mellanslag räknas som ett tal. Rent och klientsäkert.
 */

const NUMBER = /\d{1,3}(?:[   ]\d{3})+(?!\d)|\d+/;

export function splitNumber(text: string): {
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
