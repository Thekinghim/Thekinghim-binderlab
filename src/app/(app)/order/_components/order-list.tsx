"use client";

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";

import { Button } from "@/components/ui/button";
import { DataTable, type Column, type SortKey } from "@/components/ui/data-table";
import { StateMessage } from "@/components/ui/state-message";
import { cn } from "@/lib/cn";
import { formatInt, formatKronor, MISSING, NBSP } from "@/lib/format";

import { loadMoreOrders } from "../actions";
import { formatAt } from "../_lib/headline";
import {
  DEFAULT_SORT,
  SORT_KEYS,
  withOrderParams,
  type OrderSort,
  type OrderSortKey,
} from "../_lib/params";
import { rankMap } from "../_lib/refs";
import type { OrderRefs, OrderRow, OrderTotals } from "../_lib/types";

const ROW_HEIGHT = 36;
/** Hämta nästa sida när så här många px återstår av scrollytan. */
const PREFETCH_PX = ROW_HEIGHT * 40;
const TABLE_HEIGHT = 640;

const SORT_LABEL: Record<OrderSortKey, string> = {
  nr: "Ordernummer",
  tid: "Tid",
  titel: "Titel",
  automat: "Automat",
  butik: "Butik",
  belopp: "Belopp",
};

const MOBILE_COLUMNS = new Set(["nr", "titel", "belopp"]);
const MOBILE_WIDTH: Record<string, number> = { nr: 76, belopp: 100 };

const WIDE_QUERY = "(min-width: 768px)";

function subscribeWide(onChange: () => void): () => void {
  const mq = window.matchMedia(WIDE_QUERY);
  mq.addEventListener("change", onChange);
  return () => mq.removeEventListener("change", onChange);
}

/** Bredare än md. På servern antas bred skärm. */
function useWide(): boolean {
  return useSyncExternalStore(
    subscribeWide,
    () => window.matchMedia(WIDE_QUERY).matches,
    () => true,
  );
}

function isSortKey(key: string): key is OrderSortKey {
  return (SORT_KEYS as readonly string[]).includes(key);
}

function sameSort(a: OrderSort, b: OrderSort): boolean {
  return a.key === b.key && a.dir === b.dir;
}

export function OrderList({
  query,
  rows: initialRows,
  nextOffset: initialNext,
  totals,
  refs,
  sort: initialSort,
  timeZone,
  now,
  pending,
  onOpen,
  onServerSort,
}: {
  query: string;
  rows: readonly OrderRow[];
  nextOffset: number | null;
  totals: OrderTotals;
  refs: OrderRefs;
  sort: OrderSort;
  timeZone: string;
  now: Date;
  pending: boolean;
  onOpen: (row: OrderRow) => void;
  /** Sorteringen kräver nya rader från servern (allt är inte laddat). */
  onServerSort: (sort: OrderSort) => void;
}) {
  const [rows, setRows] = useState<readonly OrderRow[]>(initialRows);
  const [next, setNext] = useState<number | null>(initialNext);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sort, setSort] = useState<OrderSort>(initialSort);
  // Tabellen sorterar på en nyckel (servern kan inte följa en sekundär); ett skiftklick
  // ritar om tabellen med bara den första.
  const [resets, setResets] = useState(0);
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
      res = await loadMoreOrders(query, next);
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
  }, [next, query]);

  const loadMoreRef = useRef(loadMore);
  useEffect(() => {
    loadMoreRef.current = loadMore;
  }, [loadMore]);
  const canAutoLoad = !error;
  const canAutoLoadRef = useRef(canAutoLoad);
  useEffect(() => {
    canAutoLoadRef.current = canAutoLoad;
  }, [canAutoLoad]);

  const wrapper = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = wrapper.current;
    if (!el) return;
    const onScroll = (e: Event) => {
      const t = e.target as HTMLElement | null;
      if (!t || !canAutoLoadRef.current) return;
      if (t.scrollHeight - t.scrollTop - t.clientHeight < PREFETCH_PX) void loadMoreRef.current();
    };
    el.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => el.removeEventListener("scroll", onScroll, { capture: true });
  }, []);

  // --- Sortering -----------------------------------------------------------
  const onSortChange = useCallback(
    (keys: ReadonlyArray<SortKey>) => {
      const first = keys[0];
      let nextSort: OrderSort;
      if (!first || !isSortKey(first.key)) {
        // Tredje klicket tar bort sorteringen i tabellen. Står listan redan i
        // standardordningen (nyaste först) vänder vi den i stället.
        nextSort = sameSort(sort, DEFAULT_SORT) ? { key: "tid", dir: "asc" } : DEFAULT_SORT;
      } else {
        nextSort = { key: first.key, dir: first.dir };
      }
      if (keys.length > 1) setResets((n) => n + 1);
      if (sameSort(nextSort, sort)) return;
      setSort(nextSort);
      if (complete) {
        // Allt är laddat: tabellen sorterar själv, URL:en följer med utan serverförfrågan.
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

  // --- Kolumner ------------------------------------------------------------
  const wide = useWide();
  const allColumns = useMemo<Column<OrderRow>[]>(() => {
    const titleRank = rankMap(refs.titles);
    const machineRank = rankMap(refs.machines);
    const storeRank = rankMap(refs.stores);
    const titles = new Map(refs.titles.map((t) => [t.id, t.name]));
    const machines = new Map(refs.machines.map((m) => [m.id, m]));
    const stores = new Map(refs.stores.map((s) => [s.id, s.name]));
    const rank = (m: Map<string, number>, id: string | null) =>
      id === null ? Number.NaN : (m.get(id) ?? Number.NaN);
    return [
      {
        key: "nr",
        header: "Ordernummer",
        width: 132,
        hideable: false,
        sortValue: (r) => r.externalId,
        render: (r) => (
          <button
            type="button"
            aria-haspopup="dialog"
            aria-label={`Visa order ${r.externalId}`}
            onClick={() => onOpen(r)}
            className="rounded-xs font-mono text-sm text-fg underline decoration-line-control underline-offset-4 transition-colors hover:decoration-fg"
          >
            {r.externalId}
          </button>
        ),
        footer: "Summa",
      },
      {
        key: "tid",
        header: "Tid",
        width: 132,
        sortValue: (r) => Date.parse(r.orderedAt),
        render: (r) => (
          <span className="tnum font-mono text-sm text-muted">
            {formatAt(r.orderedAt, timeZone, now)}
          </span>
        ),
      },
      {
        key: "titel",
        header: "Titel",
        width: 240,
        sortValue: (r) => rank(titleRank, r.titleId),
        render: (r) => {
          const name = r.titleId ? titles.get(r.titleId) : undefined;
          if (name) return <span title={name}>{name}</span>;
          return (
            <span className="text-muted" title={r.rawTitle ?? undefined}>
              {r.rawTitle ?? MISSING}
            </span>
          );
        },
      },
      {
        key: "automat",
        header: "Automat",
        width: 112,
        sortValue: (r) => rank(machineRank, r.machineId),
        render: (r) => {
          const m = r.machineId ? machines.get(r.machineId) : undefined;
          return m ? (
            <span className="font-mono text-sm" title={m.name}>
              {m.code}
            </span>
          ) : (
            <span className="text-muted">Okopplad</span>
          );
        },
      },
      {
        key: "butik",
        header: "Butik",
        width: 200,
        sortValue: (r) => rank(storeRank, r.storeId),
        render: (r) => {
          const name = r.storeId ? stores.get(r.storeId) : undefined;
          return name ? (
            <span title={name}>{name}</span>
          ) : (
            <span className="text-muted">{MISSING}</span>
          );
        },
      },
      {
        key: "belopp",
        header: "Belopp",
        numeric: true,
        width: 120,
        sortValue: (r) => r.amountOre,
        render: (r) => formatKronor(r.amountOre / 100),
        footer: formatKronor(totals.amountOre / 100),
      },
    ];
  }, [refs, timeZone, now, onOpen, totals.amountOre]);
  // Under 768 px: ordernummer, titel och belopp ryms utan sidledsscroll (resten finns i detaljvyn).
  const columns = useMemo(
    () =>
      wide
        ? allColumns
        : allColumns
            .filter((c) => MOBILE_COLUMNS.has(c.key))
            .map((c) =>
              c.key === "titel"
                ? { ...c, width: undefined }
                : { ...c, width: MOBILE_WIDTH[c.key], header: c.key === "nr" ? "Nr" : c.header },
            ),
    [allColumns, wide],
  );

  const defaultSort = useMemo(() => [{ key: sort.key, dir: sort.dir }], [sort]);
  const sortSig = `${sort.key}:${sort.dir}:${resets}`;
  const partial = rows.length < totals.count;

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <p className="tnum font-mono text-xs text-muted" aria-live="polite" aria-atomic="true">
          <span className="text-fg">{formatInt(totals.count)}</span>
          {NBSP}order
          {partial ? (
            <>
              <span aria-hidden className="text-subtle">
                {" · "}
              </span>
              <span className="text-fg">{formatInt(rows.length)}</span> laddade
            </>
          ) : null}
          <span aria-hidden className="text-subtle">
            {" · "}
          </span>
          sorterat på <span className="text-fg">{SORT_LABEL[sort.key]}</span>
          <span aria-hidden> {sort.dir === "asc" ? "↑" : "↓"}</span>
          <span className="sr-only"> {sort.dir === "asc" ? "stigande" : "fallande"}</span>
          {pending ? (
            <>
              <span aria-hidden className="text-subtle">
                {" · "}
              </span>
              hämtar
            </>
          ) : null}
        </p>
        <ExportButton count={totals.count} />
      </div>

      <div
        ref={wrapper}
        className={cn("min-w-0 transition-opacity duration-fast", pending && "opacity-60")}
        aria-busy={pending || undefined}
      >
        <DataTable
          key={sortSig}
          columns={columns}
          rows={rows}
          rowKey={(r) => r.id}
          caption={`Order, ${formatInt(totals.count)} st, sorterade på ${SORT_LABEL[sort.key].toLowerCase()}`}
          defaultSort={defaultSort}
          onSortChange={onSortChange}
          virtualize={rows.length > 200}
          dense
          surface="bg"
          maxHeight={rows.length > 200 ? TABLE_HEIGHT : undefined}
        />
      </div>

      {next !== null || error ? (
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <p className="tnum font-mono text-xs text-muted">
            Visar {formatInt(rows.length)} av {formatInt(totals.count)}.
          </p>
          {error ? (
            <StateMessage
              kind="loading-failed"
              compact
              message={error}
              action={{ label: "Försök igen", onClick: () => void loadMore() }}
            />
          ) : (
            <Button size="sm" loading={loading} onClick={() => void loadMore()}>
              Ladda fler
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}

/** Hämtar CSV:n för hela urvalet (alla rader, inte bara de laddade) i vald sortering. */
function ExportButton({ count }: { count: number }) {
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
    <div className="flex flex-col items-start gap-2 sm:items-end">
      <Button
        size="sm"
        iconLeft="download"
        loading={busy}
        onClick={() => void run()}
        aria-label={`Exportera ${formatInt(count)} order som CSV`}
      >
        Exportera CSV
      </Button>
      {error ? (
        <p role="alert" className="text-xs text-signal-fg">
          {error}
        </p>
      ) : null}
    </div>
  );
}
