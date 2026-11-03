/** Felkoder från beräkningslagret. Meddelandena är på svenska och kan visas för användaren. */
export type DomainErrorCode =
  | "invalid_date"
  | "invalid_month"
  | "invalid_period"
  | "invalid_amount"
  | "invalid_rate"
  | "invalid_input"
  | "duplicate_order"
  | "missing_price"
  | "duplicate_price"
  | "overlapping_placement"
  | "overlapping_agreement"
  | "invalid_shares"
  | "overflow"
  | "division_by_zero";

/**
 * Fel i indata eller en beräkning som skulle ge fel resultat (t.ex. belopp utanför
 * säkra heltal). Beräkningslagret gissar aldrig: hellre ett tydligt fel än en felaktig siffra.
 */
export class DomainError extends Error {
  readonly code: DomainErrorCode;

  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.name = "DomainError";
    this.code = code;
  }
}
