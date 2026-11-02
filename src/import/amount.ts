/**
 * Belopp från källan till öre, helt utan flyttal (ren strängtolkning).
 *
 * Godkänt: "170", "170.00", "170,00", "170.5", "1 234,50", "1,234.50",
 * "1.234,50", "1 234", "Amount: 170.00", "SEK 170", "170 kr", "170:-".
 * En cell med flera märkta belopp ("Amount: 170.00\nDiscount: 0.00") ger
 * beloppet märkt exakt "Amount:" eller "Order Amount:" (inte "Discount
 * Amount:", "Refund Amount:" eller "Paid Amount:").
 *
 * Nekas: negativa belopp, fler än två decimaler, tvetydiga tal som "1,234"
 * (tusental eller tre decimaler?), andra valutor och allt annat som inte är
 * ett tydligt belopp. Hellre en felrad i importloggen än ett belopp som är
 * fel med en faktor 1 000.
 */

export type AmountResult = { ok: true; ore: number } | { ok: false; message: string };

/** Övre gräns per order (10 miljoner kr): ett större belopp är ett tolkningsfel. */
export const MAX_AMOUNT_ORE = 1_000_000_000;

// Mellanslag som används som tusentalsavgränsare: vanligt, hårt (NBSP),
// smalt hårt (U+202F) och tunt (U+2009).
const GROUP_SPACES = /[ \u00a0\u202f\u2009]/g;
const HAS_GROUP_SPACE = /[ \u00a0\u202f\u2009]/;
const MINUS = /^[-\u2212\u2013]/;

function fail(message: string): AmountResult {
  return { ok: false, message };
}

/**
 * Plockar ut beloppet märkt exakt "Amount:" eller "Order Amount:" ur en cell
 * med flera märkta belopp. Etiketten måste stå först på sin rad i cellen (eller
 * efter ; eller |), så att "Discount Amount:", "Refund Amount:" och
 * "Paid Amount:" aldrig tas för orderbeloppet. Finns flera sådana etiketter
 * med olika värden är cellen tvetydig och blir en felrad.
 */
function extractLabelled(text: string): { ok: true; text: string } | { ok: false } {
  const values: string[] = [];
  for (const segment of text.split(/[\n\r;|]/)) {
    const match = /^\s*(?:order\s*)?amount\s*[:：]\s*(.*)$/i.exec(segment);
    if (match) {
      // Stanna vid nästa etikett på samma rad ("Amount: 170.00 Paid: 170.00").
      values.push((match[1] ?? "").replace(/\s+[A-Za-z][A-Za-z ]*[:：].*$/, "").trim());
    }
  }
  if (values.length === 0) {
    return { ok: true, text };
  }
  const distinct = [...new Set(values)];
  if (distinct.length > 1) {
    return { ok: false };
  }
  return { ok: true, text: distinct[0] ?? "" };
}

function stripCurrency(text: string): string | null {
  let s = text.trim();
  // Prefix: "SEK 170", "kr 170".
  s = s.replace(/^(?:sek|kr)\.?\s*/i, "");
  // Suffix: "170 kr", "170 kr.", "170 SEK", "170:-", "170 :-".
  s = s.replace(/\s*(?:sek|kr\.?|:-)$/i, "");
  s = s.trim();
  if (/[a-z¥$€£]/i.test(s)) {
    return null;
  }
  return s;
}

/** "170,50" → 17050. Returnerar ett felmeddelande på svenska vid tveksamhet. */
export function parseAmountOre(input: string | null | undefined): AmountResult {
  if (input === null || input === undefined) {
    return fail("Belopp saknas.");
  }
  const original = String(input);
  if (original.trim() === "") {
    return fail("Belopp saknas.");
  }

  const labelled = extractLabelled(original);
  if (!labelled.ok) {
    return fail(`Flera olika belopp märkta "Amount:" i "${original.trim()}".`);
  }
  const stripped = stripCurrency(labelled.text);
  if (stripped === null) {
    return fail(`Okänd valuta eller text i beloppet "${original.trim()}".`);
  }
  let s = stripped;
  if (s === "") {
    return fail("Belopp saknas.");
  }
  if (MINUS.test(s) || /^\(.*\)$/.test(s) || s.endsWith("-")) {
    return fail(`Negativa belopp tas inte emot ("${original.trim()}").`);
  }
  if (s.startsWith("+")) {
    s = s.slice(1);
  }

  // Mellanslag får bara stå mellan siffergrupper om tre ("1 234 567").
  if (HAS_GROUP_SPACE.test(s)) {
    const [intPart = "", ...rest] = s.split(/[.,]/);
    const spaced = intPart.split(GROUP_SPACES);
    if (rest.some((r) => HAS_GROUP_SPACE.test(r))) {
      return fail(`Kan inte tolka beloppet "${original.trim()}".`);
    }
    const [head = "", ...groups] = spaced;
    if (!/^\d{1,3}$/.test(head) || groups.some((g) => !/^\d{3}$/.test(g))) {
      return fail(`Kan inte tolka beloppet "${original.trim()}".`);
    }
    s = s.replace(GROUP_SPACES, "");
  }

  if (!/^[\d.,]+$/.test(s) || !/\d/.test(s)) {
    return fail(`Kan inte tolka beloppet "${original.trim()}".`);
  }

  const commas = (s.match(/,/g) ?? []).length;
  const dots = (s.match(/\./g) ?? []).length;
  let integerPart: string;
  let decimalPart = "";

  if (commas > 0 && dots > 0) {
    // Båda förekommer: den sista är decimaltecknet, den andra tusental.
    const decimalSep = s.lastIndexOf(",") > s.lastIndexOf(".") ? "," : ".";
    const groupSep = decimalSep === "," ? "." : ",";
    const decimalCount = decimalSep === "," ? commas : dots;
    if (decimalCount !== 1) {
      return fail(`Kan inte tolka beloppet "${original.trim()}".`);
    }
    const idx = s.lastIndexOf(decimalSep);
    integerPart = s.slice(0, idx);
    decimalPart = s.slice(idx + 1);
    const groups = integerPart.split(groupSep);
    const [head = "", ...tail] = groups;
    if (!/^\d{1,3}$/.test(head) || tail.some((g) => !/^\d{3}$/.test(g))) {
      return fail(`Kan inte tolka beloppet "${original.trim()}".`);
    }
    integerPart = groups.join("");
  } else if (commas + dots === 0) {
    integerPart = s;
  } else {
    const sep = commas > 0 ? "," : ".";
    const count = commas + dots;
    const parts = s.split(sep);
    if (count === 1) {
      const [a = "", b = ""] = parts;
      if (b.length === 3) {
        return fail(
          `Tvetydigt belopp "${original.trim()}": tusentalsavgränsare eller tre decimaler?`,
        );
      }
      integerPart = a;
      decimalPart = b;
    } else {
      // Flera av samma tecken: bara tusentalsgrupper ("1.234.567").
      const [head = "", ...tail] = parts;
      if (!/^\d{1,3}$/.test(head) || tail.some((g) => !/^\d{3}$/.test(g))) {
        return fail(`Kan inte tolka beloppet "${original.trim()}".`);
      }
      integerPart = parts.join("");
    }
  }

  if (integerPart === "") {
    integerPart = "0";
  }
  if (!/^\d+$/.test(integerPart) || (decimalPart !== "" && !/^\d+$/.test(decimalPart))) {
    return fail(`Kan inte tolka beloppet "${original.trim()}".`);
  }
  if (decimalPart.length > 2) {
    return fail(`För många decimaler i beloppet "${original.trim()}" (högst två).`);
  }
  if (s.endsWith(",") || s.endsWith(".")) {
    return fail(`Kan inte tolka beloppet "${original.trim()}".`);
  }

  const kronor = integerPart.replace(/^0+(?=\d)/, "");
  if (kronor.length > 13) {
    return fail(`Beloppet "${original.trim()}" är orimligt stort.`);
  }
  const ore = Number(kronor) * 100 + Number(decimalPart.padEnd(2, "0"));
  if (!Number.isSafeInteger(ore) || ore > MAX_AMOUNT_ORE) {
    return fail(`Beloppet "${original.trim()}" är orimligt stort.`);
  }
  return { ok: true, ore };
}
