"use client";

import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type CSSProperties,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";
import { cn } from "@/lib/cn";
import { downloadCsv, toCsv, type CsvCell } from "@/lib/csv";
import { formatDecimal, formatInt } from "@/lib/format";
import { Button } from "./button";
import { Icon } from "./icon";

// ---------------------------------------------------------------------------
// Typer
// ---------------------------------------------------------------------------

export type Column<T> = {
  key: string;
  header: string;
  /** Förklaring när pekaren vilar på rubriken (title-attributet). */
  headerTitle?: string;
  /** Tal: högerställt, Geist med tabulära siffror. Sorteras fallande först. */
  numeric?: boolean;
  /** Värde att sortera på. Utan detta går kolumnen inte att sortera. */
  sortValue?: (row: T) => number | string;
  render: (row: T) => ReactNode;
  /** Fotrad, t.ex. summa */
  footer?: ReactNode;
  className?: string;
  /** Göm kolumnen under md-brytpunkten */
  hideOnMobile?: boolean;
  /** Bredd i px. Används i virtualiserat läge (fast tabellayout); kolumner utan bredd delar på resten. */
  width?: number;
  /** Får slås av i kolumnvalet. Standard true. */
  hideable?: boolean;
  /** Dold från start (kan slås på i kolumnvalet). */
  defaultHidden?: boolean;
  /** Värde i CSV-export. Saknas den används sortValue, annars blir cellen tom. */
  csv?: (row: T) => CsvCell;
};

export type SortDir = "asc" | "desc";
export type SortKey = { key: string; dir: SortDir };
/** Bakåtkompatibel form för en enda sorteringsnyckel. */
export type SortState = SortKey | null;

export type DataTableProps<T> = {
  columns: ReadonlyArray<Column<T>>;
  rows: ReadonlyArray<T>;
  rowKey: (row: T) => string;
  caption: string;
  /** Visa bildtexten synligt (annars bara för skärmläsare) */
  showCaption?: boolean;
  /** En nyckel, eller flera för primär + sekundär sortering. */
  defaultSort?: SortState | ReadonlyArray<SortKey>;
  /** Markera rader som kräver uppmärksamhet (signalfärgad markör + text i rad) */
  isFlagged?: (row: T) => boolean;
  /** Radhöjd 36 px i stället för 44 px */
  dense?: boolean;
  className?: string;
  /** Rendera bara synliga rader. Standard: på när rows.length > 200. */
  virtualize?: boolean;
  /** Höjd på scrollytan. Standard 560 px när tabellen virtualiseras, annars ingen gräns. */
  maxHeight?: number | string;
  /** Extra rader som renderas ovanför och under det synliga. Standard 8. */
  overscan?: number;
  /** Visa knappen Kolumner med meny för att slå av och på kolumner. */
  columnPicker?: boolean;
  /** Visa knappen Exportera CSV. Filnamnet får ändelsen .csv. */
  exportFileName?: string;
  /** Verktygsrad med radräknare och knappar. En nod läggs till vänster om räknaren. */
  toolbar?: ReactNode | true;
  /** Visa uppmätt sorteringstid i verktygsraden. */
  showTiming?: boolean;
  /** Första kolumnen ligger kvar vid horisontell scroll. Standard true. */
  stickyFirstColumn?: boolean;
  /** Ytan tabellen ligger på; används för sticky rubrik, fot och första kolumn. */
  surface?: "surface" | "raised" | "bg";
  onSortChange?: (sort: ReadonlyArray<SortKey>) => void;
  /**
   * Klick var som helst på raden (utom på länkar, knappar och fält i den). Bara för mus och
   * touch: raden måste ha en länk eller knapp för tangentbordet. Ska vara stabil (useCallback).
   */
  onRowClick?: (row: T) => void;
};

// ---------------------------------------------------------------------------
// Sortering
// ---------------------------------------------------------------------------

const collator = new Intl.Collator("sv-SE", { numeric: true, sensitivity: "base" });

export type SortSpec<T> = { get: (row: T) => number | string; dir: SortDir };

/**
 * Stabil flernyckelssortering. Returnerar radernas ordning som index.
 *
 * Varje nyckel läses en gång per rad till en Float64Array. Text rangordnas
 * först med svensk collator över de unika värdena (oftast få), så att själva
 * sorteringen bara jämför tal. Fallande ordning = negerad nyckel. Saknade tal
 * (NaN) hamnar alltid sist. Lika värden behåller ursprunglig ordning.
 */
export function sortOrder<T>(
  rows: ReadonlyArray<T>,
  specs: ReadonlyArray<SortSpec<T>>,
): Int32Array {
  const n = rows.length;
  const idx = new Int32Array(n);
  for (let i = 0; i < n; i++) idx[i] = i;
  if (specs.length === 0 || n < 2) return idx;

  const keys: Float64Array[] = specs.map(({ get, dir }) => {
    const raw: Array<number | string> = new Array(n);
    let allNumbers = true;
    for (let i = 0; i < n; i++) {
      const v = get(rows[i] as T);
      raw[i] = v;
      if (typeof v !== "number") allNumbers = false;
    }
    const out = new Float64Array(n);
    const sign = dir === "asc" ? 1 : -1;
    if (allNumbers) {
      for (let i = 0; i < n; i++) {
        const v = raw[i] as number;
        out[i] = Number.isNaN(v) ? Number.POSITIVE_INFINITY : sign * v;
      }
      return out;
    }
    const unique = Array.from(new Set(raw.map(String))).sort(collator.compare);
    const rank = new Map<string, number>();
    // Collatorn kan likställa olika strängar (t.ex. versaler); de får samma rang.
    let r = 0;
    for (let u = 0; u < unique.length; u++) {
      const cur = unique[u] as string;
      if (u > 0 && collator.compare(unique[u - 1] as string, cur) !== 0) r = u;
      rank.set(cur, r);
    }
    for (let i = 0; i < n; i++) out[i] = sign * (rank.get(String(raw[i])) ?? 0);
    return out;
  });

  const k0 = keys[0] as Float64Array;
  const rest = keys.slice(1);
  idx.sort((a, b) => {
    const x = k0[a] as number;
    const y = k0[b] as number;
    if (x < y) return -1;
    if (x > y) return 1;
    for (const k of rest) {
      const p = k[a] as number;
      const q = k[b] as number;
      if (p < q) return -1;
      if (p > q) return 1;
    }
    return a - b;
  });
  return idx;
}

function normalizeSort(s: DataTableProps<unknown>["defaultSort"]): SortKey[] {
  if (!s) return [];
  if (Array.isArray(s)) return [...(s as ReadonlyArray<SortKey>)];
  return [s as SortKey];
}

function firstDir<T>(col: Column<T>): SortDir {
  // Tal sorteras fallande först (störst överst), text stigande.
  return col.numeric ? "desc" : "asc";
}

/** Nästa riktning i cykeln, eller null när nyckeln ska bort. */
function cycle<T>(col: Column<T>, current: SortDir | undefined): SortDir | null {
  const first = firstDir(col);
  if (!current) return first;
  if (current === first) return first === "asc" ? "desc" : "asc";
  return null;
}

/**
 * Kör fn och mäter tiden. Mätvärdet är bara diagnostik för verktygsraden
 * (visas med suppressHydrationWarning); ordningen själv är deterministisk.
 */
function measure<R>(fn: () => R): [R, number] {
  const t0 = performance.now();
  const result = fn();
  return [result, performance.now() - t0];
}

function formatMs(ms: number): string {
  return ms < 10 ? `${formatDecimal(ms)} ms` : `${formatInt(ms)} ms`;
}

// ---------------------------------------------------------------------------
// Celler
// ---------------------------------------------------------------------------

/** Under md: så här få rader syns ändå alla, så räknaren döljs. */
const FEW_ROWS = 5;
/** Verktygsknapparna under md: bara ikonen, 44 px tryckyta. */
const TOOL_BUTTON = "max-md:size-11 max-md:justify-center max-md:gap-0 max-md:px-0";

const surfaceVar = {
  surface: "[--dt-bg:var(--bl-surface)]",
  raised: "[--dt-bg:var(--bl-surface-raised)]",
  bg: "[--dt-bg:var(--bl-bg)]",
} as const;

type CellCtx = {
  last: number;
  flaggable: boolean;
  stickyFirst: boolean;
  scrolledX: boolean;
  /** Tabellen är bredare än ytan. Först då behöver den fasta kolumnen egen bakgrund. */
  overflowX: boolean;
  fixed: boolean;
};

function edgeClasses<T>(col: Column<T>, ci: number, ctx: CellCtx, z = "z-[1]"): string {
  return cn(
    ci === 0 && (ctx.flaggable ? "pl-4" : "pl-0"),
    ci === ctx.last && "pr-0",
    col.hideOnMobile && "hidden md:table-cell",
    ci === 0 &&
      ctx.stickyFirst &&
      cn(
        // Avdelaren ritas som pseudoelement så att radlinjerna löper obrutna.
        "sticky left-0 after:pointer-events-none after:absolute after:inset-y-0 after:right-0 after:w-px after:bg-line after:transition-opacity after:duration-fast after:ease-instrument",
        z,
        // Utan horisontell scroll smälter kolumnen in i ytan den ligger på.
        ctx.overflowX && "bg-[var(--dt-bg)]",
        ctx.scrolledX ? "after:opacity-100" : "after:opacity-0",
      ),
  );
}

type RowProps<T> = {
  row: T;
  columns: ReadonlyArray<Column<T>>;
  ariaRowIndex: number;
  flagged: boolean;
  height: number;
  ctx: CellCtx;
  onRowClick?: (row: T) => void;
};

/** Klicket gällde en egen kontroll i raden (eller var en textmarkering), inte raden. */
function ownControl(e: ReactMouseEvent<HTMLTableRowElement>): boolean {
  const t = e.target as Element | null;
  if (t?.closest("a, button, input, select, textarea, label, [role='button']")) return true;
  return Boolean(window.getSelection()?.toString());
}

function RowImpl<T>({ row, columns, ariaRowIndex, flagged, height, ctx, onRowClick }: RowProps<T>) {
  return (
    <tr
      aria-rowindex={ariaRowIndex}
      style={ctx.fixed ? { height } : undefined}
      onClick={
        onRowClick
          ? (e) => {
              if (!ownControl(e)) onRowClick(row);
            }
          : undefined
      }
      className={cn(
        "group transition-colors duration-fast ease-instrument hover:bg-hover",
        onRowClick && "cursor-pointer",
      )}
    >
      {columns.map((col, ci) => (
        <td
          key={col.key}
          style={{ height }}
          className={cn(
            "border-b border-line px-3 py-0 align-middle",
            col.numeric ? "tnum text-right text-base" : "text-left",
            ctx.fixed && "overflow-hidden text-ellipsis whitespace-nowrap",
            ci === 0 && ctx.flaggable && !ctx.stickyFirst && "relative",
            ci === 0 && ctx.stickyFirst && ctx.overflowX && "group-hover:bg-hover",
            edgeClasses(col, ci, ctx),
            col.className,
          )}
        >
          {ci === 0 && flagged ? (
            <>
              <span
                aria-hidden
                className="absolute top-1/2 left-0 size-1.5 -translate-y-1/2 bg-signal"
              />
              <span className="sr-only">Kräver åtgärd: </span>
            </>
          ) : null}
          {col.render(row)}
        </td>
      ))}
    </tr>
  );
}

const Row = memo(RowImpl) as typeof RowImpl;

// ---------------------------------------------------------------------------
// Kolumnval
// ---------------------------------------------------------------------------

function ColumnMenu<T>({
  columns,
  hidden,
  onToggle,
}: {
  columns: ReadonlyArray<Column<T>>;
  hidden: ReadonlySet<string>;
  onToggle: (key: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const menuId = useId();
  const countId = useId();
  // Menyn förankras i knappens högerkant om den får plats, annars i vänsterkanten.
  const [align, setAlign] = useState<"left" | "right">("right");
  // Under knappen om menyn får plats där, annars ovanför (knappen nära fönstrets nederkant).
  const [side, setSide] = useState<"below" | "above">("below");
  const visibleCount = columns.filter((c) => !hidden.has(c.key)).length;

  useEffect(() => {
    if (!open) return;
    itemRefs.current[0]?.focus();
    const onDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", onDown);
    return () => document.removeEventListener("pointerdown", onDown);
  }, [open]);

  // Läge räknas innan menyn visas, så att den aldrig syns på fel ställe först.
  const place = () => {
    setAlign(menuAlign(buttonRef.current));
    const r = buttonRef.current?.getBoundingClientRect();
    setSide(r ? menuSide(r, columnMenuHeight(columns.length), window.innerHeight) : "below");
  };

  const close = (refocus: boolean) => {
    setOpen(false);
    if (refocus) buttonRef.current?.focus();
  };

  const onMenuKey = (e: ReactKeyboardEvent<HTMLDivElement>) => {
    const items = itemRefs.current.filter((el): el is HTMLButtonElement => el !== null);
    const at = items.indexOf(document.activeElement as HTMLButtonElement);
    const move = (i: number) => {
      e.preventDefault();
      items[(i + items.length) % items.length]?.focus();
    };
    switch (e.key) {
      case "ArrowDown":
        return move(at + 1);
      case "ArrowUp":
        return move(at - 1);
      case "Home":
        return move(0);
      case "End":
        return move(items.length - 1);
      case "Escape":
        e.preventDefault();
        return close(true);
      case "Tab":
        return close(false);
    }
  };

  return (
    <div ref={rootRef} className="relative">
      <Button
        ref={buttonRef}
        size="sm"
        iconLeft="columns"
        className={TOOL_BUTTON}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => {
          if (!open) place();
          setOpen((o) => !o);
        }}
        onKeyDown={(e) => {
          if (e.key === "ArrowDown" && !open) {
            e.preventDefault();
            place();
            setOpen(true);
          }
        }}
      >
        <span className="max-md:sr-only">Kolumner</span>
        {visibleCount < columns.length ? (
          <span className="tnum ml-1.5 font-mono text-xs text-subtle max-md:hidden">
            {visibleCount}/{columns.length}
          </span>
        ) : null}
      </Button>
      {open ? (
        <div
          data-side={side}
          className={cn(
            "absolute z-30 w-60 max-w-[calc(100vw-2rem)] rounded-sm border border-line-strong bg-raised motion-safe:animate-[bl-fade_120ms_var(--bl-ease)]",
            align === "right" ? "right-0" : "left-0",
            side === "below" ? "top-full mt-1" : "bottom-full mb-1",
          )}
        >
          <div
            id={menuId}
            role="menu"
            aria-label="Visade kolumner"
            aria-describedby={countId}
            onKeyDown={onMenuKey}
            className="py-1"
          >
            {columns.map((col, i) => {
              const checked = !hidden.has(col.key);
              const locked = col.hideable === false || (checked && visibleCount === 1);
              return (
                <button
                  key={col.key}
                  ref={(el) => {
                    itemRefs.current[i] = el;
                  }}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={checked}
                  aria-disabled={locked || undefined}
                  tabIndex={-1}
                  onClick={() => {
                    if (!locked) onToggle(col.key);
                  }}
                  className={cn(
                    "flex h-8 w-full items-center gap-2.5 px-2.5 text-left text-sm outline-offset-[-2px] transition-colors duration-fast ease-instrument",
                    locked ? "cursor-default text-subtle" : "text-fg hover:bg-hover focus:bg-hover",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "grid size-3 shrink-0 place-items-center rounded-xs border",
                      checked ? "border-fg bg-fg text-bg" : "border-line-control",
                      locked && checked && "border-line-control bg-line-control",
                    )}
                  >
                    {checked ? <Icon name="check" size={10} strokeWidth={2} /> : null}
                  </span>
                  <span className="min-w-0 flex-1 truncate">{col.header}</span>
                  {col.hideable === false ? <span className="label text-subtle">Fast</span> : null}
                </button>
              );
            })}
          </div>
          <p
            id={countId}
            className="tnum border-t border-line px-2.5 pt-2 pb-2 font-mono text-xs text-subtle"
          >
            {visibleCount} av {columns.length} visas · minst en
          </p>
        </div>
      ) : null}
    </div>
  );
}

const MENU_WIDTH = 240;
const VIEWPORT_GUTTER = 16;
/** Avståndet mellan knappen och menyn (mt-1/mb-1). */
const MENU_OFFSET = 4;

/** Menyns höjd: rader om 32 px (h-8), py-1, foten (en rad text-xs med pt-2/pb-2) och ramen. */
export function columnMenuHeight(columnCount: number): number {
  return columnCount * 32 + 8 + 33 + 2;
}

/**
 * Öppnas menyn under eller ovanför knappen? Under om den ryms ovanför fönstrets
 * nederkant, annars ovanför om det finns mer plats där (annars under ändå, och
 * sidan kan rullas).
 */
export function menuSide(
  button: { top: number; bottom: number },
  menuHeight: number,
  viewportHeight: number,
): "below" | "above" {
  const below = viewportHeight - VIEWPORT_GUTTER - (button.bottom + MENU_OFFSET);
  if (menuHeight <= below) return "below";
  const above = button.top - MENU_OFFSET - VIEWPORT_GUTTER;
  return above > below ? "above" : "below";
}

function menuAlign(button: HTMLElement | null): "left" | "right" {
  if (!button) return "right";
  const r = button.getBoundingClientRect();
  if (r.right - MENU_WIDTH >= VIEWPORT_GUTTER) return "right";
  return "left";
}

// ---------------------------------------------------------------------------
// Tabell
// ---------------------------------------------------------------------------

const DEFAULT_WIDTH = 160;
const AUTO_VIRTUALIZE = 200;

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  caption,
  showCaption,
  defaultSort = null,
  isFlagged,
  dense,
  className,
  virtualize,
  maxHeight,
  overscan = 8,
  columnPicker,
  exportFileName,
  toolbar,
  showTiming,
  onRowClick,
  stickyFirstColumn = true,
  surface = "surface",
  onSortChange,
}: DataTableProps<T>) {
  const virtual = virtualize ?? rows.length > AUTO_VIRTUALIZE;
  const rowH = dense ? 36 : 44;
  const height = maxHeight ?? (virtual ? 560 : undefined);
  const hintId = useId();

  // --- Sortering ----------------------------------------------------------
  const [sort, setSortState] = useState<SortKey[]>(() => normalizeSort(defaultSort));
  const setSort = useCallback(
    (next: SortKey[]) => {
      setSortState(next);
      onSortChange?.(next);
    },
    [onSortChange],
  );

  const sorted = useMemo(() => {
    const specs: SortSpec<T>[] = [];
    for (const s of sort) {
      const get = columns.find((c) => c.key === s.key)?.sortValue;
      if (get) specs.push({ get, dir: s.dir });
    }
    if (!specs.length) return { order: null, ms: 0 };
    const [order, ms] = measure(() => sortOrder(rows, specs));
    return { order, ms };
  }, [rows, columns, sort]);

  const rowAt = useCallback(
    (i: number): T => rows[sorted.order ? (sorted.order[i] as number) : i] as T,
    [rows, sorted],
  );

  const onHeaderClick = (col: Column<T>, e: ReactMouseEvent) => {
    if (!col.sortValue) return;
    const pos = sort.findIndex((s) => s.key === col.key);
    if (e.shiftKey) {
      // Lägg till, vänd eller ta bort nyckeln och behåll övriga.
      const next = cycle(col, sort[pos]?.dir);
      if (pos === -1) setSort([...sort, { key: col.key, dir: next ?? firstDir(col) }]);
      else if (next) setSort(sort.map((s, i) => (i === pos ? { key: s.key, dir: next } : s)));
      else setSort(sort.filter((_, i) => i !== pos));
      return;
    }
    const current = pos === 0 ? sort[0]?.dir : undefined;
    const next = cycle(col, current);
    setSort(next ? [{ key: col.key, dir: next }] : []);
  };

  // --- Kolumner ------------------------------------------------------------
  const [hidden, setHidden] = useState<ReadonlySet<string>>(
    () => new Set(columns.filter((c) => c.defaultHidden).map((c) => c.key)),
  );
  const visibleColumns = useMemo(
    () => columns.filter((c) => !hidden.has(c.key)),
    [columns, hidden],
  );
  const toggleColumn = (key: string) => {
    const next = new Set(hidden);
    if (next.has(key)) next.delete(key);
    else if (columns.length - next.size > 1) {
      next.add(key);
      if (sort.some((s) => s.key === key)) setSort(sort.filter((s) => s.key !== key));
    }
    setHidden(next);
  };

  // --- Virtualisering ------------------------------------------------------
  const scrollRef = useRef<HTMLDivElement>(null);
  const theadRef = useRef<HTMLTableSectionElement>(null);
  const [first, setFirst] = useState(0);
  const [viewport, setViewport] = useState(typeof height === "number" ? height : 600);
  const [headOffset, setHeadOffset] = useState(36);
  const [scrolledX, setScrolledX] = useState(false);
  // Scrollytan blir ett tabbstopp bara när den faktiskt går att scrolla.
  const [overflows, setOverflows] = useState(virtual);
  const [overflowX, setOverflowX] = useState(false);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => {
      setViewport(el.clientHeight || viewportFallback(height));
      setHeadOffset(theadRef.current?.offsetHeight ?? 36);
      setOverflows(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
      setOverflowX(el.scrollWidth > el.clientWidth + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, [height]);
  const scrollable = virtual || overflows;

  // Ny sortering börjar överst.
  const sortSig = sort.map((s) => `${s.key}:${s.dir}`).join(",");
  const prevSig = useRef(sortSig);
  useEffect(() => {
    if (prevSig.current === sortSig) return;
    prevSig.current = sortSig;
    if (scrollRef.current) scrollRef.current.scrollTop = 0;
  }, [sortSig]);

  const onScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setScrolledX(el.scrollLeft > 0);
    if (virtual) setFirst(Math.max(0, Math.floor((el.scrollTop - headOffset) / rowH)));
  };

  const n = rows.length;
  const start = virtual ? Math.min(n, Math.max(0, first - overscan)) : 0;
  const end = virtual ? Math.min(n, first + Math.ceil(viewport / rowH) + overscan) : n;

  // --- Rendering -----------------------------------------------------------
  const hasFooter = visibleColumns.some((c) => c.footer !== undefined);
  const ctx: CellCtx = useMemo(
    () => ({
      last: visibleColumns.length - 1,
      flaggable: Boolean(isFlagged),
      stickyFirst: stickyFirstColumn,
      scrolledX,
      overflowX,
      fixed: virtual,
    }),
    [visibleColumns.length, isFlagged, stickyFirstColumn, scrolledX, overflowX, virtual],
  );
  const minWidth = virtual
    ? visibleColumns.reduce((sum, c) => sum + (c.width ?? DEFAULT_WIDTH), 0)
    : undefined;
  // Under md är hideOnMobile-kolumnerna dolda; de ska inte heller tvinga fram bredd.
  const minWidthMobile = virtual
    ? visibleColumns
        .filter((c) => !c.hideOnMobile)
        .reduce((sum, c) => sum + (c.width ?? DEFAULT_WIDTH), 0)
    : undefined;
  const sortable = visibleColumns.some((c) => c.sortValue);

  const bodyRows: ReactNode[] = [];
  for (let i = start; i < end; i++) {
    const row = rowAt(i);
    bodyRows.push(
      <Row
        key={rowKey(row)}
        row={row}
        columns={visibleColumns}
        ariaRowIndex={i + 2}
        flagged={isFlagged?.(row) ?? false}
        height={rowH}
        ctx={ctx}
        onRowClick={onRowClick}
      />,
    );
  }

  const exportCsv = () => {
    if (!exportFileName) return;
    const ordered: T[] = new Array(n);
    for (let i = 0; i < n; i++) ordered[i] = rowAt(i);
    downloadCsv(exportFileName, toCsv(ordered, visibleColumns));
  };

  const showToolbar = toolbar !== undefined || columnPicker || exportFileName !== undefined;
  const sortParts = sort
    .map((s) => ({ s, col: columns.find((c) => c.key === s.key) }))
    .filter((p) => p.col);

  return (
    <div className={cn("relative w-full min-w-0", surfaceVar[surface], className)}>
      {showToolbar ? (
        <div
          className={cn(
            "flex flex-col gap-3 pb-3 sm:flex-row sm:items-center sm:justify-between",
            // Under md: en rad med räknaren och knapparna som ikoner till höger.
            !toolbar || toolbar === true
              ? "max-md:flex-row max-md:items-center max-md:justify-between max-md:gap-2 max-md:pb-2"
              : null,
          )}
        >
          <div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
            {toolbar !== true ? toolbar : null}
            <p
              className="tnum min-w-0 font-mono text-xs text-muted"
              aria-live="polite"
              aria-atomic="true"
            >
              {/* Under md säger antalet inget när alla rader syns på en gång. */}
              <span className={cn(n <= FEW_ROWS && "max-md:sr-only")}>
                <span className="text-fg">{formatInt(n)}</span> {n === 1 ? "rad" : "rader"}
              </span>
              {sortParts.length ? (
                <>
                  <span aria-hidden className={cn("text-subtle", n <= FEW_ROWS && "max-md:hidden")}>
                    {" · "}
                  </span>
                  sorterat på{" "}
                  {sortParts.map(({ s, col }, i) => (
                    <span key={s.key}>
                      {i > 0 ? ", " : ""}
                      <span className="text-fg">{col?.header}</span>
                      <span aria-hidden> {s.dir === "asc" ? "↑" : "↓"}</span>
                      <span className="sr-only"> {s.dir === "asc" ? "stigande" : "fallande"}</span>
                    </span>
                  ))}
                </>
              ) : null}
              {showTiming && sorted.order ? (
                <span suppressHydrationWarning>
                  <span aria-hidden className="text-subtle">
                    {" · "}
                  </span>
                  {formatMs(sorted.ms)}
                </span>
              ) : null}
            </p>
          </div>
          {columnPicker || exportFileName ? (
            <div className="flex shrink-0 items-center gap-2">
              {columnPicker ? (
                <ColumnMenu columns={columns} hidden={hidden} onToggle={toggleColumn} />
              ) : null}
              {exportFileName ? (
                <Button size="sm" iconLeft="download" onClick={exportCsv} className={TOOL_BUTTON}>
                  <span className="max-md:sr-only">Exportera CSV</span>
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      {showCaption && virtual ? (
        <p aria-hidden className="label pb-3 text-muted">
          {caption}
        </p>
      ) : null}

      <div
        ref={scrollRef}
        onScroll={onScroll}
        tabIndex={scrollable ? 0 : undefined}
        role={scrollable ? "region" : undefined}
        aria-label={scrollable ? caption : undefined}
        className={cn(
          // scroll-mt-28: får ytan fokus (Tab) och är högre än fönstret linjeras den under
          // toppbaren, inte bakom den (samma mått som ankarmålen, design.md §5.2).
          "relative w-full scroll-mt-28 rounded-xs",
          height !== undefined ? "overflow-auto overscroll-contain" : "overflow-x-auto",
          // Fokus (Tab) och scrollIntoView stannar inte under det klistriga huvudet eller
          // summaraden (WCAG 2.4.11).
          height !== undefined && "scroll-pt-11",
          height !== undefined && hasFooter && "scroll-pb-11",
        )}
        style={height !== undefined ? { maxHeight: height } : undefined}
      >
        <table
          aria-rowcount={n + 1 + (hasFooter ? 1 : 0)}
          aria-describedby={sortable ? hintId : undefined}
          className={cn(
            "w-full border-separate border-spacing-0 text-base",
            virtual && "min-w-(--dt-min-m) table-fixed md:min-w-(--dt-min)",
          )}
          style={
            minWidth
              ? ({
                  "--dt-min": `${minWidth}px`,
                  "--dt-min-m": `${minWidthMobile ?? minWidth}px`,
                } as CSSProperties)
              : undefined
          }
        >
          <caption
            className={cn(showCaption && !virtual ? "label pb-3 text-left text-muted" : "sr-only")}
          >
            {caption}
          </caption>
          {virtual ? (
            <colgroup>
              {visibleColumns.map((c) => (
                <col
                  key={c.key}
                  className={c.hideOnMobile ? "hidden md:table-column" : undefined}
                  style={c.width ? { width: c.width } : undefined}
                />
              ))}
            </colgroup>
          ) : null}
          <thead ref={theadRef}>
            <tr aria-rowindex={1}>
              {visibleColumns.map((col, ci) => {
                const pos = sort.findIndex((s) => s.key === col.key);
                const active = sort[pos];
                const ariaSort =
                  pos === 0 && active
                    ? active.dir === "asc"
                      ? "ascending"
                      : "descending"
                    : col.sortValue
                      ? "none"
                      : undefined;
                return (
                  <th
                    key={col.key}
                    scope="col"
                    aria-sort={ariaSort}
                    title={col.headerTitle}
                    className={cn(
                      "h-9 border-b border-line-strong px-3 font-normal whitespace-nowrap",
                      height !== undefined && "sticky top-0 z-[2] bg-[var(--dt-bg)]",
                      col.numeric ? "text-right" : "text-left",
                      edgeClasses(col, ci, ctx, "z-[3]"),
                      col.className,
                    )}
                  >
                    {col.sortValue ? (
                      <button
                        type="button"
                        onClick={(e) => onHeaderClick(col, e)}
                        className={cn(
                          // Träffytan 28 px hög utan att rubrikraden växer.
                          "label group/sort relative -my-1.5 inline-flex max-w-full items-center gap-1 rounded-xs py-1.5 align-middle transition-colors duration-fast ease-instrument max-md:before:absolute max-md:before:inset-x-0 max-md:before:-inset-y-2 max-md:before:content-['']",
                          col.numeric && "flex-row-reverse",
                          active ? "text-fg" : "text-subtle hover:text-fg",
                        )}
                      >
                        <span className="truncate">{col.header}</span>
                        <Icon
                          name={
                            active ? (active.dir === "asc" ? "sortAsc" : "sortDesc") : "sortNone"
                          }
                          size={12}
                          className={cn(
                            "shrink-0",
                            !active && "opacity-50 group-hover/sort:opacity-100",
                          )}
                        />
                        {active && sort.length > 1 ? (
                          <span className="tnum label text-subtle" aria-hidden>
                            {pos + 1}
                          </span>
                        ) : null}
                        {active && pos > 0 ? (
                          <span className="sr-only">
                            , sorteringsnyckel {pos + 1},{" "}
                            {active.dir === "asc" ? "stigande" : "fallande"}
                          </span>
                        ) : null}
                      </button>
                    ) : (
                      <span className="label inline-block align-middle text-subtle">
                        {col.header}
                      </span>
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {virtual && start > 0 ? (
              <tr aria-hidden style={{ height: start * rowH }}>
                <td colSpan={visibleColumns.length} className="p-0" />
              </tr>
            ) : null}
            {bodyRows}
            {virtual && end < n ? (
              <tr aria-hidden style={{ height: (n - end) * rowH }}>
                <td colSpan={visibleColumns.length} className="p-0" />
              </tr>
            ) : null}
          </tbody>
          {hasFooter ? (
            <tfoot>
              <tr aria-rowindex={n + 2}>
                {visibleColumns.map((col, ci) => (
                  <td
                    key={col.key}
                    className={cn(
                      "h-11 px-3 font-medium",
                      height !== undefined &&
                        "sticky bottom-0 z-[2] border-t border-line-strong bg-[var(--dt-bg)]",
                      col.numeric ? "tnum text-right text-base" : "label text-subtle",
                      edgeClasses(col, ci, ctx, "z-[3]"),
                      virtual && "overflow-hidden text-ellipsis whitespace-nowrap",
                    )}
                  >
                    {col.footer}
                  </td>
                ))}
              </tr>
            </tfoot>
          ) : null}
        </table>
      </div>
      {sortable ? (
        <p id={hintId} className="sr-only">
          Skift och klick på en kolumnrubrik lägger till en sekundär sortering.
        </p>
      ) : null}
    </div>
  );
}

function viewportFallback(height: number | string | undefined): number {
  return typeof height === "number" ? height : 600;
}
