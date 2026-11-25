"use client";

import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { Drawer } from "vaul";

import {
  MAX_RANGE_DAYS,
  inclusiveDays,
  parseIsoDate,
  periodName,
  periodNameCompact,
  toIsoDate,
  type DateRange,
  type PeriodSelection,
  type PresetKey,
} from "@/components/shell/period-state";
import { useShellNavigation } from "@/components/shell/shell-navigation";
import { usePeriod } from "@/components/shell/use-period";
import { cn } from "@/lib/cn";
import { formatPeriodShort } from "@/lib/format";
import { addDays, isSameDay } from "@/lib/period";

import { V2_PERIODS, V2_PERIODS_SHORT, v2PeriodOf } from "./period";
import { RangeCalendar, draftRange, type RangeDraft } from "./range-calendar";
import { Segmented } from "./segmented";
import { useV2Shell } from "./shell/shell-context";
import { usePhone } from "./use-media";

/** Snabbvalen i panelen (Datum…), i den ordning de står. */
const PANEL_PRESETS: ReadonlyArray<{ key: PresetKey; label: string }> = [
  { key: "idag", label: "I dag" },
  { key: "igar", label: "I går" },
  { key: "7d", label: "7 dagar" },
  { key: "30d", label: "30 dagar" },
  { key: "manad", label: "Denna månad" },
  { key: "forra-manaden", label: "Förra månaden" },
];

/**
 * Periodvalet i V2: snabbknapparna 30 dagar / 7 dagar / I går / I dag (samma kompakta
 * segment som förut) och "Datum", som öppnar en intervallkalender med fler snabbval och
 * datumfält: en ruta under knappen på datorn, ett ark nerifrån på telefonen (vaul). Valet
 * skrivs till ?period eller ?from&to (servern räknar om sidan, skalet tonar innehållet medan
 * det laddar) och sparas i en kaka så att nästa periodsida visar samma period.
 */
export function PeriodSegment({ className }: { className?: string }) {
  const shell = useV2Shell();
  const period = usePeriod({ timeZone: shell?.timeZone });
  const { key, range, today, setPeriod } = period;
  const pending = useShellNavigation()?.pending ?? false;
  const phone = usePhone();
  const [open, setOpen] = useState(false);
  const value = v2PeriodOf(key);
  const close = useCallback(() => setOpen(false), []);

  // setPeriod sparar också valet i kakan, så att nästa periodsida får samma period.
  const choose = useCallback((selection: PeriodSelection) => setPeriod(selection), [setPeriod]);

  const name = periodName(period);
  // Telefonens smala knapp: ett eget intervall med siffror (28/12–3/1), så att slutet syns.
  const shown = phone ? periodNameCompact(period) : name;
  const triggerId = useId();

  const trigger = (
    <button
      type="button"
      id={triggerId}
      className={cn("v2-pdate", value === null && "on")}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-label={value === null ? `Period: ${name}. Välj datum` : "Välj datum eller intervall"}
      onClick={phone ? undefined : () => setOpen((o) => !o)}
    >
      <CalendarIcon />
      <span className="lbl" title={value === null && shown !== name ? name : undefined}>
        {value === null ? shown : "Datum"}
      </span>
    </button>
  );

  // Ny panel (nytt utkast) varje gång den öppnas; arket behåller innehållet medan det stängs.
  const panel = (
    <PeriodPanel
      key={open ? "open" : "closed"}
      current={range}
      currentKey={key}
      today={today}
      onPreset={(k) => {
        setOpen(false);
        choose({ key: k });
      }}
      onRange={(r) => {
        setOpen(false);
        // En enda dag som är i dag eller i går är förvalet (samma jämförelse och knapp).
        if (isSameDay(r.start, r.end) && isSameDay(r.start, today)) choose({ key: "idag" });
        else if (isSameDay(r.start, r.end) && isSameDay(r.start, addDays(today, -1))) {
          choose({ key: "igar" });
        } else choose({ key: "eget", range: r });
      }}
      onCancel={close}
      phone={phone}
    />
  );

  return (
    <span
      className={cn("v2-seg-period", pending && "busy", className)}
      aria-busy={pending || undefined}
    >
      <Segmented
        ariaLabel="Period"
        options={phone ? V2_PERIODS_SHORT : V2_PERIODS}
        value={value}
        onChange={(v) => choose({ key: v })}
      />
      {phone ? (
        <Drawer.Root open={open} onOpenChange={setOpen} direction="bottom" repositionInputs>
          <Drawer.Trigger asChild>{trigger}</Drawer.Trigger>
          <Drawer.Portal>
            <Drawer.Overlay className="v2-scrim" />
            <Drawer.Content className="v2-sheet v2-psheet" aria-describedby={undefined}>
              <span className="grab" aria-hidden="true" />
              <div className="sh">
                <Drawer.Title asChild>
                  <h2>Välj period</h2>
                </Drawer.Title>
              </div>
              <div className="sb">{panel}</div>
            </Drawer.Content>
          </Drawer.Portal>
        </Drawer.Root>
      ) : (
        <Popover open={open} onClose={close} trigger={trigger} labelledBy={triggerId}>
          {panel}
        </Popover>
      )}
    </span>
  );
}

/** Rutan under datumknappen på datorn: Escape och klick utanför stänger, fokus tillbaka. */
function Popover({
  open,
  onClose,
  trigger,
  labelledBy,
  children,
}: {
  open: boolean;
  onClose: () => void;
  trigger: ReactNode;
  labelledBy: string;
  children: ReactNode;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (root.current && !root.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      onClose();
      root.current?.querySelector<HTMLButtonElement>("button.v2-pdate")?.focus();
    };
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    // Fokus till panelens första snabbval, så att tangentbordet hamnar i rutan.
    box.current?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);
  return (
    <span ref={root} className="v2-pop-anchor">
      {trigger}
      {open ? (
        <div ref={box} className="v2-pop" role="dialog" aria-labelledby={labelledBy}>
          {children}
        </div>
      ) : null}
    </span>
  );
}

/**
 * Panelens innehåll (samma i rutan och arket): snabbval, kalendern, Från/Till som vanliga
 * datumfält (tangentbord, skärmläsare, telefonens egen datumväljare) och Använd.
 */
function PeriodPanel({
  current,
  currentKey,
  today,
  onPreset,
  onRange,
  onCancel,
  phone,
}: {
  current: DateRange | null;
  currentKey: string;
  today: Date;
  onPreset: (key: PresetKey) => void;
  onRange: (range: DateRange) => void;
  onCancel: () => void;
  phone: boolean;
}) {
  const min = addDays(today, -(MAX_RANGE_DAYS - 1));
  // Kalendern visar den valda perioden (även ett snabbval som "I dag" eller "7 d") som ett
  // ifyllt intervall: man ser var man står innan man väljer om.
  const [draft, setDraft] = useState<RangeDraft>(() =>
    current ? { start: current.start, end: current.end } : { start: null, end: null },
  );
  const r = draftRange(draft);
  const tooLong = r ? inclusiveDays(r.start, r.end) > MAX_RANGE_DAYS : false;
  const fromId = useId();
  const toId = useId();

  const setField = (which: "start" | "end", raw: string) => {
    const d = parseIsoDate(raw);
    if (!d) {
      setDraft((x) => ({ ...x, [which]: null }));
      return;
    }
    const v = d > today ? today : d < min ? min : d;
    setDraft((x) => {
      const next = { ...x, [which]: v };
      // Från efter Till (eller tvärtom): den andra änden flyttas till samma dag.
      return next.start && next.end && next.start > next.end ? { start: v, end: v } : next;
    });
  };

  const summary = r
    ? `${formatPeriodShort(r, today)} · ${inclusiveDays(r.start, r.end)} ${
        isSameDay(r.start, r.end) ? "dag" : "dagar"
      }`
    : draft.start
      ? "Välj sista dagen"
      : "Välj första dagen";

  return (
    <div className="v2-ppanel">
      <div className="v2-ppresets" role="group" aria-label="Snabbval">
        {PANEL_PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            aria-pressed={currentKey === p.key}
            onClick={() => onPreset(p.key)}
          >
            {p.label}
          </button>
        ))}
      </div>
      <RangeCalendar value={draft} onChange={setDraft} min={min} max={today} />
      <div className="v2-pfields">
        <label htmlFor={fromId}>
          <span>Från</span>
          <input
            id={fromId}
            type="date"
            min={toIsoDate(min)}
            max={toIsoDate(today)}
            value={draft.start ? toIsoDate(draft.start) : ""}
            onChange={(e) => setField("start", e.target.value)}
          />
        </label>
        <label htmlFor={toId}>
          <span>Till</span>
          <input
            id={toId}
            type="date"
            min={toIsoDate(min)}
            max={toIsoDate(today)}
            value={draft.end ? toIsoDate(draft.end) : ""}
            onChange={(e) => setField("end", e.target.value)}
          />
        </label>
      </div>
      <div className="v2-pfoot">
        <span className="sum" aria-live="polite">
          {tooLong ? "Högst två år" : summary}
        </span>
        {!phone ? (
          <button type="button" className="v2-btn quiet" onClick={onCancel}>
            Avbryt
          </button>
        ) : null}
        <button
          type="button"
          className={cn("v2-btn act", phone && "lg")}
          disabled={!r || tooLong}
          onClick={() => r && onRange(r)}
        >
          Använd
        </button>
      </div>
    </div>
  );
}

function CalendarIcon() {
  return (
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
      <rect x="3.5" y="5" width="17" height="15" rx="2.5" />
      <path d="M3.5 10h17M8 3v4M16 3v4" />
    </svg>
  );
}
