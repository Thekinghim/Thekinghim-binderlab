"use client";

import { useRouter } from "next/navigation";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type FormEvent,
} from "react";

import {
  listQueue,
  newClientId,
  putQueued,
  queueAvailable,
  removeQueued,
  type QueuedRefill,
} from "@/components/pwa/refill-queue";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";
import { PlaceButtons } from "@/components/stock/place-buttons";
import { inPlace, pickPlace } from "@/components/stock/place-text";
import { formatDateTime, formatInt, NBSP } from "@/lib/format";
import { rememberKey, useRemembered } from "@/lib/remembered";
import type { RefillSources } from "@/server/data/core/places";

import { Sheet } from "../../lager/_components/sheet";

import { syncRefills, type RefillSyncResult } from "../actions";

interface Option {
  readonly id: string;
  readonly name: string;
  readonly code?: string;
}

export interface RefillAppProps {
  readonly scope: string;
  readonly machines: Option[];
  readonly titles: Option[];
  readonly stock: { machineId: string; titleId: string; onHand: number }[];
  /** Vårt lager: summan av alla egna lager per titel. */
  readonly warehouse: { titleId: string; onHand: number }[];
  /** Lagren, saldot per lager och automaternas "Fylls på från". */
  readonly sources: RefillSources;
}

type Net = "online" | "offline";

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

/**
 * Påfyllning i fältet. Varje påfyllning sparas först i webbläsarens kö (IndexedDB) med ett
 * eget id och skickas sedan; utan nät ligger den kvar och skickas när nätet kommer tillbaka.
 * Servern sparar varje id en gång (register_refill_once), så ett omförsök blir aldrig dubbelt.
 */
export function RefillApp({ scope, machines, titles, stock, warehouse, sources }: RefillAppProps) {
  const router = useRouter();
  const toast = useToast();
  const online = useSyncExternalStore(
    subscribeOnline,
    () => navigator.onLine,
    () => true,
  );
  const [lostConnection, setLostConnection] = useState(false);
  const net: Net = online && !lostConnection ? "online" : "offline";
  const [queue, setQueue] = useState<QueuedRefill[]>([]);
  const [syncing, setSyncing] = useState(false);
  const [machineId, setMachineId] = useState(machines[0]?.id ?? "");
  const [titleId, setTitleId] = useState("");
  const [quantity, setQuantity] = useState("");
  const [fromWarehouse, setFromWarehouse] = useState(true);
  const [lastSource, setLastSource] = useRemembered(rememberKey(scope, "fyll-lager"));
  // Valt med "Från: … ▾" för en automat; annars automatens lager, senaste valet, standard.
  const [override, setOverride] = useState<Record<string, string>>({});
  const [choosing, setChoosing] = useState(false);
  const source = pickPlace(
    sources.places,
    override[machineId],
    sources.machineSource[machineId],
    lastSource,
    sources.defaultPlaceId,
  );
  const sourceName = sources.places.find((p) => p.id === source)?.name ?? "";
  const multi = sources.places.length > 1;
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<{ quantity?: string; titleId?: string; machineId?: string }>(
    {},
  );
  const syncingRef = useRef(false);
  // Servern antar att kön finns (samma HTML före och efter hydrering); webbläsaren svarar.
  const persistent = useSyncExternalStore(noopSubscribe, queueAvailable, () => true);

  const onHand = useMemo(() => {
    const m = new Map<string, number>();
    for (const s of stock) if (s.machineId === machineId) m.set(s.titleId, s.onHand);
    return m;
  }, [stock, machineId]);
  const central = useMemo(() => new Map(warehouse.map((w) => [w.titleId, w.onHand])), [warehouse]);
  const machineName = useMemo(
    () => new Map(machines.map((m) => [m.id, `${m.code ?? ""} ${m.name}`.trim()])),
    [machines],
  );
  const titleName = useMemo(() => new Map(titles.map((t) => [t.id, t.name])), [titles]);

  const reload = useCallback(async () => {
    try {
      setQueue(await listQueue(scope));
    } catch {
      setQueue([]);
    }
  }, [scope]);

  const apply = useCallback(
    async (results: RefillSyncResult[]) => {
      let saved = 0;
      for (const r of results) {
        if (r.status === "saved" || r.status === "duplicate") {
          await removeQueued(r.clientId);
          if (r.status === "saved") saved += 1;
        } else {
          const current = (await listQueue(scope)).find((q) => q.clientId === r.clientId);
          if (current) {
            await putQueued({
              ...current,
              status: "rejected",
              error: r.error ?? "Påfyllningen avvisades.",
              attempts: current.attempts + 1,
            });
          }
        }
      }
      return saved;
    },
    [scope],
  );

  const sync = useCallback(async () => {
    if (syncingRef.current || !persistent) return;
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const pending = (await listQueue(scope)).filter((q) => q.status === "queued");
    if (pending.length === 0) return;
    syncingRef.current = true;
    setSyncing(true);
    try {
      const res = await syncRefills(
        pending.map((q) => ({
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
      const saved = await apply(res.results);
      if (saved > 0) {
        toast({
          title:
            saved === 1
              ? "Påfyllning registrerad"
              : `${formatInt(saved)} påfyllningar registrerade`,
          tone: "ok",
        });
        router.refresh();
      }
      const rejected = res.results.filter((r) => r.status === "rejected").length;
      if (rejected > 0) {
        toast({
          title: `${formatInt(rejected)} påfyllning avvisades`,
          description: "Se kön nedan.",
          tone: "critical",
        });
      }
      setLostConnection(false);
    } catch {
      // Nätet försvann under anropet: allt ligger kvar i kön och skickas igen.
      setLostConnection(true);
    } finally {
      syncingRef.current = false;
      setSyncing(false);
      await reload();
    }
  }, [apply, persistent, reload, router, scope, toast]);

  useEffect(() => {
    const first = window.setTimeout(() => void reload().then(() => sync()), 0);
    const back = () => {
      setLostConnection(false);
      void sync();
    };
    window.addEventListener("online", back);
    const timer = window.setInterval(() => void sync(), 30_000);
    return () => {
      window.clearTimeout(first);
      window.removeEventListener("online", back);
      window.clearInterval(timer);
    };
  }, [reload, sync]);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const q = Number(quantity);
    const next: typeof errors = {};
    if (!machineId) next.machineId = "Välj automat.";
    if (!titleId) next.titleId = "Välj titel.";
    if (!Number.isInteger(q) || q < 1 || q > 10000) next.quantity = "Ange antal pack, 1–10 000.";
    setErrors(next);
    if (Object.keys(next).length > 0) return;
    const item: QueuedRefill = {
      clientId: newClientId(),
      scope,
      machineId,
      titleId,
      quantity: q,
      fromWarehouse,
      ...(fromWarehouse && source ? { fromLocationId: source } : {}),
      occurredAt: new Date().toISOString(),
      ...(note.trim() ? { note: note.trim().slice(0, 500) } : {}),
      status: "queued",
      attempts: 0,
    };
    if (fromWarehouse && source) setLastSource(source);
    if (persistent) {
      await putQueued(item);
      await reload();
      setQuantity("");
      setNote("");
      if (navigator.onLine) await sync();
      else
        toast({
          title: "Sparad i kön",
          description: "Skickas när nätet kommer tillbaka.",
          tone: "neutral",
        });
    } else {
      // Utan IndexedDB (t.ex. privat läge i vissa webbläsare): skicka direkt.
      try {
        const res = await syncRefills([item]);
        const r = res.results[0];
        if (r?.status === "rejected") setErrors({ quantity: r.error });
        else {
          setQuantity("");
          setNote("");
          toast({ title: "Påfyllning registrerad", tone: "ok" });
          router.refresh();
        }
      } catch {
        setErrors({
          quantity: "Ingen uppkoppling och webbläsaren kan inte spara kön. Försök igen med nät.",
        });
      }
    }
  };

  const queued = queue.filter((q) => q.status === "queued").length;
  const rejected = queue.filter((q) => q.status === "rejected");

  return (
    <div className="grid gap-10 lg:grid-cols-12 lg:gap-8">
      <form
        onSubmit={submit}
        noValidate
        className="flex flex-col gap-5 lg:col-span-6"
        aria-label="Registrera påfyllning"
      >
        <div className="flex flex-wrap items-center gap-2" role="status" aria-live="polite">
          <StatusTag status={net === "online" ? "ok" : "offline"}>
            {net === "online" ? "Uppkopplad" : "Ingen uppkoppling"}
          </StatusTag>
          <span className="meta text-subtle">
            {queued === 0
              ? "Kön är tom."
              : `${formatInt(queued)} ${queued === 1 ? "påfyllning väntar" : "påfyllningar väntar"}${net === "offline" ? ", skickas när nätet kommer tillbaka" : ""}.`}
          </span>
        </div>
        {!persistent ? (
          <StateMessage
            kind="not-configured"
            compact
            message="Webbläsaren kan inte spara påfyllningar utan nät här. Registrera med uppkoppling."
          />
        ) : null}
        <Select
          label="Automat"
          value={machineId}
          onChange={(e) => setMachineId(e.target.value)}
          error={errors.machineId}
          options={machines.map((m) => ({
            value: m.id,
            label: `${m.code ?? ""} ${m.name}`.trim(),
          }))}
        />
        <Select
          label="Titel"
          value={titleId}
          onChange={(e) => setTitleId(e.target.value)}
          error={errors.titleId}
          options={[
            { value: "", label: "Välj titel" },
            ...titles.map((t) => ({
              value: t.id,
              label: `${t.name} · ${formatInt(onHand.get(t.id) ?? 0)}${NBSP}i automaten`,
            })),
          ]}
        />
        <Input
          label="Antal pack"
          type="number"
          inputMode="numeric"
          min={1}
          max={10000}
          step={1}
          value={quantity}
          onChange={(e) => setQuantity(e.target.value)}
          error={errors.quantity}
          suffix="st"
          hint={
            titleId && fromWarehouse && source
              ? `${formatInt(sources.stock[source]?.[titleId] ?? 0)} ${inPlace(sourceName)}${multi ? ` · ${formatInt(central.get(titleId) ?? 0)} i alla lager` : ""}`
              : undefined
          }
        />
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex min-h-11 items-center gap-2 text-sm text-fg">
            <input
              type="checkbox"
              checked={fromWarehouse}
              onChange={(e) => setFromWarehouse(e.target.checked)}
              className="size-4 accent-current"
            />
            Ta packen från vårt lager
          </label>
          {fromWarehouse && multi ? (
            <button
              type="button"
              onClick={() => setChoosing(true)}
              aria-label={`Från ${sourceName}. Byt lager`}
              className="inline-flex min-h-11 items-center gap-1 rounded-full border border-line-strong bg-surface px-4 text-sm text-fg hover:bg-hover"
            >
              <span className="text-subtle">Från:</span>
              <span className="font-medium">{sourceName}</span>
              <span aria-hidden className="text-subtle">
                ▾
              </span>
            </button>
          ) : null}
        </div>
        <Sheet open={choosing} onClose={() => setChoosing(false)} title="Ta pack från">
          <div className="px-5 pb-5">
            <PlaceButtons
              label="Ta pack från"
              places={sources.places.map((p) => ({
                id: p.id,
                name: p.name,
                count: titleId ? (sources.stock[p.id]?.[titleId] ?? 0) : null,
              }))}
              value={source}
              onChange={(id) => {
                setOverride((prev) => ({ ...prev, [machineId]: id }));
                setChoosing(false);
              }}
            />
          </div>
        </Sheet>
        <Input
          label="Notering"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={500}
        />
        <div className="flex gap-2">
          <Button type="submit" variant="primary">
            Registrera påfyllning
          </Button>
          {queued > 0 && net === "online" ? (
            <Button type="button" loading={syncing} onClick={() => void sync()}>
              Skicka kön
            </Button>
          ) : null}
        </div>
      </form>

      <section aria-labelledby="ko" className="flex flex-col gap-4 lg:col-span-6">
        <h2 id="ko" className="label text-muted">
          {`Kö i den här webbläsaren · ${formatInt(queue.length)}`}
        </h2>
        {queue.length === 0 ? (
          <p className="text-sm text-muted">Allt är skickat.</p>
        ) : (
          <ul className="flex flex-col divide-y divide-line border-y border-line">
            {queue.map((q) => (
              <li key={q.clientId} className="flex flex-col gap-1 py-3">
                <div className="flex items-baseline justify-between gap-3">
                  <span className="text-sm text-fg">
                    {`${formatInt(q.quantity)}${NBSP}pack ${titleName.get(q.titleId) ?? "okänd titel"}`}
                  </span>
                  <StatusTag status={q.status === "rejected" ? "warning" : "neutral"}>
                    {q.status === "rejected" ? "Avvisad" : "Väntar"}
                  </StatusTag>
                </div>
                <span className="meta text-subtle">
                  {`${machineName.get(q.machineId) ?? "okänd automat"} · ${formatDateTime(new Date(q.occurredAt))}`}
                </span>
                {q.error ? <span className="text-sm text-muted">{q.error}</span> : null}
                {q.status === "rejected" ? (
                  <div>
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={async () => {
                        await removeQueued(q.clientId);
                        await reload();
                      }}
                    >
                      Ta bort ur kön
                    </Button>
                  </div>
                ) : null}
              </li>
            ))}
          </ul>
        )}
        {rejected.length > 0 ? (
          <p className="text-sm text-muted">
            En avvisad påfyllning skickas inte igen. Rätta i Lager eller registrera på nytt.
          </p>
        ) : null}
      </section>
    </div>
  );
}
