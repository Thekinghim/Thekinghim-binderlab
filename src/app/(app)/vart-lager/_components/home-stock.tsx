"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import type React from "react";

import { KpiStrip } from "@/components/ui/kpi-strip";
import { Icon } from "@/components/ui/icon";
import { StatusTag } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { formatInt, formatSek, MINUS, NBSP } from "@/lib/format";

import { addReceipt, setHomeCount } from "../actions";
import { lastsText, type VartLagerModel, type VartLagerRow } from "../_lib/model";

const GRID =
  "grid w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 gap-y-1 md:grid-cols-[minmax(0,1fr)_88px_80px_72px_132px_96px]";

/** Antal per titel hemma, med uppräknade nyckeltal överst. Skriv antalet: det sparas. */
export function HomeStock({ model }: { model: VartLagerModel }) {
  const t = model.totals;
  return (
    <div className="flex flex-col gap-8">
      <div className="rise" style={{ "--i": 1 } as React.CSSProperties}>
        <KpiStrip
          ariaLabel="Vårt lager i siffror"
          items={[
            {
              id: "home",
              label: "Pack hemma",
              value: t.home,
              format: formatInt,
              primary: true,
            },
            {
              id: "value",
              label: "Värde, inköpspris",
              value: t.valueOre,
              format: (v) => formatSek(v / 100),
              ...(t.unpriced > 0 ? { note: `${formatInt(t.unpriced)} utan pris` } : {}),
            },
            {
              id: "out",
              label: `Tar slut inom ${formatInt(model.lowDays)} d`,
              value: t.runsOut,
              format: (v) => `${formatInt(v)}${NBSP}titlar`,
              ...(t.runsOut > 0 ? { alert: true, alertText: "Beställ" } : {}),
            },
            {
              id: "machines",
              label: "I automaterna",
              value: t.inMachines,
              format: formatInt,
            },
          ]}
        />
      </div>

      <div className="rise flex flex-col" style={{ "--i": 2 } as React.CSSProperties}>
        <div className={cn(GRID, "border-b border-line-strong pb-2")}>
          <span className="label text-subtle">Titel</span>
          <span className="label hidden text-right text-subtle md:block">I automater</span>
          <span className="label hidden text-right text-subtle md:block">Sålt 7 d</span>
          <span className="label hidden text-right text-subtle md:block">Räcker</span>
          <span className="label text-right text-subtle">Antal hemma</span>
          <span aria-hidden />
        </div>
        <ul aria-label="Antal hemma per titel">
          {model.rows.map((r, i) => (
            <StockRow key={r.titleId} row={r} index={i} canEdit={model.canEdit} />
          ))}
        </ul>
      </div>
    </div>
  );
}

function parseCount(raw: string): number | null {
  const s = raw.replace(/[\s ]/g, "");
  if (!/^\d{1,5}$/.test(s)) return null;
  return Number(s);
}

function StockRow({ row, index, canEdit }: { row: VartLagerRow; index: number; canEdit: boolean }) {
  const toast = useToast();
  // Det man skriver, eller null: då visas antalet från servern (synken, ett inköp, en annan flik).
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? String(row.home);
  // Esc ångrar: blur som följer ska inte spara.
  const cancelled = useRef(false);
  const [saved, setSaved] = useState(0);
  const [pending, start] = useTransition();
  const [buyOpen, setBuyOpen] = useState(false);
  const [buy, setBuy] = useState("");
  const buyRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (buyOpen) buyRef.current?.focus();
  }, [buyOpen]);

  function save() {
    if (cancelled.current) {
      cancelled.current = false;
      return;
    }
    if (draft === null) return;
    const n = parseCount(draft);
    if (n === null || n === row.home) {
      setDraft(null);
      if (n === null && draft.trim() !== "") {
        toast({ title: "Ange ett heltal, 0 eller mer.", tone: "critical" });
      }
      return;
    }
    start(async () => {
      const res = await setHomeCount({ titleId: row.titleId, counted: n });
      setDraft(null);
      if (!res.ok) {
        toast({ title: "Sparades inte", description: res.error, tone: "critical" });
        return;
      }
      setSaved((k) => k + 1);
    });
  }

  function receive() {
    const n = parseCount(buy);
    if (n === null || n < 1) {
      toast({ title: "Ange antal pack, minst 1.", tone: "critical" });
      return;
    }
    start(async () => {
      const res = await addReceipt({ titleId: row.titleId, quantity: n });
      if (!res.ok) {
        toast({ title: "Inköpet sparades inte", description: res.error, tone: "critical" });
        return;
      }
      setBuy("");
      setBuyOpen(false);
      setSaved((k) => k + 1);
      toast({
        title: `+${formatInt(n)} ${row.name}`,
        description: `${formatInt(res.data.onHand)} pack hemma.`,
        tone: "ok",
      });
    });
  }

  const latest = row.latest;
  const tone = row.negative ? "critical" : row.home <= 0 && row.runsOut ? "critical" : "warning";
  return (
    <li
      className="rise border-b border-line"
      style={{ "--i": Math.min(index, 16) + 3 } as React.CSSProperties}
      data-title={row.name}
    >
      <div className={cn(GRID, "min-h-16 py-2.5")}>
        <span className="flex min-w-0 flex-col">
          <span className="flex min-w-0 items-center gap-2">
            <span className="truncate text-base text-fg">{row.name}</span>
            {row.negative ? (
              <StatusTag status="critical">Räkna om</StatusTag>
            ) : row.runsOut ? (
              <StatusTag status={tone}>{row.home <= 0 ? "Slut" : "Tar slut"}</StatusTag>
            ) : null}
          </span>
          <span className="meta truncate text-subtle">
            {latest ? (
              <>
                <span
                  className={cn(
                    "tnum",
                    latest.delta !== null && latest.delta < 0 && "text-muted",
                    latest.delta !== null && latest.delta > 0 && "text-fg",
                  )}
                >
                  {latest.text}
                </span>
                {latest.automatic ? " (Awish)" : ""}, {latest.when}
              </>
            ) : (
              "Inget räknat än"
            )}
          </span>
          <span className="meta text-subtle md:hidden">
            {formatInt(row.inMachines)} i automater · {formatInt(row.sold7)} sålda 7 d · räcker{" "}
            {lastsText(row)}
          </span>
        </span>
        <span className="tnum hidden text-right text-sm text-muted md:block">
          {formatInt(row.inMachines)}
        </span>
        <span className="tnum hidden text-right text-sm text-muted md:block">
          {formatInt(row.sold7)}
        </span>
        <span
          className={cn(
            "tnum hidden text-right text-sm md:block",
            row.runsOut ? "text-signal-fg" : "text-muted",
          )}
        >
          {lastsText(row)}
        </span>
        <span className="flex items-center justify-end gap-2">
          <span className="relative inline-flex w-5 justify-center" aria-hidden>
            {pending ? (
              <span className="live-dot size-1.5 rounded-full bg-muted text-muted" />
            ) : saved > 0 ? (
              <span key={saved} className="fade-in text-muted">
                <Icon name="check" size={14} />
              </span>
            ) : null}
          </span>
          {canEdit ? (
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              autoComplete="off"
              aria-label={`Antal hemma, ${row.name}`}
              className={cn(
                "tnum h-12 w-24 rounded-sm border bg-bg px-3 text-right text-2xl font-medium text-fg transition-[border-color,background-color] duration-fast ease-instrument hover:border-muted",
                row.negative ? "border-signal text-signal-fg" : "border-line-control",
              )}
              value={value}
              disabled={pending}
              onFocus={(e) => e.currentTarget.select()}
              onChange={(e) => setDraft(e.target.value)}
              onBlur={save}
              onKeyDown={(e) => {
                if (e.key === "Enter") e.currentTarget.blur();
                if (e.key === "Escape") {
                  cancelled.current = true;
                  setDraft(null);
                  e.currentTarget.blur();
                }
              }}
            />
          ) : (
            <span
              className={cn(
                "tnum text-2xl font-medium",
                row.negative ? "text-signal-fg" : "text-fg",
              )}
            >
              {row.home < 0 ? `${MINUS}${formatInt(-row.home)}` : formatInt(row.home)}
            </span>
          )}
        </span>
        {canEdit ? (
          <span className="flex justify-end">
            {buyOpen ? (
              <form
                className="fade-in flex items-center gap-1"
                onSubmit={(e) => {
                  e.preventDefault();
                  receive();
                }}
              >
                <input
                  ref={buyRef}
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  aria-label={`Antal köpta pack, ${row.name}`}
                  placeholder="+"
                  className="tnum h-9 w-14 rounded-sm border border-line-control bg-bg px-2 text-right text-base text-fg"
                  value={buy}
                  disabled={pending}
                  onChange={(e) => setBuy(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Escape") {
                      setBuy("");
                      setBuyOpen(false);
                    }
                  }}
                />
                <button
                  type="submit"
                  disabled={pending}
                  aria-label={`Lägg till inköp, ${row.name}`}
                  className="inline-flex size-9 items-center justify-center rounded-sm border border-inverse bg-inverse text-on-inverse hover:bg-inverse-hover"
                >
                  <Icon name="check" size={14} />
                </button>
              </form>
            ) : (
              <button
                type="button"
                onClick={() => setBuyOpen(true)}
                aria-label={`Inköp, ${row.name}`}
                className="inline-flex h-9 items-center gap-1 rounded-sm px-2 text-sm text-muted transition-colors duration-fast ease-instrument hover:bg-hover hover:text-fg"
              >
                <Icon name="plus" size={12} />
                <span className="hidden sm:inline">Inköp</span>
              </button>
            )}
          </span>
        ) : null}
      </div>
    </li>
  );
}
