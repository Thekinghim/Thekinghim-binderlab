/**
 * Kön för påfyllningar i fältet: sparas i webbläsarens IndexedDB tills de har skickats.
 *
 * Varje påfyllning får ett id i webbläsaren (crypto.randomUUID) när den registreras. Servern
 * sparar den med det id:t (register_refill_once), så att samma påfyllning aldrig blir två
 * lagerhändelser, hur många gånger den än skickas (t.ex. när nätet försvinner mitt i ett
 * svar). Kön är per organisation och användare.
 */

export interface QueuedRefill {
  readonly clientId: string;
  /** Organisation och användare som registrerade den (kön delas inte). */
  readonly scope: string;
  readonly machineId: string;
  readonly titleId: string;
  readonly quantity: number;
  readonly fromWarehouse: boolean;
  /** Lagret packen togs från (Hemma, Kontoret …). Utelämnat = automatens "Fylls på från". */
  readonly fromLocationId?: string;
  /** Tidpunkten då påfyllningen gjordes (ISO 8601 med Z). */
  readonly occurredAt: string;
  readonly note?: string;
  readonly status: "queued" | "rejected";
  readonly error?: string;
  readonly attempts: number;
}

const DB_NAME = "binderlab-falt";
const STORE = "pafyllningar";
const VERSION = 1;

function available(): boolean {
  return typeof indexedDB !== "undefined";
}

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const store = db.createObjectStore(STORE, { keyPath: "clientId" });
        store.createIndex("scope", "scope", { unique: false });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error("IndexedDB kunde inte öppnas."));
  });
}

async function run<T>(
  mode: IDBTransactionMode,
  fn: (store: IDBObjectStore) => IDBRequest<T> | void,
): Promise<T | undefined> {
  const db = await open();
  try {
    return await new Promise<T | undefined>((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const store = tx.objectStore(STORE);
      const req = fn(store);
      let value: T | undefined;
      if (req) req.onsuccess = () => (value = req.result);
      tx.oncomplete = () => resolve(value);
      tx.onerror = () => reject(tx.error ?? new Error("IndexedDB-fel."));
      tx.onabort = () => reject(tx.error ?? new Error("IndexedDB avbröts."));
    });
  } finally {
    db.close();
  }
}

/** Sant om kön kan sparas i webbläsaren. */
export function queueAvailable(): boolean {
  return available();
}

export async function listQueue(scope: string): Promise<QueuedRefill[]> {
  if (!available()) return [];
  const all = (await run<QueuedRefill[]>("readonly", (s) => s.index("scope").getAll(scope))) ?? [];
  return all.sort((a, b) => (a.occurredAt < b.occurredAt ? -1 : 1));
}

export async function putQueued(item: QueuedRefill): Promise<void> {
  await run("readwrite", (s) => s.put(item));
}

export async function removeQueued(clientId: string): Promise<void> {
  await run("readwrite", (s) => s.delete(clientId));
}

/** Nytt id för en påfyllning (UUID v4). */
export function newClientId(): string {
  const c = globalThis.crypto as Crypto & { randomUUID?: () => string };
  // randomUUID finns bara i säkra sammanhang (https, localhost).
  if (typeof c.randomUUID === "function") return c.randomUUID();
  const b = new Uint8Array(16);
  c.getRandomValues(b);
  b[6] = (b[6]! & 0x0f) | 0x40;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
