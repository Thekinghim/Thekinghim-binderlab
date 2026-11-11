"use client";

/**
 * Kön för påfyllningar som en hook (Fyll på): sparar i webbläsarens IndexedDB först och
 * skickar sedan med syncRefills. Utan nät ligger allt kvar och skickas när nätet kommer
 * tillbaka (händelsen "online" och var 30:e sekund). Servern sparar varje klient-id en gång
 * (register_refill_once), så ett omförsök blir aldrig dubbelt. Samma kö som
 * /drift/pafyllning (samma scope).
 */

import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";

import {
  syncRefills,
  type AwishPushStatus,
  type RefillSyncResult,
} from "@/app/(app)/drift/actions";

import {
  listQueue,
  putQueued,
  queueAvailable,
  removeQueued,
  type QueuedRefill,
} from "./refill-queue";

function noopSubscribe(): () => void {
  return () => {};
}

function subscribeOnline(onChange: () => void): () => void {
  window.addEventListener("online", onChange);
  window.addEventListener("offline", onChange);
  return () => {
    window.removeEventListener("online", onChange);
    window.removeEventListener("offline", onChange);
  };
}

export interface SyncOutcome {
  /** Påfyllningar som sparades nu. */
  readonly saved: QueuedRefill[];
  readonly rejected: RefillSyncResult[];
  /** Sant om inget kunde skickas (ingen uppkoppling). */
  readonly offline: boolean;
  /** Kort besked om push till Awish, om något gjordes. */
  readonly awish?: AwishPushStatus;
}

const NOTHING: SyncOutcome = { saved: [], rejected: [], offline: false };

export function useRefillQueue(
  scope: string,
  options: {
    /** Kön skickades i bakgrunden. `awish`: beskedet om sändningen till Awish, om någon. */
    onBackgroundSaved?: (saved: QueuedRefill[], awish?: AwishPushStatus) => void;
  } = {},
) {
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
  const persistent = useSyncExternalStore(noopSubscribe, queueAvailable, () => true);
  const [queue, setQueue] = useState<QueuedRefill[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [lostConnection, setLostConnection] = useState(false);
  const busy = useRef(false);
  const onSaved = useRef(options.onBackgroundSaved);
  useEffect(() => {
    onSaved.current = options.onBackgroundSaved;
  });

  const reload = useCallback(async () => {
    try {
      setQueue(await listQueue(scope));
    } catch {
      setQueue([]);
    }
  }, [scope]);

  const send = useCallback(
    async (items: QueuedRefill[]): Promise<SyncOutcome> => {
      const res = await syncRefills(
        items.map((q) => ({
          clientId: q.clientId,
          machineId: q.machineId,
          titleId: q.titleId,
          quantity: q.quantity,
          fromWarehouse: q.fromWarehouse,
          ...(q.fromWarehouse && q.fromLocationId ? { fromLocationId: q.fromLocationId } : {}),
          occurredAt: q.occurredAt,
          ...(q.note ? { note: q.note } : {}),
        })),
      );
      const byId = new Map(items.map((q) => [q.clientId, q]));
      const saved: QueuedRefill[] = [];
      const rejected: RefillSyncResult[] = [];
      for (const r of res.results) {
        const item = byId.get(r.clientId);
        if (r.status === "saved" || r.status === "duplicate") {
          if (persistent) await removeQueued(r.clientId);
          if (r.status === "saved" && item) saved.push(item);
        } else {
          rejected.push(r);
          if (persistent && item) {
            await putQueued({
              ...item,
              status: "rejected",
              error: r.error ?? "Påfyllningen avvisades.",
              attempts: item.attempts + 1,
            });
          }
        }
      }
      return { saved, rejected, offline: false, awish: res.awish };
    },
    [persistent],
  );

  /** Skickar allt som väntar i kön. */
  const sync = useCallback(async (): Promise<SyncOutcome> => {
    if (busy.current || !persistent) return NOTHING;
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return { ...NOTHING, offline: true };
    }
    const pending = (await listQueue(scope)).filter((q) => q.status === "queued");
    if (pending.length === 0) return NOTHING;
    busy.current = true;
    setSyncing(true);
    try {
      const out = await send(pending);
      setLostConnection(false);
      return out;
    } catch {
      // Nätet försvann under anropet: allt ligger kvar i kön och skickas igen.
      setLostConnection(true);
      return { ...NOTHING, offline: true };
    } finally {
      busy.current = false;
      setSyncing(false);
      await reload();
    }
  }, [persistent, reload, scope, send]);

  /** Lägger påfyllningar i kön och skickar dem direkt om det går. */
  const enqueue = useCallback(
    async (items: QueuedRefill[]): Promise<SyncOutcome> => {
      if (!persistent) {
        // Utan IndexedDB (privat läge i vissa webbläsare): skicka direkt.
        try {
          return await send(items);
        } catch {
          return { saved: [], rejected: [], offline: true };
        }
      }
      for (const item of items) await putQueued(item);
      await reload();
      if (typeof navigator !== "undefined" && navigator.onLine === false) {
        return { ...NOTHING, offline: true };
      }
      // Väntar en bakgrundssynk redan: vänta tills den är klar och skicka sedan resten.
      for (let i = 0; busy.current && i < 50; i += 1) {
        await new Promise((r) => setTimeout(r, 100));
      }
      return sync();
    },
    [persistent, reload, send, sync],
  );

  const remove = useCallback(
    async (clientId: string) => {
      await removeQueued(clientId);
      await reload();
    },
    [reload],
  );

  useEffect(() => {
    const background = async () => {
      const out = await sync();
      // Beskedet om Awish följer med: en sändning som inte gick fram ska synas även när
      // påfyllningen låg i kön utan nät och skickades i bakgrunden.
      if (out.saved.length > 0) onSaved.current?.(out.saved, out.awish);
    };
    const first = window.setTimeout(() => void reload().then(background), 0);
    const back = () => {
      setLostConnection(false);
      void background();
    };
    window.addEventListener("online", back);
    const timer = window.setInterval(() => void background(), 30_000);
    return () => {
      window.clearTimeout(first);
      window.removeEventListener("online", back);
      window.clearInterval(timer);
    };
  }, [reload, sync]);

  return {
    queue,
    online: online && !lostConnection,
    persistent,
    syncing,
    enqueue,
    sync,
    remove,
    reload,
  };
}
