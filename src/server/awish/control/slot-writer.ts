/**
 * Skrivväg för fack (API eller webbpanelen, enligt awish_api_state.slot_writes_via).
 *
 * STUBB: signaturen följer designen (§2.8). Paket P1 skriver kroppen; filen ersätts då.
 */

import "server-only";

import type { Db } from "@/db/client";

import type { AwishWebProduct } from "../web-client";
import type { ControlDeps } from "./connect";

export interface SlotWriter {
  via: "api" | "web";
  slots(awishId: string): Promise<AwishWebProduct[]>;
  setSlot(
    productId: number,
    i: { goodId: number | null; status: boolean; currentInventory: number },
  ): Promise<void>;
}

export async function slotWriterFor(
  _db: Db,
  _orgId: string,
  _deps?: ControlDeps,
): Promise<SlotWriter> {
  throw new Error("inte klart");
}
