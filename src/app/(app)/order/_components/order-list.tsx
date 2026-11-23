"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { businessDateAt } from "@/analytics/todos/time";
import { StatusTag } from "@/components/ui/status-tag";
import { Button } from "@/components/v2/button";
import { formatAmountOre } from "@/components/v2/format";
import { MachineThumb } from "@/components/v2/machine-thumb";
import { PackImage } from "@/components/v2/pack-image";
import { StoreFace } from "@/components/v2/store-face";
import { cn } from "@/lib/cn";
import { formatInt, MISSING, NBSP } from "@/lib/format";

import { loadMoreOrders } from "../actions";
import { groupByDay, timeOf, type DayGroup } from "../_lib/day-groups";
import { formatAt } from "../_lib/headline";
import { nextSortFor, sortRows } from "../_lib/list-sort";
import { withOrderParams, type OrderSort, type OrderSortKey } from "../_lib/params";
import { isTestPurchase, TEST_PURCHASE_LABEL } from "../_lib/test-purchase";
import type {
  MachineOption,
  OrderDayTotal,
  OrderRefs,
  OrderRow,
  OrderTotals,
  StoreOption,
} from "../_lib/types";

/** Hämta nästa sida när listans slut är så här nära (under skärmkanten). */
const PREFETCH_MARGIN = "0px 0px 1200px 0px";

const SORT_LABEL: Record<OrderSortKey, string> = {
  nr: "ordernummer",
  tid: "tid",
  titel: "titel",
  automat: "automat",
  butik: "butik",
  belopp: "belopp",
};

/** Kolumnerna på datorn: packen och titeln först, ordernumret sist i grått. */
const HEAD: ReadonlyArray<{ key: OrderSortKey; label: string; num?: boolean }> = [
  { key: "titel", label: "Titel" },
  { key: "automat", label: "Automat" },
  { key: "butik", label: "Butik" },
  { key: "belopp", label: "Belopp", num: true },
  { key: "nr", label: "Ordernr", num: true },
];

function sameSort(a: OrderSort, b: OrderSort): boolean {
  return a.key === b.key && a.dir === b.dir;
}

/**
 * Orderraderna: packbilden först, sedan titel och tid, automat, butik, belopp och sist
 * ordernumret i grått. I tidsordning (nyaste först) står raderna under dagsrubriker med
 * dagens antal och summa. Telefon: bara pack, titel, automat · tid och belopp (CSS).
 * Hela raden är en knapp som öppnar ordern. Sidan scrollar; nästa sida hämtas i förväg.
 */
export function OrderList({
  query,
  rows: initialRows,
  nextOffset: initialNext,
  totals,
  days,
  refs,
  sort: initialSort,
  timeZone,
  now,
  pending,
  onOpen,
  onServerSort,
  changed,
}: {
  query: string;
  rows: readonly OrderRow[];
  nextOffset: number | null;
  totals: OrderTotals;
  days: readonly OrderDayTotal[];
  refs: OrderRefs;
  sort: OrderSort;
  timeZone: string;
  now: Date;
  pending: boolean;
  onOpen: (row: OrderRow) => void;
  /** Sorteringen kräver nya rader från servern (allt är inte laddat). */
  onServerSort: (sort: OrderSort) => void;
  /** Testköp markerade eller ångrade i detaljvyn (order-id → testköp). */
  changed: ReadonlyMap<string, boolean>;
}) {
  const [rows, setRows] = useState<readonly OrderRow[]>(initialRows);
  const [next, setNext] = useState<number | null>(initialNext);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<OrderSort>(initialSort);
  const complete = next === null;

  // --- Nästa sida ----------------------------------------------------------
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const inFlight = useRef(false);

  const loadMore = useCallback(async () => {
    if (inFlight.current || next === null) return;
    inFlight.current = true;
    setLoading(true);
    setError(null);
    let res: Awaited<ReturnType<typeof loadMoreOrders>>;
    try {
      res = await loadMoreOrders(query, {
        offset: next,
        afterId: rows.length > 0 ? (rows[rows.length - 1]?.id ?? null) : null,
      });
    } catch {
      res = { ok: false, message: "Fler order gick inte att hämta. Kontrollera anslutningen." };
    }
    inFlight.current = false;
    if (!mounted.current) return;
    setLoading(false);
    if (!res.ok) {
      setError(res.message);
      return;
    }
    setRows((cur) => {
      const seen = new Set(cur.map((r) => r.id));
      return [...cur, ...res.data.rows.filter((r) => !seen.has(r.id))];
    });
    setNext(res.data.nextOffset);
  }, [next, query, rows]);

  const loadMoreRef = useRef(loadMore);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  }, [loadMore]);
  const sentinel = useRef<HTMLDivElement>(null);
  const canAutoLoad = !error && next !== null;
  useEffect(() => {
    const el = sentinel.current;
    if (!el || !canAutoLoad || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) void loadMoreRef.current();
      },
      { rootMargin: PREFETCH_MARGIN },
    );
    io.observe(el);
    return () => io.disconnect();
  }, [canAutoLoad, rows.length]);

  // --- Sortering -----------------------------------------------------------
  const changeSort = useCallback(
    (key: OrderSortKey) => {
      const nextSort = nextSortFor(sort, key);
      if (sameSort(nextSort, sort)) return;
      setSort(nextSort);
      if (complete) {
        // Allt är laddat: listan sorterar själv, URL:en följer med utan serverförfrågan.
        const sp = withOrderParams(new URLSearchParams(window.location.search), { sort: nextSort });
        const q = sp.toString();
        window.history.replaceState(
          window.history.state,
          "",
          q ? `?${q}` : window.location.pathname,
        );
      } else {
        onServerSort(nextSort);
      }
    },
    [complete, onServerSort, sort],
  );

  // --- Raderna ---------------------------------------------------------------
  const lookups = useMemo(
    () => ({
      titles: new Map(refs.titles.map((t) => [t.id, t.name])),
      machines: new Map(refs.machines.map((m) => [m.id, m])),
      stores: new Map(refs.stores.map((st) => [st.id, st])),
    }),
    [refs],
  );
  const shown = useMemo(
    () => (complete ? sortRows(rows, sort, refs) : rows),
    [complete, rows, sort, refs],
  );
  const today = useMemo(() => businessDateAt(now, timeZone), [now, timeZone]);
  // I tidsordning (nyaste först) grupperas raderna per dag; annars en enda lista.
  const groups: DayGroup[] | null = useMemo(
    () => (sort.key === "tid" && sort.dir === "desc" ? groupByDay(shown, days, today) : null),
    [shown, sort, days, today],
  );

  const renderRow = (r: OrderRow, group: DayGroup | null) => {
    const clock = timeOf(r.orderedAt, timeZone);
    const recent = group !== null && (group.label === "I dag" || group.label === "I går");
    return (
      <OrderRowItem
        key={r.id}
        row={r}
        title={(r.titleId ? lookups.titles.get(r.titleId) : undefined) ?? null}
        machine={r.machineId ? lookups.machines.get(r.machineId) : undefined}
        store={r.storeId ? lookups.stores.get(r.storeId) : undefined}
        when={
          recent ? `${group.label.toLowerCase()} ${clock}` : formatAt(r.orderedAt, timeZone, now)
        }
        shortWhen={group ? clock : formatAt(r.orderedAt, timeZone, now)}
        test={isTestPurchase(r, changed)}
        onOpen={onOpen}
      />
    );
  };

  const partial = rows.length < totals.count;

  return (
    <div className="ord-list">
      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {formatInt(totals.count)} order{partial ? `, ${formatInt(rows.length)} visas` : ""},
        sorterade på {SORT_LABEL[sort.key]} {sort.dir === "asc" ? "stigande" : "fallande"}
        {pending ? ", hämtar" : ""}
      </p>

      <div className="ord-head" role="group" aria-label="Sortera listan">
        {HEAD.map((h) => {
          const active = sort.key === h.key;
          const dirText = active ? (sort.dir === "asc" ? "stigande" : "fallande") : null;
          return (
            <button
              key={h.key}
              type="button"
              className={cn("ord-hc", h.num && "num", active && "on")}
              aria-pressed={active}
              aria-label={`Sortera på ${h.label.toLowerCase()}${dirText ? `, nu ${dirText}` : ""}`}
              onClick={() => changeSort(h.key)}
            >
              {h.label}
              <span aria-hidden="true" className="ar">
                {active ? (sort.dir === "asc" ? "↑" : "↓") : ""}
              </span>
            </button>
          );
        })}
      </div>

      <div className={cn("ord-body", pending && "busy")} aria-busy={pending || undefined}>
        {groups ? (
          groups.map((g) => (
            <section key={g.date} className="ord-day" aria-labelledby={`ord-d-${g.date}`}>
              <h3 id={`ord-d-${g.date}`} className="ord-dh">
                <b>{g.label}</b>
                {g.total ? (
                  <em className="tnum">
                    {formatInt(g.total.count)}
                    {NBSP}order · {formatAmountOre(g.total.amountOre)}
                  </em>
                ) : null}
              </h3>
              <ul>{g.rows.map((r) => renderRow(r, g))}</ul>
            </section>
          ))
        ) : (
          <ul className="ord-flat">{shown.map((r) => renderRow(r, null))}</ul>
        )}
      </div>

      <div ref={sentinel} aria-hidden="true" />

      {next !== null || error ? (
        <div className="ord-foot">
          <p className="tnum">
            Visar {formatInt(rows.length)} av {formatInt(totals.count)}
          </p>
          {error ? (
            <span className="flex flex-wrap items-center gap-3">
              <span role="alert" className="text-v2-crit-text">
                {error}
              </span>
              <Button size="sm" onClick={() => void loadMore()}>
                Försök igen
              </Button>
            </span>
          ) : (
            <Button size="sm" pending={loading} onClick={() => void loadMore()}>
              Visa fler
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

function OrderRowItem({
  row: r,
  title,
  machine,
  store,
  when,
  shortWhen,
  test,
  onOpen,
}: {
  row: OrderRow;
  title: string | null;
  machine: MachineOption | undefined;
  store: StoreOption | undefined;
  when: string;
  shortWhen: string;
  test: boolean;
  onOpen: (row: OrderRow) => void;
}) {
  const name = title ?? r.rawTitle;
  return (
    <li className="ord-li">
      <button
        type="button"
        className={cn("ord-row", test && "test")}
        aria-haspopup="dialog"
        data-order-button={r.id}
        onClick={() => onOpen(r)}
      >
        <span className="ord-c ord-c-t">
          <span className="ord-pk">
            <PackImage title={name} size="m" />
          </span>
          <span className="ord-tx">
            <span className="ord-tn">
              <span className={cn("truncate", !title && "text-v2-mute")} title={name ?? undefined}>
                {name ?? MISSING}
              </span>
              {test ? (
                <StatusTag status="neutral" className="h-5 shrink-0">
                  {TEST_PURCHASE_LABEL}
                </StatusTag>
              ) : null}
            </span>
            {/* Dator: när. Telefon: automat och tid (kolumnerna finns inte där). */}
            <span className="ord-ts ord-dk tnum">{when}</span>
            <span className="ord-ts ord-ph tnum">
              <MachineThumb
                machineId={r.machineId}
                look={machine?.appearance}
                size="xs"
                className="ord-mt-s"
              />
              <span className="shrink-0">{machine ? machine.code : "Okopplad"}</span>
              <span aria-hidden="true" className="shrink-0">
                ·
              </span>
              <span className="min-w-0 truncate">{shortWhen}</span>
            </span>
          </span>
        </span>
        <span className="ord-c ord-c-m ord-dk">
          {machine ? (
            <>
              <MachineThumb machineId={machine.id} look={machine.appearance} size="xs" />
              <span className="ord-tx">
                <span className="ord-mc">{machine.code}</span>
                <span className="ord-ts truncate">{machine.name}</span>
              </span>
            </>
          ) : (
            <span className="text-v2-mute">Okopplad</span>
          )}
        </span>
        <span className="ord-c ord-c-s ord-dk">
          {store ? (
            <>
              <StoreFace
                name={store.name}
                storeType={store.storeType}
                city={store.city}
                size="sm"
              />
              <span className="truncate" title={store.name}>
                {store.name}
              </span>
            </>
          ) : (
            <span className="text-v2-mute">{MISSING}</span>
          )}
        </span>
        <span className={cn("ord-c ord-c-a tnum", test && "text-v2-mute line-through")}>
          {formatAmountOre(r.amountOre)}
        </span>
        <span className="ord-c ord-c-n ord-dk tnum">#{r.externalId}</span>
      </button>
    </li>
  );
}

/** Hämtar CSV:n för hela urvalet (alla rader, inte bara de laddade) i vald sortering. */
export function ExportButton({ count }: { count: number }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      const sp = withOrderParams(new URLSearchParams(window.location.search), { orderId: null });
      const res = await fetch(`/order/export?${sp.toString()}`, { cache: "no-store" });
      if (!res.ok) {
        setError((await res.text()) || "Exporten misslyckades.");
        return;
      }
      const blob = await res.blob();
      const name =
        /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? "order.csv";
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = name;
      a.rel = "noopener";
      a.style.display = "none";
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch {
      setError("Exporten misslyckades. Kontrollera anslutningen och försök igen.");
    } finally {
      setBusy(false);
    }
  };

  return (
    // CSV är ett datorverktyg: dold på telefonen (CSS).
    <div className="ord-export">
      <Button
        size="sm"
        pending={busy}
        onClick={() => void run()}
        aria-label={`Exportera ${formatInt(count)} order som CSV`}
      >
        <svg
          width="15"
          height="15"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
          aria-hidden="true"
        >
          <path d="M12 4v11m0 0-4.5-4.5M12 15l4.5-4.5M5 19.5h14" />
        </svg>
        Exportera CSV
      </Button>
      {error ? (
        <p role="alert" className="text-v2-xs text-v2-crit-text">
          {error}
        </p>
      ) : null}
    </div>
  );
}
