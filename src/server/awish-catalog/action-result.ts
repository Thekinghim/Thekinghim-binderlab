/**
 * Svaret från katalogens server actions: { ok, data } eller { ok: false, error } med svensk
 * text. Bara namn, meddelande och SQLSTATE loggas (aldrig parametrar, personuppgifter eller
 * inloggning).
 */

import "server-only";

import { unstable_rethrow } from "next/navigation";

import { AuthorizationError } from "@/server/access";
import { AwishApiError } from "@/server/awish/grpc-client";
import { NewProductError } from "@/server/awish/goods";
import { AwishNotConnectedError } from "@/server/awish/marketing";
import { safeErrorForLog } from "@/server/errors";

import { CatalogError, FORBIDDEN_MESSAGE } from "./common";

export type CatalogActionResult<T> = { ok: true; data: T } | { ok: false; error: string };

export async function catalogAction<T>(
  tag: string,
  fn: () => Promise<T>,
  forbidden = FORBIDDEN_MESSAGE,
): Promise<CatalogActionResult<T>> {
  try {
    return { ok: true, data: await fn() };
  } catch (error) {
    unstable_rethrow(error);
    if (error instanceof AuthorizationError) {
      return {
        ok: false,
        error: error.reason === "unauthenticated" ? error.message : forbidden,
      };
    }
    if (
      error instanceof CatalogError ||
      error instanceof NewProductError ||
      error instanceof AwishApiError ||
      error instanceof AwishNotConnectedError
    ) {
      return { ok: false, error: error.message };
    }
    console.error(`[${tag}]`, safeErrorForLog(error));
    return { ok: false, error: "Det gick inte just nu. Försök igen om en stund." };
  }
}
