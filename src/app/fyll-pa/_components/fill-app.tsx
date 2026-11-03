"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useMemo, useState, type CSSProperties } from "react";

import { newClientId, type QueuedRefill } from "@/components/pwa/refill-queue";
import { useRefillQueue } from "@/components/pwa/use-refill-queue";
import { PlaceButtons } from "@/components/stock/place-buttons";
import { inPlace, pickPlace } from "@/components/stock/place-text";
import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";
import { rememberKey, useRemembered } from "@/lib/remembered";

import { Sheet } from "@/app/(app)/lager/_components/sheet";
import { registerCount } from "@/app/(app)/lager/actions";

import {
  applyAdjustments,
  doneMessage,
  maxFill,
  pairKey,
  splitRefill,
  type FillAdjustment,
  type FillMachine,
  type FillRow,
} from "../_lib/model";
import type { FillData } from "../_lib/data";

export interface FillAppProps {
  /** Köns ägare: organisation och användare (samma som /drift/pafyllning). */
  readonly scope: string;
  readonly data: FillData;
  /** "för 7 min sedan" per automat (räknat på servern i organisationens tidszon). */
  readonly syncLabels: Record<string, string>;
}

const BASE = "/fyll-pa";

function machineIdFrom(pathname: string | null): string | null {
  if (!pathname?.startsWith(`${BASE}/`)) return null;
  const id = pathname.slice(BASE.length + 1).split("/")[0] ?? "";
  return /^[0-9a-f-]{36}$/i.test(id) ? id : null;
}

const rise = (i: number) => ({ "--i": Math.min(i, 12) }) as CSSProperties;

/**
 * Fyll på vid automaten: välj automat (störst behov först), justera antalet per titel med
 * stora knappar och tryck Klar. Påfyllningen läggs i kön (fungerar utan nät) och dras ur
 * lagret i "Från: Hemma ▾" (automatens "Fylls på från", annars det man valde sist) så
 * långt packen räcker; resten registreras utan uttag. Awish-synken ser sedan samma antal
 * som saldot och drar inget en gång till.
 */
export function FillApp({ scope, data, syncLabels }: FillAppProps) {
  const router = useRouter();
  const toast = useToast();
  const pathname = usePathname();
  const selectedId = machineIdFrom(pathname);
  const sources = data.sources;
  const [lastSource, setLastSource] = useRemembered(rememberKey(scope, "fyll-lager"));
  // Lager valt med "Från: … ▾" för en automat (gäller tills sidan laddas om).
  const [override, setOverride] = useState<Record<string, string>>({});
  const sourceOf = useCallback(
    (machineId: string) =>
      pickPlace(
        sources.places,
        override[machineId],
        sources.machineSource[machineId],
        lastSource,
        sources.defaultPlaceId,
      ),
    [lastSource, override, sources],
  );
  const placeName = useCallback(
    (id: string | null) => sources.places.find((p) => p.id === id)?.name ?? "hemma",
    [sources.places],
  );

  // Påfyllningar som sparats men som serverns siffror inte visar än (tills sidan räknats om).
  const [saved, setSaved] = useState<{ base: FillData; items: FillAdjustment[] }>({
    base: data,
    items: [],
  });
  const [counted, setCounted] = useState<{ base: FillData; map: Map<string, number> }>({
    base: data,
    map: new Map(),
  });

  const rememberSaved = useCallback(
    (items: readonly QueuedRefill[]) => {
      setSaved((prev) => ({
        base: data,
        items: [...(prev.base === data ? prev.items : []), ...items],
      }));
    },
    [data],
  );

  const q = useRefillQueue(scope, {
    onBackgroundSaved: (items) => {
      rememberSaved(items);
      toast({
        title: `Sparat – ${formatInt(items.reduce((n, i) => n + i.quantity, 0))}${NBSP}pack från kön`,
        tone: "ok",
      });
      router.refresh();
    },
  });

  const view = useMemo(() => {
    const pending = q.queue.filter((i) => i.status === "queued");
    const adj: FillAdjustment[] = [...pending, ...(saved.base === data ? saved.items : [])];
    return applyAdjustments(
      data.machines,
      sources.stock,
      adj,
      counted.base === data ? counted.map : new Map(),
      sourceOf,
    );
  }, [counted, data, q.queue, saved, sources.stock, sourceOf]);

  const go = useCallback((href: string) => {
    window.history.pushState(null, "", href);
    window.scrollTo({ top: 0 });
  }, []);

  const selected = selectedId ? view.machines.find((m) => m.id === selectedId) : undefined;
  const rejected = q.queue.filter((i) => i.status === "rejected");
  const waiting = q.queue.length - rejected.length;

  if (selectedId && selected) {
    const source = sourceOf(selected.id);
    return (
      <MachineScreen
        key={`${selected.id}/${source ?? ""}`}
        machine={selected}
        places={sources.places.map((p) => ({
          id: p.id,
          name: p.name,
          count: Object.values(view.stock[p.id] ?? {}).reduce((n, v) => n + Math.max(0, v), 0),
        }))}
        sourceId={source}
        onSource={(id) => setOverride((prev) => ({ ...prev, [selected.id]: id }))}
        syncLabel={syncLabels[selected.id]}
        online={q.online}
        onBack={() => go(BASE)}
        onCounted={(titleId, value) => {
          setCounted((prev) => {
            const map = new Map(prev.base === data ? prev.map : []);
            map.set(pairKey(selected.id, titleId), value);
            return { base: data, map };
          });
          router.refresh();
        }}
        onDone={async (lines) => {
          const now = new Date().toISOString();
          const items: QueuedRefill[] = [];
          let packs = 0;
          let homeLeft = 0;
          for (const { row, quantity } of lines) {
            const split = splitRefill(quantity, source ? row.home : 0);
            packs += quantity;
            homeLeft += Math.max(0, row.home - split.fromWarehouse);
            for (const [n, fromWarehouse] of [
              [split.fromWarehouse, true],
              [split.direct, false],
            ] as const) {
              if (n <= 0) continue;
              items.push({
                clientId: newClientId(),
                scope,
                machineId: selected.id,
                titleId: row.titleId,
                quantity: n,
                fromWarehouse,
                ...(fromWarehouse && source ? { fromLocationId: source } : {}),
                occurredAt: now,
                note: fromWarehouse ? "Fyll på" : "Fyll på (utan uttag ur vårt lager)",
                status: "queued",
                attempts: 0,
              });
            }
          }
          if (items.length === 0) {
            go(BASE);
            return;
          }
          const out = await q.enqueue(items);
          if (source) setLastSource(source);
          const message = doneMessage(packs, homeLeft, placeName(source));
          if (out.rejected.length > 0) {
            toast({
              title: "Något sparades inte",
              description: out.rejected[0]?.error ?? "Se listan över automater.",
              tone: "critical",
            });
          } else if (out.offline) {
            if (!q.persistent) {
              toast({
                title: "Ingen uppkoppling",
                description: "Telefonen kan inte spara kön här. Försök igen med nät.",
                tone: "critical",
              });
              return;
            }
            toast({
              title: `Sparat i telefonen – ${message}`,
              description: "Skickas när nätet kommer tillbaka.",
              tone: "neutral",
            });
          } else {
            toast({ title: `Sparat – ${message}`, tone: "ok" });
          }
          if (out.saved.length > 0) {
            rememberSaved(out.saved);
            router.refresh();
          }
          go(BASE);
        }}
      />
    );
  }

  const need = view.machines.filter((m) => m.emptySlots > 0 || m.suggested > 0);
  const homeTotal = Object.values(view.stock).reduce(
    (n, place) => n + Object.values(place).reduce((m, v) => m + Math.max(0, v), 0),
    0,
  );
  const stockLabel =
    sources.places.length === 1 ? `pack ${inPlace(sources.places[0]!.name)}` : "pack i lager";

  return (
    <div className="flex flex-col gap-6 px-4 pt-[calc(16px+env(safe-area-inset-top))] pb-[calc(32px+env(safe-area-inset-bottom))]">
      <header className="rise flex flex-col gap-3" style={rise(0)}>
        <div className="flex items-center justify-between gap-3">
          <Link
            href="/drift"
            className="label inline-flex min-h-11 items-center gap-1 text-subtle hover:text-fg"
          >
            <Icon name="chevronLeft" />
            Binderlab
          </Link>
          <NetPill online={q.online} waiting={waiting} syncing={q.syncing} />
        </div>
        <p className="label text-subtle">Fyll på</p>
        <h1 className="text-2xl font-medium text-balance text-fg">
          {view.machines.length === 0
            ? "Inga automater."
            : need.length === 0
              ? "Alla automater är fulla."
              : `${formatInt(need.length)} ${need.length === 1 ? "automat behöver" : "automater behöver"} påfyllning.`}
        </h1>
        {data.hasWarehouse ? (
          <p className="text-md text-muted">
            <span className="tnum text-fg">{formatInt(homeTotal)}</span>
            {`${NBSP}${stockLabel}`}
          </p>
        ) : null}
      </header>

      {rejected.length > 0 ? (
        <RejectedList
          items={rejected}
          names={view.machines}
          onRetryDirect={async (item) => {
            await q.remove(item.clientId);
            const out = await q.enqueue([
              {
                ...item,
                clientId: newClientId(),
                fromWarehouse: false,
                status: "queued",
                attempts: 0,
                error: undefined,
              },
            ]);
            if (out.saved.length > 0) {
              rememberSaved(out.saved);
              toast({ title: "Sparat utan uttag ur vårt lager", tone: "ok" });
              router.refresh();
            }
          }}
          onRemove={(item) => void q.remove(item.clientId)}
        />
      ) : null}

      <ul className="flex flex-col gap-3" aria-label="Automater">
        {view.machines.map((m, i) => (
          <li key={m.id} className="rise" style={rise(i + 1)}>
            <MachineCard
              machine={m}
              syncLabel={syncLabels[m.id]}
              onOpen={() => go(`${BASE}/${m.id}`)}
            />
          </li>
        ))}
      </ul>
    </div>
  );
}

function NetPill({
  online,
  waiting,
  syncing,
}: {
  online: boolean;
  waiting: number;
  syncing: boolean;
}) {
  return (
    <span
      role="status"
      aria-live="polite"
      className={cn(
        "label inline-flex min-h-8 items-center gap-2 rounded-full border px-3",
        online ? "border-line text-subtle" : "border-signal-line text-signal-fg",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-1.5 rounded-full bg-current",
          syncing && "live-dot",
          online && waiting === 0 && "text-muted",
        )}
      />
      {online
        ? waiting > 0
          ? `${formatInt(waiting)} skickas`
          : "Uppkopplad"
        : waiting > 0
          ? `Utan nät · ${formatInt(waiting)} i kön`
          : "Utan nät"}
    </span>
  );
}

function FillBar({ pct, className }: { pct: number | null; className?: string }) {
  const p = pct === null ? 0 : Math.max(0, Math.min(100, pct));
  return (
    <span
      aria-hidden
      className={cn("relative block h-2 overflow-hidden rounded-full bg-hover", className)}
    >
      <span
        className={cn(
          "absolute inset-y-0 left-0 rounded-full transition-[width] duration-500 ease-out",
          p < 25 ? "bg-signal" : "bg-fg",
        )}
        style={{ width: `${p}%` }}
      />
    </span>
  );
}

function MachineCard({
  machine: m,
  syncLabel,
  onOpen,
}: {
  machine: FillMachine;
  syncLabel?: string;
  onOpen: () => void;
}) {
  return (
    <a
      href={`${BASE}/${m.id}`}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        onOpen();
      }}
      aria-label={`${m.place}, ${m.fillPct === null ? "fyllnadsgrad okänd" : `${m.fillPct} procent fylld`}${m.emptySlots > 0 ? `, ${m.emptySlots} tomma fack` : ""}`}
      className={cn(
        "lift flex min-h-24 flex-col gap-3 rounded-md border bg-surface p-4 active:scale-[0.99]",
        m.emptySlots > 0 ? "border-signal-line" : "border-line",
      )}
    >
      <span className="flex items-start justify-between gap-3">
        <span className="flex min-w-0 flex-col">
          <span className="truncate text-lg font-medium text-fg">{m.place}</span>
          <span className="meta text-subtle">
            {m.code}
            {syncLabel ? ` · Awish ${syncLabel}` : " · ingen Awish-läsning"}
          </span>
        </span>
        <span className="flex shrink-0 flex-col items-end">
          <span className="tnum text-2xl font-medium text-fg">
            {m.fillPct === null ? "–" : `${m.fillPct}${NBSP}%`}
          </span>
          {m.emptySlots > 0 ? (
            <span className="label text-signal-fg">
              {`${formatInt(m.emptySlots)} ${m.emptySlots === 1 ? "tomt fack" : "tomma fack"}`}
            </span>
          ) : m.suggested > 0 ? (
            <span className="label text-subtle">{`fyll ${formatInt(m.suggested)}`}</span>
          ) : m.fillPct !== null ? (
            <span className="label text-subtle">fullt</span>
          ) : null}
        </span>
      </span>
      <FillBar pct={m.fillPct} />
    </a>
  );
}

interface Line {
  readonly row: FillRow;
  readonly quantity: number;
}

function MachineScreen({
  machine: m,
  places,
  sourceId,
  onSource,
  syncLabel,
  online,
  onBack,
  onDone,
  onCounted,
}: {
  machine: FillMachine;
  /** Våra lager med antal pack (för "Från: Hemma ▾"). */
  places: readonly { id: string; name: string; count: number }[];
  /** Lagret packen tas från, null = inget eget lager. */
  sourceId: string | null;
  onSource: (id: string) => void;
  syncLabel?: string;
  online: boolean;
  onBack: () => void;
  onDone: (lines: Line[]) => Promise<void>;
  onCounted: (titleId: string, value: number) => void;
}) {
  const toast = useToast();
  const [qty, setQty] = useState<Record<string, number>>(() =>
    Object.fromEntries(m.rows.map((r) => [r.titleId, r.suggested])),
  );
  const [busy, setBusy] = useState(false);
  const [counting, setCounting] = useState<string | null>(null);
  const [choosing, setChoosing] = useState(false);
  const sourceName = places.find((p) => p.id === sourceId)?.name ?? "hemma";
  const total = m.rows.reduce((n, r) => n + (qty[r.titleId] ?? 0), 0);
  const after = useMemo(() => {
    let cap = 0;
    let known = 0;
    for (const r of m.rows) {
      if (r.capacity === null) continue;
      cap += r.capacity;
      known += Math.min(r.capacity, r.now + (qty[r.titleId] ?? 0));
    }
    return cap > 0 ? Math.round((known / cap) * 100) : null;
  }, [m.rows, qty]);

  const set = (titleId: string, value: number, max: number) =>
    setQty((prev) => ({ ...prev, [titleId]: Math.max(0, Math.min(max, Math.trunc(value) || 0)) }));

  return (
    <div className="flex min-h-dvh flex-col">
      <div className="flex flex-1 flex-col gap-5 px-4 pt-[calc(12px+env(safe-area-inset-top))] pb-6">
        <header className="rise flex flex-col gap-3" style={rise(0)}>
          <button
            type="button"
            onClick={onBack}
            className="label inline-flex min-h-11 items-center gap-1 self-start text-subtle hover:text-fg"
          >
            <Icon name="chevronLeft" />
            Automater
          </button>
          <div className="flex items-end justify-between gap-3">
            <div className="flex min-w-0 flex-col">
              <h1 className="truncate text-2xl font-medium text-fg">{m.place}</h1>
              <p className="meta text-subtle">
                {m.code}
                {syncLabel ? ` · Awish ${syncLabel}` : " · ingen Awish-läsning"}
              </p>
            </div>
            <p className="flex shrink-0 flex-col items-end">
              <span className="tnum text-2xl font-medium text-fg">
                {after === null ? "–" : `${after}${NBSP}%`}
              </span>
              <span className="label text-subtle">
                {m.fillPct === null ? "efter" : `från ${m.fillPct}${NBSP}%`}
              </span>
            </p>
          </div>
          <FillBar pct={after} className="h-2.5" />
        </header>

        <div className="rise flex flex-wrap items-center justify-between gap-3" style={rise(1)}>
          <p className="text-md text-muted">
            <span className="tnum text-fg">{formatInt(total)}</span>
            {`${NBSP}pack`}
          </p>
          {places.length > 1 ? (
            <button
              type="button"
              onClick={() => setChoosing(true)}
              aria-label={`Från ${sourceName}. Byt lager`}
              className="inline-flex min-h-11 items-center gap-1 rounded-full border border-line-strong bg-surface px-4 text-md text-fg active:bg-hover"
            >
              <span className="text-subtle">Från:</span>
              <span className="font-medium">{sourceName}</span>
              <Icon name="chevronDown" size={14} />
            </button>
          ) : null}
          <button
            type="button"
            onClick={() =>
              setQty(
                Object.fromEntries(
                  m.rows.map((r) => [
                    r.titleId,
                    r.capacity === null ? (qty[r.titleId] ?? 0) : Math.max(0, r.capacity - r.now),
                  ]),
                ),
              )
            }
            className="min-h-11 rounded-sm border border-line-strong bg-surface px-4 text-md font-medium text-fg active:bg-hover"
          >
            Fyll allt
          </button>
        </div>

        {m.rows.length === 0 ? (
          <p className="text-md text-muted">
            Inga titlar i automaten än. Awish läser facken var 10:e minut.
          </p>
        ) : (
          <ul className="flex flex-col gap-3" aria-label="Titlar">
            {m.rows.map((r, i) => (
              <li key={r.titleId} className="rise" style={rise(i + 2)}>
                <TitleRow
                  row={r}
                  sourceName={sourceName}
                  value={qty[r.titleId] ?? 0}
                  onChange={(v) => set(r.titleId, v, maxFill(r))}
                  counting={counting === r.titleId}
                  onCountToggle={() => setCounting((c) => (c === r.titleId ? null : r.titleId))}
                  onCount={async (value) => {
                    if (!online) {
                      toast({
                        title: "Räkna om kräver uppkoppling",
                        description: "Påfyllningen fungerar ändå; räkna om när nätet är tillbaka.",
                        tone: "critical",
                      });
                      return;
                    }
                    const res = await registerCount({
                      location: "machine",
                      machineId: m.id,
                      titleId: r.titleId,
                      counted: value,
                      note: "Räkna om (Fyll på)",
                    }).catch(() => ({ ok: false as const, error: "Ingen uppkoppling." }));
                    if (!res.ok) {
                      toast({
                        title: "Kunde inte räkna om",
                        description: res.error,
                        tone: "critical",
                      });
                      return;
                    }
                    setCounting(null);
                    onCounted(r.titleId, value);
                    const cap = r.capacity;
                    if (cap !== null) {
                      set(
                        r.titleId,
                        Math.max(0, Math.min(cap - value, Math.max(0, r.home))),
                        Math.max(1, cap - value),
                      );
                    }
                    toast({ title: `Räknat: ${formatInt(value)} i automaten`, tone: "ok" });
                  }}
                />
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="sticky bottom-0 z-10 border-t border-line bg-bg/95 px-4 pt-3 pb-[calc(12px+env(safe-area-inset-bottom))] backdrop-blur">
        <button
          type="button"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onDone(
                m.rows
                  .map((row) => ({ row, quantity: qty[row.titleId] ?? 0 }))
                  .filter((l) => l.quantity > 0),
              );
            } finally {
              setBusy(false);
            }
          }}
          className={cn(
            "flex h-14 w-full items-center justify-center gap-2 rounded-md border text-lg font-medium transition-colors",
            busy
              ? "border-dashed border-line-strong text-disabled"
              : "border-inverse bg-inverse text-on-inverse active:bg-inverse-hover",
          )}
        >
          <Icon name="check" size={20} />
          {busy ? "Sparar…" : total > 0 ? `Klar · ${formatInt(total)}${NBSP}pack` : "Klar"}
        </button>
      </div>
      <Sheet
        open={choosing}
        onClose={() => setChoosing(false)}
        title="Ta pack från"
        eyebrow={m.place}
      >
        <div className="px-5 pb-5">
          <PlaceButtons
            label="Ta pack från"
            places={places}
            value={sourceId}
            onChange={(id) => {
              setChoosing(false);
              onSource(id);
            }}
          />
        </div>
      </Sheet>
    </div>
  );
}

function TitleRow({
  row: r,
  sourceName,
  value,
  onChange,
  counting,
  onCountToggle,
  onCount,
}: {
  row: FillRow;
  /** Lagret packen tas från ("Hemma"). */
  sourceName: string;
  value: number;
  onChange: (v: number) => void;
  counting: boolean;
  onCountToggle: () => void;
  onCount: (value: number) => Promise<void>;
}) {
  const [draft, setDraft] = useState(String(r.now));
  const [saving, setSaving] = useState(false);
  const inputId = `antal-${r.titleId}`;
  const short = value > Math.max(0, r.home);
  return (
    <div className="flex flex-col gap-3 rounded-md border border-line bg-surface p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 flex-col">
          <label htmlFor={inputId} className="truncate text-md font-medium text-fg">
            {r.name}
          </label>
          <span className={cn("meta", short ? "text-signal-fg" : "text-subtle")}>
            {`${sourceName.trim().toLowerCase() === "hemma" ? "hemma" : sourceName}: ${formatInt(r.home)}`}
            {short && r.home > 0 ? ` · ${formatInt(value - r.home)} utan uttag` : ""}
            {short && r.home <= 0 ? " · utan uttag" : ""}
          </span>
        </div>
        <p className="flex shrink-0 flex-col items-end">
          <span className="tnum text-xl font-medium text-fg">
            {formatInt(r.now)}
            <span className="text-subtle">
              {r.capacity === null ? "" : `/${formatInt(r.capacity)}`}
            </span>
          </span>
          {r.emptySlots > 0 ? (
            <span className="label text-signal-fg">
              {`${formatInt(r.emptySlots)} ${r.emptySlots === 1 ? "tomt fack" : "tomma fack"}`}
            </span>
          ) : (
            <span className="label text-subtle">i automaten</span>
          )}
        </p>
      </div>

      <div className="grid grid-cols-[56px_1fr_56px] items-center gap-2">
        <button
          type="button"
          aria-label={`En mindre ${r.name}`}
          onClick={() => onChange(value - 1)}
          disabled={value <= 0}
          className="flex size-14 items-center justify-center rounded-md border border-line-strong bg-raised text-fg active:bg-hover disabled:border-dashed disabled:text-disabled"
        >
          <Icon name="minus" size={24} />
        </button>
        <input
          id={inputId}
          type="number"
          inputMode="numeric"
          pattern="[0-9]*"
          min={0}
          max={maxFill(r)}
          value={value}
          onFocus={(e) => e.currentTarget.select()}
          onChange={(e) => onChange(Number(e.target.value))}
          aria-describedby={`${inputId}-hint`}
          className="tnum h-14 w-full min-w-0 [appearance:textfield] rounded-md border border-line-control bg-bg text-center text-3xl font-medium text-fg [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
          style={{ fontSize: 28 }}
        />
        <button
          type="button"
          aria-label={`En till ${r.name}`}
          onClick={() => onChange(value + 1)}
          disabled={value >= maxFill(r)}
          className="flex size-14 items-center justify-center rounded-md border border-line-strong bg-raised text-fg active:bg-hover disabled:border-dashed disabled:text-disabled"
        >
          <Icon name="plus" size={24} />
        </button>
      </div>
      <span id={`${inputId}-hint`} className="sr-only">
        {r.capacity === null
          ? "Kapaciteten är okänd."
          : `Förslag ${r.suggested}. Plats för ${Math.max(0, r.capacity - r.now)}.`}
      </span>

      {counting ? (
        <form
          className="flex items-center gap-2"
          onSubmit={async (e) => {
            e.preventDefault();
            const n = Number(draft);
            if (!Number.isInteger(n) || n < 0 || n > 10000) return;
            setSaving(true);
            try {
              await onCount(n);
            } finally {
              setSaving(false);
            }
          }}
        >
          <label
            htmlFor={`${inputId}-raknat`}
            className="shrink-0 text-md whitespace-nowrap text-muted"
          >
            I automaten
          </label>
          <input
            id={`${inputId}-raknat`}
            type="number"
            inputMode="numeric"
            pattern="[0-9]*"
            min={0}
            max={10000}
            value={draft}
            autoFocus
            onChange={(e) => setDraft(e.target.value)}
            className="tnum h-11 w-20 rounded-sm border border-line-control bg-bg text-center text-fg"
            style={{ fontSize: 18 }}
          />
          <button
            type="submit"
            disabled={saving}
            className="h-11 rounded-sm border border-inverse bg-inverse px-4 text-md font-medium text-on-inverse disabled:opacity-60"
          >
            {saving ? "Sparar…" : "Spara"}
          </button>
          <button
            type="button"
            onClick={onCountToggle}
            className="h-11 px-2 text-md text-subtle hover:text-fg"
          >
            Avbryt
          </button>
        </form>
      ) : (
        <button
          type="button"
          onClick={() => {
            setDraft(String(r.now));
            onCountToggle();
          }}
          className="-my-1 min-h-11 self-start text-md text-subtle underline-offset-4 hover:text-fg hover:underline"
        >
          Räkna om
        </button>
      )}
    </div>
  );
}

function RejectedList({
  items,
  names,
  onRetryDirect,
  onRemove,
}: {
  items: QueuedRefill[];
  names: readonly FillMachine[];
  onRetryDirect: (item: QueuedRefill) => Promise<void>;
  onRemove: (item: QueuedRefill) => void;
}) {
  const place = new Map(names.map((m) => [m.id, m.place]));
  const title = new Map(names.flatMap((m) => m.rows.map((r) => [r.titleId, r.name] as const)));
  return (
    <section
      aria-label="Sparades inte"
      className="flex flex-col gap-3 rounded-md border border-signal-line bg-signal-soft p-4"
    >
      <p className="label text-signal-fg">Sparades inte</p>
      <ul className="flex flex-col gap-3">
        {items.map((item) => (
          <li key={item.clientId} className="flex flex-col gap-2">
            <p className="text-md text-fg">
              {`${formatInt(item.quantity)}${NBSP}pack ${title.get(item.titleId) ?? "okänd titel"} · ${place.get(item.machineId) ?? "okänd automat"}`}
            </p>
            {item.error ? <p className="text-sm text-muted">{item.error}</p> : null}
            <div className="flex flex-wrap gap-2">
              {item.fromWarehouse ? (
                <button
                  type="button"
                  onClick={() => void onRetryDirect(item)}
                  className="min-h-11 rounded-sm border border-line-strong bg-surface px-3 text-md text-fg"
                >
                  Spara utan uttag
                </button>
              ) : null}
              <button
                type="button"
                onClick={() => onRemove(item)}
                className="min-h-11 px-3 text-md text-subtle hover:text-fg"
              >
                Ta bort
              </button>
            </div>
          </li>
        ))}
      </ul>
    </section>
  );
}
