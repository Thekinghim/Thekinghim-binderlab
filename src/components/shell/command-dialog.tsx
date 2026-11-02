"use client";

import {
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from "react";

import { Icon, type IconName } from "@/components/ui/icon";
import { cn } from "@/lib/cn";
import { highlightSegments } from "@/lib/fuzzy";

/**
 * Kommandopalettens dialog med sökning på servern. Samma utseende och tangentbord som
 * CommandPalette (src/components/ui/command-palette.tsx), men listan byggs av anroparen
 * (lokala kommandon och serverträffar i grupper) och sökfältet är styrt, så att
 * anroparen kan fråga servern. Stöder steg ("Registrera påfyllning › välj automat"):
 * Esc och Backsteg i tomt fält går tillbaka ett steg.
 */

export type PaletteRow = {
  id: string;
  label: string;
  /** Tecken i etiketten som träffades (markeras i fg). */
  labelIndices?: readonly number[] | null;
  /** Kort id i mono före etiketten, t.ex. ordernumret. */
  code?: string;
  codeIndices?: readonly number[] | null;
  /** Metadata i mono till höger (under etiketten på mobil). */
  meta?: readonly string[];
  icon?: IconName;
  /** Raden öppnar ett steg i paletten (visas med en pil). */
  opensStep?: boolean;
  onSelect: () => void;
};

export type PaletteSection = {
  id: string;
  label: string;
  /** Antal träffar i rubriken (bara när man söker). */
  count?: number;
  rows: PaletteRow[];
};

export type CommandDialogProps = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  query: string;
  onQueryChange: (query: string) => void;
  sections: PaletteSection[];
  placeholder: string;
  /** Aktivt steg: visas före sökfältet; onBack går tillbaka. */
  step?: { label: string; onBack: () => void } | null;
  /** Statustext i sidfoten (läses upp), t.ex. "Söker …" eller "12 träffar". */
  status: string;
  /** Servern arbetar (listan markeras aria-busy). */
  busy?: boolean;
  /** Visas när listan är tom. */
  empty?: ReactNode;
};

function Highlight({ text, indices }: { text: string; indices?: readonly number[] | null }) {
  if (!indices || indices.length === 0) return <>{text}</>;
  return (
    <>
      {highlightSegments(text, indices).map((s, i) =>
        s.match ? (
          <span key={i} className="text-fg">
            {s.text}
          </span>
        ) : (
          <span key={i}>{s.text}</span>
        ),
      )}
    </>
  );
}

function Kbd({ children }: { children: ReactNode }) {
  return (
    <kbd className="label inline-flex h-[18px] min-w-[18px] items-center justify-center rounded-xs border border-line-strong px-1 leading-none tracking-normal text-muted">
      {children}
    </kbd>
  );
}

export function CommandDialog({
  open,
  onOpenChange,
  query,
  onQueryChange,
  sections,
  placeholder,
  step,
  status,
  busy,
  empty,
}: CommandDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const baseId = useId();
  const listId = `${baseId}-list`;
  const [activeId, setActiveId] = useState<string | null>(null);
  const scrollOnChange = useRef(false);

  const flat = useMemo(() => sections.flatMap((s) => s.rows), [sections]);
  const count = flat.length;
  const found = activeId === null ? -1 : flat.findIndex((r) => r.id === activeId);
  // Följer markeringen med när listan byts (nya serverträffar); annars första raden.
  const activeIndex = count === 0 ? -1 : found >= 0 ? found : 0;
  const optionId = (i: number) => `${baseId}-o${i}`;

  useEffect(() => {
    const d = dialogRef.current;
    if (!d) return;
    if (open && !d.open) {
      d.showModal();
      inputRef.current?.focus();
    }
    if (!open && d.open) d.close();
  }, [open]);

  // Fokus tillbaka i fältet när ett steg byts (raden som öppnade steget hade inte fokus).
  const stepLabel = step?.label ?? null;
  useEffect(() => {
    if (open) inputRef.current?.focus();
  }, [open, stepLabel]);

  useLayoutEffect(() => {
    if (!scrollOnChange.current) return;
    scrollOnChange.current = false;
    const list = listRef.current;
    const el = activeIndex >= 0 ? document.getElementById(optionId(activeIndex)) : null;
    if (!list || !el) return;
    const l = list.getBoundingClientRect();
    const r = el.getBoundingClientRect();
    const pad = 28;
    if (r.top < l.top + 4) list.scrollTop -= l.top - r.top + (el.dataset.first ? pad : 4);
    else if (r.bottom > l.bottom - 4) list.scrollTop += r.bottom - l.bottom + 4;
  });

  const move = (next: number) => {
    if (count === 0) return;
    scrollOnChange.current = true;
    const row = flat[((next % count) + count) % count];
    if (row) setActiveId(row.id);
  };

  const setQuery = (value: string) => {
    onQueryChange(value);
    setActiveId(null);
    if (listRef.current) listRef.current.scrollTop = 0;
  };

  const close = () => {
    const d = dialogRef.current;
    if (d?.open) d.close();
    onOpenChange(false);
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
        row.onSelect();
        break;
      }
      case "Escape":
        // Första Esc rensar fältet, nästa går tillbaka ett steg, sista stänger.
        if (query) {
          e.preventDefault();
          e.stopPropagation();
          setQuery("");
        } else if (step) {
          e.preventDefault();
          e.stopPropagation();
          step.onBack();
          setActiveId(null);
        }
        break;
      case "Backspace":
        if (!query && step) {
          e.preventDefault();
          step.onBack();
          setActiveId(null);
        }
        break;
    }
  };

  const indexOf = new Map(flat.map((r, i) => [r.id, i]));

  return (
    <dialog
      ref={dialogRef}
      aria-label="Kommandopalett"
      onClose={() => onOpenChange(false)}
      onClick={(e) => {
        if (e.target === e.currentTarget) close();
      }}
      className="m-0 mb-auto w-full max-w-none border-0 bg-transparent p-0 text-fg sm:mx-auto sm:mt-[12vh] sm:max-w-[680px]"
    >
      <div style={{ animation: "bl-enter var(--bl-dur-slow) var(--bl-ease)" }}>
        <div className="flex min-w-0 flex-col overflow-hidden rounded-b-md border-b border-line-strong bg-raised text-fg sm:rounded-md sm:border">
          {/* Sökfält */}
          <div className="flex h-12 items-center gap-3 border-b border-line pr-2 pl-4">
            <Icon name="search" className="shrink-0 text-subtle" />
            {step ? (
              <button
                type="button"
                onClick={() => {
                  step.onBack();
                  setActiveId(null);
                  inputRef.current?.focus();
                }}
                aria-label={`Tillbaka från ${step.label}`}
                className="meta inline-flex h-7 max-w-[45%] shrink-0 items-center gap-1 rounded-xs border border-line-strong px-2 text-muted transition-colors duration-fast ease-instrument hover:bg-hover hover:text-fg"
              >
                <Icon name="chevronLeft" size={12} className="shrink-0" />
                <span className="truncate">{step.label}</span>
              </button>
            ) : null}
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
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={onKeyDown}
              className="h-full min-w-0 flex-1 bg-transparent text-md text-fg outline-none placeholder:text-subtle"
            />
            {query ? (
              <button
                type="button"
                onClick={() => {
                  setQuery("");
                  inputRef.current?.focus();
                }}
                className="label inline-flex h-7 items-center rounded-xs px-2 text-subtle transition-colors duration-fast ease-instrument hover:bg-hover hover:text-fg"
              >
                Rensa
              </button>
            ) : null}
            <button
              type="button"
              onClick={close}
              aria-label="Stäng"
              className="inline-flex h-7 items-center rounded-sm px-1.5 text-muted transition-colors duration-fast ease-instrument hover:bg-hover hover:text-fg"
            >
              <span className="hidden sm:inline-flex">
                <Kbd>Esc</Kbd>
              </span>
              <Icon name="close" className="sm:hidden" />
            </button>
          </div>

          {/* Resultat */}
          <div
            ref={listRef}
            id={listId}
            role="listbox"
            aria-label="Resultat"
            aria-busy={busy || undefined}
            className={cn(
              "max-h-[min(64dvh,480px)] overflow-y-auto overscroll-contain",
              count > 0 && "py-1.5",
            )}
          >
            {sections.map((section) => {
              if (section.rows.length === 0) return null;
              const headId = `${baseId}-g-${section.id}`;
              return (
                <div key={section.id} role="group" aria-labelledby={headId}>
                  <div
                    id={headId}
                    role="presentation"
                    className="label flex items-center justify-between px-4 pt-2.5 pb-1.5 text-subtle"
                  >
                    <span>{section.label}</span>
                    {section.count !== undefined ? (
                      <span className="tnum">{section.count}</span>
                    ) : null}
                  </div>
                  {section.rows.map((row, ri) => {
                    const i = indexOf.get(row.id) ?? -1;
                    const isActive = i === activeIndex;
                    return (
                      <div
                        key={row.id}
                        id={optionId(i)}
                        role="option"
                        aria-selected={isActive}
                        data-first={ri === 0 ? "" : undefined}
                        onPointerMove={() => {
                          if (activeId !== row.id) setActiveId(row.id);
                        }}
                        onPointerDown={(e) => e.preventDefault()}
                        onClick={() => row.onSelect()}
                        className={cn(
                          "relative mx-1.5 flex min-h-9 cursor-default items-center gap-3 rounded-sm py-1.5 pr-2.5 pl-[22px] select-none sm:py-0",
                          isActive && "bg-hover",
                        )}
                      >
                        <span
                          aria-hidden
                          className={cn(
                            "absolute top-1/2 left-2 size-1 -translate-y-1/2 bg-fg transition-opacity duration-fast ease-instrument",
                            isActive ? "opacity-100" : "opacity-0",
                          )}
                        />
                        {row.icon ? (
                          <Icon
                            name={row.icon}
                            className={cn("shrink-0", isActive ? "text-fg" : "text-subtle")}
                          />
                        ) : null}
                        <span className="flex min-w-0 flex-1 flex-col sm:flex-row sm:items-baseline sm:gap-3">
                          <span className="flex min-w-0 items-baseline gap-2">
                            {row.code ? (
                              <span className="tnum shrink-0 font-mono text-sm text-muted">
                                <Highlight text={row.code} indices={row.codeIndices} />
                              </span>
                            ) : null}
                            <span
                              className={cn(
                                "min-w-0 truncate text-base",
                                row.labelIndices?.length ? "text-muted" : "text-fg",
                              )}
                            >
                              <Highlight text={row.label} indices={row.labelIndices} />
                            </span>
                          </span>
                          {row.meta?.length ? (
                            <span className="tnum min-w-0 truncate font-mono text-xs text-subtle sm:ml-auto sm:shrink-0">
                              {row.meta.join(" · ")}
                            </span>
                          ) : null}
                        </span>
                        {row.opensStep ? (
                          <Icon name="chevronRight" className="shrink-0 text-subtle" />
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {count === 0 && empty ? <div className="px-4 pt-5 pb-6">{empty}</div> : null}

          {/* Sidfot */}
          <div className="flex h-9 items-center justify-between gap-4 border-t border-line px-4 font-mono text-xs text-subtle">
            <span className="hidden items-center gap-1.5 sm:flex" aria-hidden>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd>
              <span className="mr-2">välj</span>
              <Kbd>↵</Kbd>
              <span className="mr-2">öppna</span>
              <Kbd>Esc</Kbd>
              <span>{query ? "rensa" : step ? "tillbaka" : "stäng"}</span>
            </span>
            <span className="tnum ml-auto truncate" role="status" aria-live="polite">
              {status}
            </span>
          </div>
        </div>
      </div>
    </dialog>
  );
}
