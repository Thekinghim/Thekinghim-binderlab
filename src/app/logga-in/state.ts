/** Tillstånd för formulären på /logga-in (delas av server actions och klient). */

export interface LoginState {
  error?: string;
  email?: string;
}

export interface MagicLinkState {
  status: "idle" | "sent";
  email?: string;
  error?: string;
}

export interface ConfirmState {
  error?: string;
  /** Länken gick inte: visa "Logga in med lösenord" och "Skicka ny länk". */
  failed?: boolean;
}

export interface NewPasswordState {
  error?: string;
  /** Länken gick inte (gammal eller redan använd): be om en ny. */
  failed?: boolean;
}

/** När inloggningen inte når databasen eller tjänsten (formuläret står kvar). */
export const LOGIN_UNAVAILABLE = "Inloggningen svarar inte just nu. Försök igen om en stund.";

/**
 * Cookie som bär `next` från begäran till länken. Valfri: öppnas länken i en
 * annan webbläsare eller app saknas den, och man kommer till startsidan.
 */
export const MAGIC_COOKIE = "bl_magic";
/** Supabase-länkar gäller en timme som standard. */
export const MAGIC_TTL_SECONDS = 60 * 60;

/** Felkoder i ?fel= (t.ex. från /logga-in/bekrafta) → svenska meddelanden. */
export const LOGIN_NOTICES: Record<string, string> = {
  lank: "Länken gick inte att öppna. Logga in med lösenord eller skicka en ny.",
};
