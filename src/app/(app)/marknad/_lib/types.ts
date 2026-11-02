/** Svaret från Marknads server actions. */
export type ActionResult<T = void> = { ok: true; data: T } | { ok: false; error: string };

/** Ett val i en lista (titel, leverantör, automat). */
export interface Option {
  readonly value: string;
  readonly label: string;
}
