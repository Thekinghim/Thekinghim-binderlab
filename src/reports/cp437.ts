/**
 * Kodning till och från teckentabellen CP437 ("PC8"), som SIE-filer använder.
 *
 * Tecken 0x00–0x7F är ASCII. Tecknen 0x80–0xFF har egna positioner i CP437, t.ex.
 * å = 0x86, ä = 0x84, ö = 0x94, Å = 0x8F, Ä = 0x8E, Ö = 0x99, é = 0x82.
 * Hårt mellanslag och smala mellanslag skrivs som vanligt mellanslag, minustecken
 * (U+2212) och tankstreck som bindestreck. Tecken som saknas i CP437 skrivs som "?".
 */

/** Tecknen 0x80–0xFF i CP437, i ordning. */
const HIGH =
  "ÇüéâäàåçêëèïîìÄÅ" +
  "ÉæÆôöòûùÿÖÜ¢£¥₧ƒ" +
  "áíóúñÑªº¿⌐¬½¼¡«»" +
  "░▒▓│┤╡╢╖╕╣║╗╝╜╛┐" +
  "└┴┬├─┼╞╟╚╔╩╦╠═╬╧" +
  "╨╤╥╙╘╒╓╫╪┘┌█▄▌▐▀" +
  "αßΓπΣσµτΦΘΩδ∞φε∩" +
  "≡±≥≤⌠⌡÷≈°∙·√ⁿ²■ ";

const ENCODE = new Map<string, number>();
for (let i = 0; i < HIGH.length; i++) ENCODE.set(HIGH[i]!, 0x80 + i);

/** Ersättningar före kodning (tecken som bör bli ASCII i en SIE-fil). */
const REPLACE: Record<string, string> = {
  " ": " ",
  " ": " ",
  " ": " ",
  "−": "-",
  "–": "-",
  "—": "-",
  "‘": "'",
  "’": "'",
  "“": '"',
  "”": '"',
};

/** Kodar text som CP437. Tecken utanför tabellen blir "?" (0x3F). */
export function encodeCp437(text: string): Buffer {
  const bytes: number[] = [];
  for (const raw of text.normalize("NFC")) {
    const ch = REPLACE[raw] ?? raw;
    const code = ch.codePointAt(0)!;
    if (code < 0x80) bytes.push(code);
    else bytes.push(ENCODE.get(ch) ?? 0x3f);
  }
  return Buffer.from(bytes);
}

/** Avkodar CP437 till text (för tester och inläsning). */
export function decodeCp437(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b < 0x80 ? String.fromCharCode(b) : HIGH[b - 0x80]!;
  return out;
}
