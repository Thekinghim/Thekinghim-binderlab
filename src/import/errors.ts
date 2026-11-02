/**
 * Fel som importen kastar. Alla har en stabil `code` (för UI och loggar) och
 * ett svenskt meddelande som kan visas för användaren som det är.
 */

export type ImportErrorCode =
  | "forbidden"
  | "not_found"
  | "validation"
  | "mapping"
  | "not_configured"
  | "file_too_large";

export class ImportError extends Error {
  readonly code: ImportErrorCode;

  constructor(code: ImportErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "ImportError";
    this.code = code;
  }
}

/** Användaren får inte importera (bara ägare och admin får). */
export class ImportForbiddenError extends ImportError {
  constructor(message = "Bara ägare och administratörer får importera order.") {
    super("forbidden", message);
    this.name = "ImportForbiddenError";
  }
}

/** Datakällan finns inte (eller syns inte för användaren). */
export class ImportNotFoundError extends ImportError {
  constructor(message = "Datakällan finns inte.") {
    super("not_found", message);
    this.name = "ImportNotFoundError";
  }
}

/** Indata som inte går att importera alls (fel datakälla, tom fil ...). */
export class ImportValidationError extends ImportError {
  constructor(message: string) {
    super("validation", message);
    this.name = "ImportValidationError";
  }
}

/** Kolumnmappningen saknar obligatoriska fält eller pekar på okända rubriker. */
export class MappingError extends ImportError {
  readonly missing: readonly string[];

  constructor(message: string, missing: readonly string[] = []) {
    super("mapping", message);
    this.name = "MappingError";
    this.missing = missing;
  }
}

/** En adapter som inte kan köras ännu (t.ex. awish_grpc utan specifikation). */
export class NotConfiguredError extends ImportError {
  readonly missing: readonly string[];

  constructor(message: string, missing: readonly string[]) {
    super("not_configured", `${message}\nSaknas:\n${missing.map((m) => `- ${m}`).join("\n")}`);
    this.name = "NotConfiguredError";
    this.missing = missing;
  }
}
