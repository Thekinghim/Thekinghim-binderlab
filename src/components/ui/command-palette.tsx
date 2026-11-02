"use client";

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
  type ReactNode,
  type RefObject,
} from "react";
import { cn } from "@/lib/cn";
import { highlightSegments, matchFields, type FieldMatch } from "@/lib/fuzzy";
import { Icon, type IconName } from "./icon";

/* ------------------------------------------------------------------ */
/* Typer                                                               */
/* ------------------------------------------------------------------ */

export type CommandItem = {
  id: string;
  label: string;
  /** Monospace-metadata till höger, t.ex. "BL-010" eller "G Ö". Söks och markeras. */
  hint?: string;
  icon?: IconName;
  /** Söks men visas inte, t.ex. ort eller synonymer. */
  keywords?: string[];
  /** Tangenter som visas som kbd-rutor, t.ex. ["⇧", "R"]. */
  shortcut?: string[];
  onSelect: () => void;
};

export type CommandGroup = { label: string; items: CommandItem[] };

type CommonProps = {
  groups: CommandGroup[];
  placeholder?: string;
  /** Förslag i tomt resultat. Standard: första posten i varje grupp. */
  suggestions?: string[];
  /** Startvärde för sökfältet (främst för visning). */
  defaultQuery?: string;
  /** Tillgängligt namn. Standard: "Kommandopalett". */
  label?: string;
  className?: string;
  /** Extra klasser på resultatlistan, t.ex. fast höjd i en visning. */
  listClassName?: string;
};

export type CommandPaletteProps = CommonProps &
  (
    | {
        /** Rendera panelen direkt i flödet, utan dialog (för visning och inbäddning). */
        inline: true;
        open?: undefined;
        onOpenChange?: undefined;
      }
    | {
        inline?: false;
        open: boolean;
        onOpenChange: (open: boolean) => void;
      }
  );

/* ------------------------------------------------------------------ */
/* Plattform och kortkommando                                          */
/* ------------------------------------------------------------------ */

type NavigatorWithUAData = Navigator & { userAgentData?: { platform?: string } };

function detectMac(): boolean {
  const nav = navigator as NavigatorWithUAData;
  const platform = nav.userAgentData?.platform || nav.platform || nav.userAgent;
  return /mac|iphone|ipad|ipod/i.test(platform);
}

const noopSubscribe = () => () => {};

/**
 * Modifieringstangent för plattformen: "⌘" på Apple, "Ctrl" annars.
 * null under serverrendering och första hydreringen, så att markup stämmer.
 */
export function useModifierKey(): "⌘" | "Ctrl" | null {
  return useSyncExternalStore(
    noopSubscribe,
    () => (detectMac() ? "⌘" : "Ctrl"),
    () => null,
  );
}

/** "⌘K" på Apple, "Ctrl K" annars. Tom sträng innan plattformen är känd. */
export function formatHotkey(mod: "⌘" | "Ctrl" | null, key = "K"): string {
  if (!mod) return "";
  return mod === "⌘" ? `⌘${key}` : `Ctrl ${key}`;
}

function isEditable(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  if (tag === "TEXTAREA" || tag === "SELECT") return true;
  if (tag !== "INPUT") return false;
  const type = (target as HTMLInputElement).type;
  return !["button", "checkbox", "radio", "range", "reset", "submit", "color", "file"].includes(
    type,
  );
}

type SetOpen = (update: boolean | ((prev: boolean) => boolean)) => void;

/**
 * Global genväg: ⌘K (Apple) eller Ctrl+K (övriga) växlar paletten.
 * "/" öppnar den när fokus inte ligger i ett fält och ingen annan dialog är öppen.
 * Returnerar modifieringstangenten för att visa rätt symbol.
 */
export function useCommandPaletteHotkey(
  setOpen: SetOpen,
  options: { enabled?: boolean; slash?: boolean } = {},
): "⌘" | "Ctrl" | null {
  const { enabled = true, slash = true } = options;
  const mod = useModifierKey();
  const setOpenRef = useRef(setOpen);
  useLayoutEffect(() => {
    setOpenRef.current = setOpen;
  });

  useEffect(() => {
    if (!enabled) return;
    const mac = detectMac();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || e.isComposing) return;
      const primary = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (primary && !e.altKey && !e.shiftKey && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpenRef.current((prev) => !prev);
        return;
      }
      if (
        slash &&
        e.key === "/" &&
        !e.metaKey &&
        !e.ctrlKey &&
        !e.altKey &&
        !isEditable(e.target) &&
        !document.querySelector("dialog[open]")
      ) {
        e.preventDefault();
        setOpenRef.current(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, slash]);

  return mod;
}

/* ------------------------------------------------------------------ */
/* Sökning                                                             */
/* ------------------------------------------------------------------ */

type Row = { item: CommandItem; match: FieldMatch | null; groupLabel: string };
type ResultGroup = { label: string; rows: Row[] };

function search(groups: CommandGroup[], query: string): ResultGroup[] {
  const q = query.trim();
  if (!q) {
    return groups
      .filter((g) => g.items.length > 0)
      .map((g) => ({
        label: g.label,
        rows: g.items.map((item) => ({ item, match: null, groupLabel: g.label })),
      }));
  }
  const scored = groups
    .map((g, order) => {
      const rows: Array<Row & { score: number; order: number }> = [];
      g.items.forEach((item, i) => {
        const match = matchFields(q, item);
        if (match) rows.push({ item, match, groupLabel: g.label, score: match.score, order: i });
      });
      rows.sort((a, b) => b.score - a.score || a.order - b.order);
      return { label: g.label, rows, best: rows[0]?.score ?? -Infinity, order };
    })
    .filter((g) => g.rows.length > 0);
  // Gruppen med bästa träffen först; posterna inom gruppen efter poäng.
  scored.sort((a, b) => b.best - a.best || a.order - b.order);
  return scored.map(({ label, rows }) => ({ label, rows }));
}

/* ------------------------------------------------------------------ */
/* Delar                                                               */
/* ------------------------------------------------------------------ */

function Highlight({
  text,
  indices,
  muted,
}: {
  text: string;
  indices: readonly number[] | null;
  muted: string;
}) {
  if (!indices) return <>{text}</>;
  return (
    <>
      {highlightSegments(text, indices).map((s, i) =>
        s.match ? (
          <span key={i} className="text-fg">
            {s.text}
          </span>
        ) : (
          <span key={i} className={muted}>
            {s.text}
          </span>
        ),
      )}
    </>
  );
}

function Kbd({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <kbd
      className={cn(
        "inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-xs border border-line-strong px-1 font-mono text-[11px] leading-none text-muted",
        className,
      )}
    >
      {children}
    </kbd>
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

type PanelProps = CommonProps & {
  inline: boolean;
  onRequestClose?: () => void;
  onSelectItem: (item: CommandItem) => void;
  inputRef: RefObject<HTMLInputElement | null>;
};

function PalettePanel({
  groups,
  placeholder = "Sök sidor, automater och åtgärder",
  suggestions,
  defaultQuery = "",
  label = "Kommandopalett",
  className,
  listClassName,
  inline,
  onRequestClose,
  onSelectItem,
  inputRef,
}: PanelProps) {
  const baseId = useId();
  const listId = `${baseId}-list`;
  const [query, setQuery] = useState(defaultQuery);
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const scrollOnChange = useRef(false);

  const results = useMemo(() => search(groups, query), [groups, query]);
  const flat = useMemo(() => results.flatMap((g) => g.rows), [results]);
  const starts = useMemo(() => {
    const out: number[] = [];
    let n = 0;
    for (const g of results) {
      out.push(n);
      n += g.rows.length;
    }
    return out;
  }, [results]);
  const total = useMemo(() => groups.reduce((n, g) => n + g.items.length, 0), [groups]);
  const count = flat.length;
  const activeIndex = count === 0 ? -1 : Math.min(active, count - 1);
  const optionId = (i: number) => `${baseId}-o${i}`;

  const fallbackSuggestions = useMemo(
    () =>
      suggestions ??
      groups
        .map((g) => g.items[0]?.label)
        .filter((s): s is string => Boolean(s))
        .slice(0, 3),
    [groups, suggestions],
  );

  // Håll aktiv rad i vy, men bara inom listan (aldrig sidan).
  useLayoutEffect(() => {
    if (!scrollOnChange.current) return;
    scrollOnChange.current = false;
    const list = listRef.current;
    const el = activeIndex >= 0 ? document.getElementById(optionId(activeIndex)) : null;
    if (!list || !el) return;
    const l = list.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    // Ta med grupprubriken när första raden i en grupp blir aktiv.
    const pad = 28;
    if (r.top < l.top + 4) list.scrollTop -= l.top - r.top + (el.dataset.first ? pad : 4);
    else if (r.bottom > l.bottom - 4) list.scrollTop += r.bottom - l.bottom + 4;
  });

  const move = (next: number) => {
    if (count === 0) return;
    scrollOnChange.current = true;
    setActive(((next % count) + count) % count);
  };

  const updateQuery = (value: string) => {
    setQuery(value);
    setActive(0);
    if (listRef.current) listRef.current.scrollTop = 0;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;
    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        move(activeIndex + 1);
        break;
      case "ArrowUp":
        e.preventDefault();
        move(activeIndex - 1);
        break;
      case "Home":
        if (count === 0) return;
        e.preventDefault();
        move(0);
        break;
      case "End":
        if (count === 0) return;
        e.preventDefault();
        move(count - 1);
        break;
      case "Enter": {
        const row = flat[activeIndex];
        if (!row) return;
        e.preventDefault();
        onSelectItem(row.item);
        break;
      }
      case "Escape":
        if (inline) {
          e.preventDefault();
          updateQuery("");
        }
        break;
    }
  };

  const trimmed = query.trim();

  return (
    <div
      className={cn("flex min-w-0 flex-col bg-raised text-fg", className)}
      role={inline ? "group" : undefined}
      aria-label={inline ? label : undefined}
    >
      {/* Sökfält */}
      <div className="flex h-12 items-center gap-3 border-b border-line pr-2 pl-4">
        <Icon name="search" className="shrink-0 text-subtle" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={placeholder}
          aria-expanded={count > 0}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={activeIndex >= 0 ? optionId(activeIndex) : undefined}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          enterKeyHint="go"
          value={query}
          placeholder={placeholder}
          onChange={(e) => updateQuery(e.target.value)}
          onKeyDown={onKeyDown}
          className="h-full min-w-0 flex-1 bg-transparent text-md text-fg outline-none placeholder:text-subtle"
        />
        {query ? (
          <button
            type="button"
            onClick={() => {
              updateQuery("");
              inputRef.current?.focus();
            }}
            className="label rounded-xs px-1.5 py-0.5 text-subtle transition-colors duration-[120ms] ease-instrument hover:bg-hover hover:text-fg"
          >
            Rensa
          </button>
        ) : null}
        {!inline && onRequestClose ? (
          <button
            type="button"
            onClick={onRequestClose}
            aria-label="Stäng"
            className="inline-flex h-7 items-center rounded-sm px-1.5 text-muted transition-colors duration-[120ms] ease-instrument hover:bg-hover hover:text-fg"
          >
            <span className="hidden sm:inline-flex">
              <Kbd>esc</Kbd>
            </span>
            <Icon name="close" className="sm:hidden" />
          </button>
        ) : null}
      </div>

      {/* Resultat */}
      <div
        ref={listRef}
        id={listId}
        role="listbox"
        aria-label="Resultat"
        className={cn(
          "overflow-y-auto overscroll-contain",
          count > 0 && "py-1.5",
          inline ? "max-h-[360px]" : "max-h-[min(60dvh,420px)]",
          listClassName,
        )}
      >
        {results.map((group, gi) => {
          const headId = `${baseId}-g${gi}`;
          return (
            <div key={group.label} role="group" aria-labelledby={headId}>
              <div
                id={headId}
                role="presentation"
                className="label flex items-center justify-between px-4 pt-2.5 pb-1.5 text-subtle"
              >
                <span>{group.label}</span>
                {trimmed ? <span className="tnum text-subtle">{group.rows.length}</span> : null}
              </div>
              {group.rows.map((row, ri) => {
                const i = (starts[gi] ?? 0) + ri;
                const isActive = i === activeIndex;
                const m = row.match;
                const labelIdx = !m ? null : m.field === "label" ? m.indices : [];
                const hintIdx = !m ? null : m.field === "hint" ? m.indices : [];
                return (
                  <div
                    key={row.item.id}
                    id={optionId(i)}
                    role="option"
                    aria-selected={isActive}
                    data-first={ri === 0 ? "" : undefined}
                    onPointerMove={() => {
                      if (activeIndex !== i) setActive(i);
                    }}
                    onPointerDown={(e) => e.preventDefault()}
                    onClick={() => onSelectItem(row.item)}
                    className={cn(
                      "relative mx-1.5 flex h-9 cursor-default items-center gap-3 rounded-sm pr-2.5 pl-[22px] select-none",
                      isActive && "bg-hover",
                    )}
                  >
                    <span
                      aria-hidden
                      className={cn(
                        "absolute top-1/2 left-2 size-1 -translate-y-1/2 bg-fg transition-opacity duration-[120ms] ease-instrument",
                        isActive ? "opacity-100" : "opacity-0",
                      )}
                    />
                    {row.item.icon ? (
                      <Icon
                        name={row.item.icon}
                        className={cn("shrink-0", isActive ? "text-fg" : "text-subtle")}
                      />
                    ) : null}
                    <span className="flex min-w-0 flex-1 items-baseline gap-2">
                      <span
                        className={cn(
                          "min-w-0 truncate text-base",
                          labelIdx ? "text-muted" : "text-fg",
                        )}
                      >
                        <Highlight text={row.item.label} indices={labelIdx} muted="text-muted" />
                      </span>
                      {m?.field === "keyword" ? (
                        <span className="min-w-0 shrink-[2] truncate font-mono text-xs text-subtle">
                          <span className="sr-only">träff: </span>
                          <Highlight text={m.value} indices={m.indices} muted="text-subtle" />
                        </span>
                      ) : null}
                    </span>
                    {row.item.hint ? (
                      <span className="tnum shrink-0 font-mono text-xs text-subtle">
                        <Highlight text={row.item.hint} indices={hintIdx} muted="text-subtle" />
                      </span>
                    ) : null}
                    {row.item.shortcut?.length ? (
                      <span className="hidden shrink-0 items-center gap-1 sm:flex" aria-hidden>
                        {row.item.shortcut.map((k, ki) => (
                          <Kbd key={ki}>{k}</Kbd>
                        ))}
                      </span>
                    ) : null}
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>

      {count === 0 ? (
        <div className="flex flex-col gap-3 px-4 pt-5 pb-6">
          <p className="font-mono text-sm break-words text-muted">
            <span className="tnum text-fg">0</span> träffar för ”{trimmed}”
          </p>
          {fallbackSuggestions.length > 0 ? (
            <div className="flex flex-wrap items-center gap-1.5">
              <span className="font-mono text-xs text-subtle">Prova</span>
              {fallbackSuggestions.map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => {
                    updateQuery(s);
                    inputRef.current?.focus();
                  }}
                  className="h-6 rounded-xs border border-line-strong px-2 font-mono text-xs text-muted transition-colors duration-[120ms] ease-instrument hover:border-line-control hover:bg-hover hover:text-fg"
                >
                  {s}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {/* Sidfot */}
      <div className="flex h-9 items-center justify-between gap-4 border-t border-line px-4 font-mono text-xs text-subtle">
        <span className="hidden items-center gap-1.5 sm:flex" aria-hidden>
          <Kbd>↑</Kbd>
          <Kbd>↓</Kbd>
          <span className="mr-2">välj</span>
          <Kbd>↵</Kbd>
          <span className="mr-2">öppna</span>
          <Kbd>esc</Kbd>
          <span>{inline ? "rensa" : "stäng"}</span>
        </span>
        <span className="tnum ml-auto" role="status" aria-live="polite">
          {trimmed ? `${count} av ${total}` : `${total} kommandon`}
        </span>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Publik komponent                                                    */
/* ------------------------------------------------------------------ */

/**
 * Kommandopalett. Som dialog (standard) byggd på <dialog>: fokusfälla, Esc,
 * inert bakgrund. Övre tredjedelen på desktop, fullbredd ark från toppen på
 * mobil (så att tangentbordet inte täcker resultaten). Med `inline` renderas
 * panelen direkt i flödet.
 */
export function CommandPalette(props: CommandPaletteProps) {
  const { inline, open, onOpenChange, className, ...common } = props;
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Ny nyckel vid varje öppning nollställer sökning och aktiv rad.
  const [session, setSession] = useState(0);

  useEffect(() => {
    if (inline) return;
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      inputRef.current?.focus();
    }
    if (!open && d.open) d.close();
  }, [open, inline]);

  const close = useCallback(() => {
    const d = dialogRef.current;
    if (d?.open) d.close();
    onOpenChange?.(false);
  }, [onOpenChange]);

  const select = useCallback(
    (item: CommandItem) => {
      // Stäng först så att fokus återställs innan åtgärden körs
      // (t.ex. om den öppnar en annan dialog).
      if (!inline) close();
      item.onSelect();
    },
    [inline, close],
  );

  if (inline) {
    return (
      <PalettePanel
        {...common}
        inline
        inputRef={inputRef}
        onSelectItem={select}
        className={cn("rounded-md border border-line-strong", className)}
      />
    );
  }

  return (
    <dialog
      ref={dialogRef}
      aria-label={common.label ?? "Kommandopalett"}
      onClose={() => {
        onOpenChange?.(false);
        setSession((s) => s + 1);
      }}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      className="m-0 mb-auto w-full max-w-none border-0 bg-transparent p-0 text-fg sm:mx-auto sm:mt-[12vh] sm:max-w-[640px]"
    >
      <div style={{ animation: "bl-enter var(--bl-dur-slow) var(--bl-ease)" }}>
        <PalettePanel
          key={session}
          {...common}
          inline={false}
          inputRef={inputRef}
          onSelectItem={select}
          onRequestClose={close}
          className={cn(
            "overflow-hidden rounded-b-md border-b border-line-strong sm:rounded-md sm:border",
            className,
          )}
        />
      </div>
    </dialog>
  );
}
