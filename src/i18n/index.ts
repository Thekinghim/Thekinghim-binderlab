/**
 * Texter per språk: `messages(locale)` ger katalogen (typad, samma nycklar på båda
 * språken). Klientsäkert. På servern: getT() i ./server. I klientkomponenter: useT() i
 * ./client.
 */

import { en } from "./en";
import { sv, type Messages } from "./sv";
import type { Locale } from "./locale";

export type { Messages } from "./sv";
export * from "./locale";
export { formatters, type Formatters } from "./format";

const CATALOGS: Record<Locale, Messages> = { sv, en };

export function messages(locale: Locale): Messages {
  return CATALOGS[locale];
}
