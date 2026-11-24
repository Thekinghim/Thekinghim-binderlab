/**
 * Skriver ett fack i Awish via API:t (UpdateProduct, signerat) eller via webbpanelen,
 * efter organisationens val (awish_api_state.slot_writes_via). API:t används bara när
 * signeringen är testad (sign_status 'ok'); annars webbpanelen, som i dag.
 * Anroparen har redan kontrollerat rollen och att organisationen inte är en demo.
 */

import "server-only";

import type { Db } from "@/db/client";

import { awishSourceOf } from "../marketing";
import { createAwishWebClient, type AwishWebProduct } from "../web-client";
import { loadWebSource, readWebCredentials } from "../web-service";
import { productToWebProduct } from "./api-push";
import { apiFor, controlContextFor, type ControlDeps } from "./connect";
import { AwishControlInputError } from "./errors";
import { loadApiState } from "./state";

export interface SlotWriter {
  via: "api" | "web";
  slots(awishId: string): Promise<AwishWebProduct[]>;
  setSlot(
    productId: number,
    i: { goodId: number | null; status: boolean; currentInventory: number },
  ): Promise<void>;
  close(): void;
}

function numericId(value: string): number {
  if (!/^\d{1,15}$/.test(value)) throw new AwishControlInputError("Ogiltigt id för automaten.");
  return Number(value);
}

export async function slotWriterFor(
  db: Db,
  orgId: string,
  deps: ControlDeps = {},
): Promise<SlotWriter> {
  const source = await awishSourceOf(db, orgId);
  const state = source ? await loadApiState(db, orgId, source.id) : null;
  if (state && state.slotWritesVia !== "web" && state.signStatus === "ok") {
    const ctx = await controlContextFor(db, orgId, deps);
    if (ctx.endpoint !== null) {
      const api = apiFor(ctx);
      return {
        via: "api",
        async slots(awishId) {
          return (await api.productDetails(awishId)).map(productToWebProduct);
        },
        async setSlot(productId, i) {
          await api.updateProduct({
            id: String(productId),
            ...(i.goodId !== null ? { goodId: String(i.goodId) } : {}),
            status: i.status,
            currentInventory: i.currentInventory,
          });
        },
        close() {
          api.close();
        },
      };
    }
  }
  const web = await loadWebSource(db, orgId);
  const creds = web ? await readWebCredentials(db, web.id) : null;
  if (!web || !creds) {
    throw new AwishControlInputError("Spara Awish-inloggningen först (Mer → Datakällor → Awish).");
  }
  const client = (deps.makeWebClient ?? createAwishWebClient)(deps.webClientOptions ?? {});
  let loggedIn = false;
  const login = async () => {
    if (!loggedIn) {
      await client.login(creds);
      loggedIn = true;
    }
  };
  return {
    via: "web",
    async slots(awishId) {
      await login();
      return client.products(numericId(awishId));
    },
    async setSlot(productId, i) {
      await login();
      await client.setProductInventory(productId, i);
    },
    close() {},
  };
}
