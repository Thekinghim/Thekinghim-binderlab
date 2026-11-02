/**
 * Kontraktet mellan sökningen på servern (GET /sok) och kommandopaletten.
 *
 * Ren data utan serverberoenden, så att klienten kan importera typerna. Allt som
 * visas är redan formaterat på servern (datum i organisationens tidszon, belopp i
 * kronor) och filtrerat på rollen: en påfyllare får aldrig order eller belopp.
 */

/** Vad en träff är. */
export type SearchKind = "order" | "title" | "machine" | "store";

/**
 * Vilka av skalets parametrar som följer med länken: "all" = period och filter,
 * "period" = bara perioden (länken sätter eget filter), "none" = inget.
 */
export type CarryMode = "all" | "period" | "none";

/** En träff i sökningen. */
export interface SearchHit {
  /** Unikt i svaret, t.ex. "order:<uuid>". */
  readonly id: string;
  readonly kind: SearchKind;
  /** Postens id i databasen. */
  readonly entityId: string;
  /** Huvudtexten, t.ex. titelns namn eller "BL-002 Mobilia". */
  readonly label: string;
  /** Kort id i mono före etiketten, t.ex. ordernumret "42780". */
  readonly code?: string;
  /** Metadata i mono till höger, t.ex. ["BL-001", "1 nov. 17:17", "170 kr"]. */
  readonly meta: readonly string[];
  /** Söks men visas inte (ort, serie, alias). */
  readonly keywords?: readonly string[];
  /** Vart träffen leder. Saknas när träffen startar ett steg i paletten (`step`). */
  readonly href?: string;
  readonly carry: CarryMode;
  /**
   * Träffen öppnar ett steg i paletten i stället för en sida. "refill-machine": välj
   * automat för påfyllning av titeln (påfyllarens titelträffar).
   */
  readonly step?: "refill-machine";
}

export interface SearchGroup {
  readonly kind: SearchKind;
  /** Gruppens rubrik: "Order", "Titlar", "Automater", "Butiker". */
  readonly label: string;
  readonly hits: readonly SearchHit[];
  /** Länk till alla träffar (orderlistan med samma sökning), om det finns fler. */
  readonly more?: { readonly label: string; readonly href: string };
}

export interface SearchResponse {
  /** Söktexten som den tolkades (trimmad, kapad). */
  readonly query: string;
  readonly groups: readonly SearchGroup[];
}

/** En rad i ett steg (välj titel för påfyllning eller inköpspris). */
export interface PickItem {
  readonly id: string;
  readonly label: string;
  readonly meta: readonly string[];
  readonly keywords?: readonly string[];
}

export interface PickGroup {
  readonly label: string;
  readonly items: readonly PickItem[];
}

/** Listorna paletten kan hämta för ett steg. */
export type PickList = "pafyllning" | "inkopspris";

export interface PickResponse {
  readonly list: PickList;
  readonly groups: readonly PickGroup[];
}

/** Längsta söktext som används; resten kapas. */
export const MAX_SEARCH_LENGTH = 100;
/** Flest sökord. Varje ord måste träffa ordern. */
export const MAX_SEARCH_TERMS = 6;
/** Flest träffar per grupp. */
export const HITS_PER_GROUP = 5;
/** Kortaste sökord som söker i order (kortare ord kan inte använda trigramindexet). */
export const MIN_ORDER_TERM = 3;
