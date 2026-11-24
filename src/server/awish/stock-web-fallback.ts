/**
 * Reservväg för facken: när Awish Open API (gRPC Products) inte svarar läses samma fack via
 * Awish webbpanel (samma inloggning som påfyllningarna skickas med, web-service.ts).
 *
 * - Panelens Products med fackets egen kapacitet (slots(): inventory, annars channel.total),
 *   så att fyllnadsgraden blir densamma som från Open API.
 * - Kräver bara en sparad webbinloggning, inte att påfyllningarna skickas till Awish
 *   (brytaren "Skicka till Awish"): att läsa ändrar inget hos Awish.
 * - Loggar in högst en gång per körning. Nekas inloggningen provas den inte igen i körningen
 *   (inga upprepade inloggningar som kan låsa Awish-kontot). Är webbpanelens brytare öppen
 *   (inloggningen nekades nyss, health.ts) loggar den inte in alls.
 * - Får körningens tidsgräns (deadlineAt), så att Uppdatera i Fyll på svarar i tid.
 *
 * Utan webbinloggning finns ingen reserv: `available()` är false och läsningen svarar null.
 * Fel från webbpanelen kastas (AwishApiError), så att synken kan spara felets art.
 */

import "server-only";

import type { Db } from "@/db/client";

import type { AwishSlot } from "./goods";
import type { AwishProduct } from "./grpc-client";
import { breakerOpen } from "./health";
import {
  createAwishWebClient,
  type AwishWebApi,
  type AwishWebClientOptions,
  type AwishWebProduct,
} from "./web-client";
import { loadWebSource, readWebCredentials } from "./web-service";

export interface StockFallback {
  /** Facken via webbpanelen, eller null när ingen reserv finns. Kastar vid fel. */
  (externalMachineId: string): Promise<AwishProduct[] | null>;
  /** Finns en reservväg (sparad webbinloggning och ingen öppen brytare)? */
  available?: () => Promise<boolean>;
  /**
   * Kontots slutdag via webbpanelens Profile (merchant.expired_at), samma inloggning. undefined
   * = ingen reserv; null = Awish skickar ingen slutdag. Kastar vid fel.
   */
  merchantExpiry?: () => Promise<string | null | undefined>;
}

/** Panelens fack i samma form som Open API:s Products (äldre Products utan inventory). */
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

/** Ett fack ur panelens slots() i samma form som Open API:s Products. */
export function webSlotToAwish(machineId: string, s: AwishSlot): AwishProduct {
  return {
    id: String(s.id),
    machineId,
    channel: (s.channelName ?? "").trim(),
    goodId: s.goodId == null ? null : String(s.goodId),
    goodName: s.goodName?.trim() || null,
    currentInventory: Math.max(0, Math.trunc(s.currentInventory) || 0),
    capacity: Math.max(0, Math.trunc(s.capacity ?? 0) || 0),
  };
}

export interface WebStockFallbackOptions {
  /** Körningens tidsgräns (ms sedan 1970). */
  readonly deadlineAt?: number;
  readonly now?: () => Date;
  /** Klienten; injiceras i tester. */
  readonly makeClient?: (options: AwishWebClientOptions) => AwishWebApi;
}

type Prepared = { sourceId: string; login: { email: string; password: string } } | null;

export function webStockFallback(
  db: Db,
  organizationId: string,
  options: WebStockFallbackOptions | (() => AwishWebApi) = {},
): StockFallback {
  const opts: WebStockFallbackOptions =
    typeof options === "function" ? { makeClient: () => options() } : options;
  const makeClient = opts.makeClient ?? ((o: AwishWebClientOptions) => createAwishWebClient(o));
  const now = opts.now ?? (() => new Date());

  let ready: Promise<Prepared> | null = null;
  const prepare = (): Promise<Prepared> =>
    (ready ??= (async (): Promise<Prepared> => {
      const source = await loadWebSource(db, organizationId);
      if (!source) return null;
      // Inloggningen nekades nyss (påfyllningarna eller en tidigare läsning): logga inte in.
      if (
        (await breakerOpen(db, source.id, "stock", "webbpanelen", now())) ||
        (await breakerOpen(db, source.id, "push", "webbpanelen", now()))
      ) {
        return null;
      }
      const login = await readWebCredentials(db, source.id);
      return login ? { sourceId: source.id, login } : null;
    })().catch((): Prepared => {
      console.warn("[awish] reservvägen (webbpanelen) kunde inte förberedas");
      return null;
    }));

  let session: Promise<AwishWebApi> | null = null;
  const open = (login: { email: string; password: string }): Promise<AwishWebApi> =>
    (session ??= (async () => {
      // Tidsgränsen räknas om till väggklockan: klienten signerar med den riktiga tiden.
      const left = opts.deadlineAt === undefined ? null : opts.deadlineAt - now().getTime();
      const client = makeClient(left === null ? {} : { deadlineAt: Date.now() + left });
      await client.login(login);
      return client;
    })());

  const read: StockFallback = async (externalMachineId) => {
    const id = Number(externalMachineId);
    if (!Number.isSafeInteger(id) || id <= 0) return null;
    const p = await prepare();
    if (!p) return null;
    const client = await open(p.login);
    const slots = await client.slots(id);
    return slots.map((s) => webSlotToAwish(externalMachineId, s));
  };
  read.available = async () => (await prepare()) !== null;
  read.merchantExpiry = async () => {
    const p = await prepare();
    if (!p) return undefined;
    const client = await open(p.login);
    return (await client.profile()).expiredAt;
  };
  return read;
}
