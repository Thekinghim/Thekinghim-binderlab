/**
 * Reservväg för facken: när Awish Open API (gRPC Products) inte svarar läses samma fack via
 * Awish webbpanel (samma inloggning som påfyllningarna skickas med, web-service.ts).
 * Loggar in högst en gång per körning. Utan webbinloggning (ingen källa, avstängd eller
 * inga uppgifter) finns ingen reserv: då räknas automaten som misslyckad som förut.
 */

import "server-only";

import type { Db } from "@/db/client";

import type { AwishProduct } from "./grpc-client";
import { createAwishWebClient, type AwishWebApi, type AwishWebProduct } from "./web-client";
import { loadWebSource, readWebCredentials } from "./web-service";

export type StockFallback = (externalMachineId: string) => Promise<AwishProduct[] | null>;

/** Panelens fack i samma form som Open API:s Products. */
export function webProductToAwish(machineId: string, p: AwishWebProduct): AwishProduct {
  return {
    id: String(p.id),
    machineId,
    channel: (p.channelName ?? "").trim(),
    goodId: p.goodId == null ? null : String(p.goodId),
    goodName: p.goodName?.trim() || null,
    currentInventory: Math.max(0, Math.trunc(p.currentInventory) || 0),
    capacity: Math.max(0, Math.trunc(p.capacity ?? 0) || 0),
  };
}

export function webStockFallback(
  db: Db,
  organizationId: string,
  makeClient: () => AwishWebApi = () => createAwishWebClient(),
): StockFallback {
  let session: Promise<AwishWebApi | null> | null = null;
  const open = async (): Promise<AwishWebApi | null> => {
    const source = await loadWebSource(db, organizationId);
    if (!source || !source.enabled) return null;
    const creds = await readWebCredentials(db, source.id);
    if (!creds) return null;
    const client = makeClient();
    await client.login(creds);
    return client;
  };
  return async (externalMachineId) => {
    const id = Number(externalMachineId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    session ??= open().catch((error: unknown) => {
      console.warn("[awish] reservvägen (webbpanelen) kunde inte loggas in", error);
      return null;
    });
    const client = await session;
    if (!client) return null;
    const products = await client.products(id);
    return products.map((p) => webProductToAwish(externalMachineId, p));
  };
}
