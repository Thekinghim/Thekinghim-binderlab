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
}

/** När inloggningen inte når databasen eller tjänsten (formuläret står kvar). */
export const LOGIN_UNAVAILABLE = "Inloggningen svarar inte just nu. Försök igen om en stund.";

/** Cookie som binder en begärd länk till webbläsaren och bär `next`. */
export const MAGIC_COOKIE = "bl_magic";
/** Supabase-länkar gäller en timme som standard. */
export const MAGIC_TTL_SECONDS = 60 * 60;

/** Felkoder i ?fel= (t.ex. från /logga-in/bekrafta) → svenska meddelanden. */
export const LOGIN_NOTICES: Record<string, string> = {
  lank: "Länken har gått ut eller redan använts. Begär en ny.",
};
