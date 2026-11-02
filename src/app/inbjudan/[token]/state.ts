/** Tillståndet för formuläret på /inbjudan/[token]. */
export interface AcceptState {
  error?: string;
  /** Fältet felet gäller, om något. */
  field?: "password" | "confirm";
  /** Det finns redan ett konto för adressen: visa vägen till inloggningen. */
  accountExists?: boolean;
}
