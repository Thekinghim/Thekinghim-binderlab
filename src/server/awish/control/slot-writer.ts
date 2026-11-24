/** Skriver ett fack via API:t (UpdateProduct) eller webbpanelen, efter flaggan slot_writes_via. */

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
  db: Db,
  orgId: string,
  deps?: ControlDeps,
): Promise<SlotWriter> {
  void db;
  void orgId;
  void deps;
  throw new Error("inte klart");
}
