/**
 * Svenska företagsuppgifter: organisationsnummer, momsregistreringsnummer, bankgiro och
 * postnummer. Tolkar det någon skriver (med eller utan bindestreck och mellanslag) och
 * ger den normaliserade formen som sparas. Rena funktioner, testas i swedish-ids.test.ts.
 */

export type IdParse = { ok: true; value: string } | { ok: false; message: string };

/** Luhn (mod 10) över siffrorna: sant om kontrollsiffran (sista) stämmer. */
export function luhnValid(digits: string): boolean {
  if (!/^\d+$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/**
 * Organisationsnummer → "NNNNNN-NNNN". Tar emot 10 siffror (556677-8899, 5566778899) och
 * 12 siffror med sekel eller 16-prefix (16556677-8899, 19800101-1234 för en enskild firma,
 * som har ägarens personnummer). Kontrollsiffran måste stämma.
 */
export function parseOrgNumber(raw: string | null | undefined): IdParse {
  const s = (raw ?? "").replace(/[\s-]/g, "");
  if (s === "") return { ok: false, message: "Ange organisationsnumret." };
  if (!/^\d+$/.test(s) || (s.length !== 10 && s.length !== 12)) {
    return { ok: false, message: "Organisationsnummer skrivs NNNNNN-NNNN." };
  }
  const ten = s.length === 12 ? s.slice(2) : s;
  if (s.length === 12 && !/^(16|18|19|20)$/.test(s.slice(0, 2))) {
    return { ok: false, message: "Organisationsnummer skrivs NNNNNN-NNNN." };
  }
  if (!luhnValid(ten)) {
    return { ok: false, message: "Organisationsnumret stämmer inte. Kontrollera siffrorna." };
  }
  return { ok: true, value: `${ten.slice(0, 6)}-${ten.slice(6)}` };
}

/** Momsregistreringsnumret som hör till ett organisationsnummer: SE + 10 siffror + 01. */
export function vatFromOrgNumber(orgNumber: string): string | null {
  const parsed = parseOrgNumber(orgNumber);
  return parsed.ok ? `SE${parsed.value.replace("-", "")}01` : null;
}

/**
 * Momsregistreringsnummer → "SE556677889901". Tomt = null (valfritt). Mellanslag och
 * bindestreck tas bort, "se" blir "SE". De tio siffrorna är ett organisationsnummer.
 */
export function parseVatNumber(
  raw: string | null | undefined,
): IdParse | { ok: true; value: null } {
  const s = (raw ?? "").replace(/[\s-]/g, "").toUpperCase();
  if (s === "") return { ok: true, value: null };
  const m = /^SE(\d{10})01$/.exec(s);
  if (!m) {
    return { ok: false, message: "Momsregistreringsnummer skrivs SE, tio siffror och 01." };
  }
  if (!luhnValid(m[1]!)) {
    return { ok: false, message: "Momsregistreringsnumret stämmer inte. Kontrollera siffrorna." };
  }
  return { ok: true, value: s };
}

/** Bankgiro → "NNN-NNNN" eller "NNNN-NNNN". Tomt = null. Kontrollsiffran måste stämma. */
export function parseBankgiro(raw: string | null | undefined): IdParse | { ok: true; value: null } {
  const s = (raw ?? "").replace(/[\s-]/g, "");
  if (s === "") return { ok: true, value: null };
  if (!/^\d{7,8}$/.test(s)) {
    return { ok: false, message: "Bankgiro skrivs NNN-NNNN eller NNNN-NNNN." };
  }
  if (!luhnValid(s)) {
    return { ok: false, message: "Bankgironumret stämmer inte. Kontrollera siffrorna." };
  }
  return { ok: true, value: `${s.slice(0, -4)}-${s.slice(-4)}` };
}

/** Postnummer → "NNN NN". Tomt = null. */
export function parsePostalCode(
  raw: string | null | undefined,
): IdParse | { ok: true; value: null } {
  const s = (raw ?? "").replace(/\s/g, "");
  if (s === "") return { ok: true, value: null };
  if (!/^\d{5}$/.test(s)) return { ok: false, message: "Postnummer skrivs NNN NN." };
  return { ok: true, value: `${s.slice(0, 3)} ${s.slice(3)}` };
}
