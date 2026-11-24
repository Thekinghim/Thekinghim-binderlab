/**
 * Dokumentationen (AW-DOC-110 v1.2.41) och proto-filen säger olika fältnummer för timestamp
 * och sign i sju skrivningar: dokumentationen 10 och 11, proto-filen lägre nummer.
 *
 *   meddelande                         proto   dokumentationen
 *   UpdateMerchantRequest               6/7     10/11
 *   PowerControlRequest (ControlPower)  3/4     10/11
 *   PowerScheduleRequest                5/6     10/11
 *   ShipmentRequest (ExecuteShipment)   8/9     10/11
 *   UpdateProductRequest                6/7     10/11
 *   BatchUpdateProductRequest           6/7     10/11
 *   ReplenishProductInventoryRequest    3/4     10/11
 *
 * Övriga fält har samma nummer i båda, och ingen av dem använder 10 eller 11 till något
 * annat. Vi vet inte vilken numrering Awishs server följer, så de här meddelandena får två
 * extra fält, doc_timestamp = 10 och doc_sign = 11, och samma timestamp och signatur skickas
 * på båda ställena (AWISH_SIGN_FIELDS=both, standard). En server som följer den ena
 * numreringen ser det andra paret som okända fält och hoppar över dem. Signaturen beräknas
 * på samma request_body i båda fallen (sign och timestamp räknas aldrig med).
 *
 * AWISH_SIGN_FIELDS=proto skickar bara proto-filens nummer, =doc bara dokumentationens.
 */

export const DOC_SIGN_FIELD_MESSAGES: readonly string[] = [
  "UpdateMerchantRequest",
  "PowerControlRequest",
  "PowerScheduleRequest",
  "ShipmentRequest",
  "UpdateProductRequest",
  "BatchUpdateProductRequest",
  "ReplenishProductInventoryRequest",
];

export const DOC_TIMESTAMP_FIELD = "doc_timestamp";
export const DOC_SIGN_FIELD = "doc_sign";

export type AwishSignFields = "both" | "proto" | "doc";

export function signFieldsFromEnv(
  env: Record<string, string | undefined> = process.env,
): AwishSignFields {
  const raw = (env.AWISH_SIGN_FIELDS ?? "").trim().toLowerCase();
  return raw === "proto" || raw === "doc" ? raw : "both";
}

/** Proto-texten med doc_timestamp = 10 och doc_sign = 11 i de sju meddelandena. */
export function withDocSignFields(proto: string): string {
  let out = proto;
  for (const name of DOC_SIGN_FIELD_MESSAGES) {
    const start = out.indexOf(`message ${name} {`);
    if (start < 0) throw new Error(`proto saknar ${name}.`);
    // Meddelandets slut: första "}" i början av en rad (nästlade enum är indragna).
    const end = out.indexOf("\n}", start);
    if (end < 0) throw new Error(`proto: ${name} saknar slut.`);
    const body = out.slice(start, end);
    if (/=\s*10\s*;|=\s*11\s*;/.test(body)) {
      throw new Error(`proto: ${name} använder redan fält 10 eller 11.`);
    }
    out = `${out.slice(0, end)}\n\n\tint64 ${DOC_TIMESTAMP_FIELD} = 10;\n\n\tstring ${DOC_SIGN_FIELD} = 11;${out.slice(end)}`;
  }
  return out;
}
