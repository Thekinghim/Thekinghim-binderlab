/**
 * Sidans stora rubrik: första heltalet i meningen räknas upp. Ren och klientsäker.
 * "Beställ 3 titlar för ca 1 100 kr." → { before: "Beställ ", value: 3, after: " titlar …" }.
 */

const NUMBER = /\d{1,3}(?:[   ]\d{3})+(?!\d)|\d+/;

export interface HeadNumber {
  readonly before: string;
  readonly value: number | null;
  readonly after: string;
}

export function splitHeadNumber(text: string): HeadNumber {
  const m = NUMBER.exec(text);
  if (!m) return { before: text, value: null, after: "" };
  const value = Number(m[0].replace(/[   ]/g, ""));
  if (!Number.isSafeInteger(value)) return { before: text, value: null, after: "" };
  return {
    before: text.slice(0, m.index),
    value,
    after: text.slice(m.index + m[0].length),
  };
}
