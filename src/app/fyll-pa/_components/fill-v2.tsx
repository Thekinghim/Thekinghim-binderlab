"use client";

import "./fill-v2.css";

import { useMemo, useState, type ReactNode } from "react";

import { Button } from "@/components/v2/button";
import { CallLink, MapsLink } from "@/components/v2/call-link";
import { Chips } from "@/components/v2/chips";
import { PackImage } from "@/components/v2/pack-image";
import { Sheet } from "@/components/v2/sheet";
import { Stepper } from "@/components/v2/stepper";
import { useT } from "@/i18n/client";
import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";

import type { FillStore } from "../_lib/data";
import {
  fullFastNote,
  maxFill,
  mysteryNote,
  mysteryShortAtHome,
  type FillMachine,
  type FillRow,
  type PackAsk,
} from "../_lib/model";

/* -------------------------------------------------------------------------- */
/* Hjälpare                                                                   */
/* -------------------------------------------------------------------------- */

/** "Strömmen av 21:00–08:00", null = alltid på. */
export function powerText(store: FillStore | null | undefined): string | null {
  return store?.power ? `Strömmen av ${store.power.off}–${store.power.on}` : null;
}

/** Prickens ton för en automat i väljaren: tom/slut (röd), behöver (orange), annars bläck. */
function dotTone(m: FillMachine): "critical" | "warning" | undefined {
  if (m.empty > 0 || m.emptySlots > 0) return "critical";
  if (m.needs) return "warning";
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Automaten överst: väljaren, butiken och vad som ska med                    */
/* -------------------------------------------------------------------------- */

/**
 * Kortet överst i Fyll på (V2): automaten med "Byt automat" (eller ruttens stegrad), butikens
 * namn, strömtider, adress med Kör dit och Ring, och till höger "20 % fylld · 2 fack tomma" och
 * "Ta med 64 pack" (förslaget ur modellen).
 */
export function MachineHead({
  m,
  store,
  machines,
  onPick,
  route,
  syncLabel,
}: {
  m: FillMachine;
  store: FillStore | null;
  machines: readonly FillMachine[];
  onPick: (id: string) => void;
  /** Ruttläget: "Stopp 2 av 5" i stället för väljaren. */
  route: { index: number; total: number; onPrev?: () => void; onNext?: () => void } | null;
  syncLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const power = powerText(store);
  const facts = [
    m.fillPct !== null ? `${formatInt(m.fillPct)}${NBSP}% fylld` : null,
    m.emptySlots > 0
      ? `${formatInt(m.emptySlots)} ${m.emptySlots === 1 ? "fack tomt" : "fack tomma"}`
      : null,
  ].filter(Boolean);
  return (
    <section className="pn pick" aria-label="Automat">
      {route ? (
        <div className="rstep">
          <Button size="sm" variant="plain" onClick={route.onPrev} disabled={!route.onPrev}>
            ‹ Förra
          </Button>
          <b>
            Stopp {formatInt(route.index + 1)} av {formatInt(route.total)}
          </b>
          <Button size="sm" variant="plain" onClick={route.onNext} disabled={!route.onNext}>
            Nästa ›
          </Button>
        </div>
      ) : null}
      <div className="mpick">
        <span className={cn("v2-dot", dotTone(m))} aria-hidden="true" />
        <span className="mp-t">
          <b>{m.name}</b>
          <small>{[m.code, store?.city, syncLabel].filter(Boolean).join(" · ")}</small>
        </span>
        {route ? null : (
          <Sheet
            open={open}
            onOpenChange={setOpen}
            title="Byt automat"
            description="Störst behov först."
            trigger={
              <button type="button" className="v2-btn mp-c" aria-haspopup="dialog">
                Byt automat
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M6 9l6 6 6-6" />
                </svg>
              </button>
            }
          >
            <MachinePicker
              machines={machines}
              selectedId={m.id}
              onPick={(id) => {
                setOpen(false);
                onPick(id);
              }}
            />
          </Sheet>
        )}
      </div>
      <div className="msum">
        <div className="who2">
          {/* Butiken är automatens rubrik (skärmläsare och e2e: rubriken med butikens namn). */}
          <b role="heading" aria-level={2}>
            {store?.name ?? m.place}
          </b>
          {power ? <small>{power}</small> : null}
          {store?.address || store?.city ? (
            <small>{[store.address, store.city].filter(Boolean).join(", ")}</small>
          ) : null}
          {store ? (
            <span className="links">
              <MapsLink
                address={store.address}
                city={store.city}
                lat={store.lat}
                lng={store.lng}
                size="sm"
                className="plain"
              />
              <CallLink phone={store.phone} name={store.contactName} size="sm" className="plain" />
            </span>
          ) : null}
        </div>
        <div className="facts">
          {facts.length > 0 ? <span className="pc">{facts.join(" · ")}</span> : null}
          {m.suggested > 0 ? (
            <span className="bring">Ta med {formatInt(m.suggested)} pack</span>
          ) : (
            <span className="bring none">Inget behövs</span>
          )}
        </div>
      </div>
    </section>
  );
}

/** Väljaren i arket: Behöver påfyllning / Alla, sök, automater med fyllnad. */
function MachinePicker({
  machines,
  selectedId,
  onPick,
}: {
  machines: readonly FillMachine[];
  selectedId: string;
  onPick: (id: string) => void;
}) {
  const needing = machines.filter((m) => m.needs).length;
  const [show, setShow] = useState<"behover" | "alla">(needing > 0 ? "behover" : "alla");
  const [q, setQ] = useState("");
  const list = useMemo(() => {
    const words = q.toLowerCase().trim().split(/\s+/).filter(Boolean);
    return machines.filter(
      (m) =>
        (show === "alla" || m.needs || m.id === selectedId) &&
        words.every((w) => `${m.place} ${m.name} ${m.code}`.toLowerCase().includes(w)),
    );
  }, [machines, q, show, selectedId]);
  return (
    <div className="v2-fillpick">
      <input
        type="search"
        className="pq"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        placeholder="Sök automat eller butik"
        aria-label="Sök automat"
        autoComplete="off"
        enterKeyHint="search"
      />
      <Chips
        options={[
          { value: "behover", label: "Behöver påfyllning", count: needing },
          { value: "alla", label: "Alla", count: machines.length },
        ]}
        value={show}
        onChange={setShow}
        ariaLabel="Visa"
      />
      <div role="listbox" aria-label="Automater" className="pitems">
        {list.length === 0 ? <p className="pempty">Inga automater här.</p> : null}
        {list.map((m) => (
          <button
            key={m.id}
            type="button"
            role="option"
            aria-selected={m.id === selectedId}
            className="pi"
            onClick={() => onPick(m.id)}
          >
            <span className={cn("v2-dot", dotTone(m))} aria-hidden="true" />
            <span className="pt">
              <b>{m.name}</b>
              <small>
                {m.place} · {m.code}
              </small>
            </span>
            <span className={cn("pp", m.needs && "o")}>
              {m.fillPct === null ? "–" : `${formatInt(m.fillPct)}${NBSP}%`}
            </span>
          </button>
        ))}
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Sammanfattningen och Klar                                                  */
/* -------------------------------------------------------------------------- */

/** "Välj vad du fyller på" / "Du fyller på 64 pack", och "Lerum är 20 % → 80 %". */
export function SayCard({
  m,
  total,
  after,
  source,
}: {
  m: FillMachine;
  total: number;
  after: number | null;
  source: ReactNode;
}) {
  const now = m.fillPct;
  return (
    <section className="pn say" aria-live="polite">
      <h2>{total > 0 ? `Du fyller på ${formatInt(total)} pack` : "Välj vad du fyller på"}</h2>
      {now !== null ? (
        <div className="after">
          <span className="msg">
            {m.place} är <b>{formatInt(now)}&nbsp;%</b>
            {after !== null && after !== now ? (
              <>
                {" "}
                → <b>{formatInt(after)}&nbsp;%</b>
              </>
            ) : null}
          </span>
          <span className="bar" aria-hidden="true">
            <i className="add" style={{ transform: `scaleX(${(after ?? now) / 100})` }} />
            <i
              className={cn("now", now <= 25 && "o")}
              style={{ transform: `scaleX(${now / 100})` }}
            />
          </span>
        </div>
      ) : null}
      {source}
    </section>
  );
}

/* -------------------------------------------------------------------------- */
/* Ett fack (en titel)                                                        */
/* -------------------------------------------------------------------------- */

/**
 * En rad per titel (V2): packbild, nummer och titel, läget ("Slut", "2 av 10 i automaten",
 * "Hemma 141"), en mätare med det som finns (bläck) och det som läggs i (grått), stegaren som
 * räknar upp när man håller in, och "Fyll fack" (fullt). Samma regler som förut (model.ts).
 */
export function SlotRow({
  index,
  row: r,
  sourceName,
  hasSource,
  value,
  onChange,
  countSlot,
}: {
  index: number;
  row: FillRow;
  sourceName: string;
  hasSource: boolean;
  value: number;
  onChange: (v: number) => void;
  /** "Fel antal i automaten?" (räkna om), samma formulär som förut. */
  countSlot: ReactNode;
}) {
  const t = useT();
  const max = maxFill(r);
  const short = value > Math.max(0, r.home);
  const fullNote = fullFastNote(r, t);
  const mystery = mysteryNote(r, value, t);
  const shortBatch = hasSource && value === 0 ? mysteryShortAtHome(r) : null;
  const cap = r.capacity;
  const nowShare = cap ? Math.min(1, r.now / cap) : 0;
  const addShare = cap ? Math.min(1, (r.now + value) / cap) : 0;
  const empty = r.status === "empty" || r.now <= 0;
  const fillTo = Math.min(max, cap !== null ? Math.max(0, cap - r.now) : r.suggested);
  return (
    <div className={cn("row", empty && "e")}>
      <PackImage title={r.name} size="md" className={cn(empty && "dim")} />
      <div className="info">
        <div className="t">
          <span className="no">{String(index + 1).padStart(2, "0")}</span>
          <b>{r.name}</b>
        </div>
        <small>
          {empty ? (
            <span className="crit">Slut</span>
          ) : r.emptySlots > 0 ? (
            <span className="o">{t.fill.needEmptySlots(r.emptySlots)}</span>
          ) : r.status === "low" ? (
            <span className="o">{t.fill.statusLow}</span>
          ) : null}
          {empty || r.emptySlots > 0 || r.status === "low" ? " · " : ""}
          {cap !== null
            ? `${formatInt(r.now)} av ${formatInt(cap)} i automaten`
            : `${formatInt(r.now)} i automaten`}
        </small>
        {hasSource ? (
          <small className={cn(short && "o")}>
            {t.fill.stockLine(t.common.placeName(sourceName), r.home)}
            {short && r.home > 0 ? t.fill.withoutWithdrawalN(value - r.home) : ""}
            {short && r.home <= 0 ? t.fill.withoutWithdrawal : ""}
          </small>
        ) : null}
        {fullNote ? <small>{`${fullNote} · ${t.fill.fullFastTip}`}</small> : null}
        {mystery ? <small role="note">{mystery}</small> : null}
        {shortBatch !== null ? (
          <small className="o" role="note">
            {t.r2.t1.fill.mysteryReady(Math.max(0, r.home), sourceName)}{" "}
            <button type="button" className="lnk" onClick={() => onChange(shortBatch)}>
              {t.r2.t1.fill.mysteryFillBatch(shortBatch)}
            </button>
          </small>
        ) : null}
      </div>
      <div className="meter">
        {cap !== null ? (
          <span className="mini" aria-hidden="true">
            <i className="add" style={{ transform: `scaleX(${addShare})` }} />
            <i className="now" style={{ transform: `scaleX(${nowShare})` }} />
            <span className="ticks" />
          </span>
        ) : null}
        <span className={cn("gets", cap !== null && r.now + value >= cap && "full")}>
          {value > 0 ? `+${formatInt(value)}` : ""}
          {cap !== null && r.now + value >= cap && value > 0 ? " · fullt" : ""}
        </span>
      </div>
      <Stepper
        className="step"
        value={value}
        onChange={onChange}
        min={0}
        max={max}
        label={r.name}
        lessLabel={t.fill.lessAria(r.name)}
        moreLabel={t.fill.moreAria(r.name)}
        inputId={`antal-${r.titleId}`}
      />
      <Button
        size="sm"
        className="fillb"
        disabled={fillTo <= 0 || value === fillTo}
        onClick={() => onChange(fillTo)}
      >
        Fyll fack
      </Button>
      <div className="cnt">{countSlot}</div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Arken: bekräfta Klar och mystery-frågan                                    */
/* -------------------------------------------------------------------------- */

export function ConfirmSheet({
  open,
  total,
  busy,
  restart,
  onYes,
  onClose,
}: {
  open: boolean;
  total: number;
  busy: boolean;
  /** Butiken stänger av strömmen: påminn redan här. */
  restart: boolean;
  onYes: () => void;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => (!o && !busy ? onClose() : undefined)}
      title={t.fill.confirmQuestion}
      description={t.fill.confirmDetail(total)}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            {t.fill.confirmNo}
          </Button>
          <Button variant="act" onClick={onYes} pending={busy}>
            {busy ? t.common.saving : t.fill.confirmYes}
          </Button>
        </>
      }
    >
      {restart ? <p className="text-v2-sm text-v2-mute">{t.fill.restartScreen}</p> : null}
    </Sheet>
  );
}

export function MysterySheet({
  ask,
  last,
  busy,
  packing,
  sourceName,
  cut,
  onAnswer,
  onCancel,
}: {
  ask: PackAsk | undefined;
  last: boolean;
  busy: boolean;
  packing: boolean;
  sourceName: string;
  /** "Omgången tar delar som också står på listan" (före Ja). */
  cut: readonly string[];
  onAnswer: (yes: boolean) => void;
  onCancel: () => void;
}) {
  const t = useT();
  return (
    <Sheet
      open={ask !== undefined}
      onOpenChange={(o) => (!o && !busy ? onCancel() : undefined)}
      title={ask ? t.r2.t1.fill.packAskQuestion(ask.batches) : ""}
      description={ask ? t.r2.t1.fill.packAskHave(ask.home, ask.name, sourceName) : undefined}
      dismissible={!busy}
    >
      {ask ? (
        <div className="v2-mystery">
          <div className="shd">
            <PackImage title={ask.name} size="xl" />
            <p>{t.r2.t1.fill.packAskDetail(sourceName)}</p>
          </div>
          {cut.map((c) => (
            <p key={c} className="cut">
              {c}
            </p>
          ))}
          <div className="acts">
            <Button variant="act" size="lg" pending={busy} onClick={() => onAnswer(true)}>
              {busy
                ? packing
                  ? t.r2.t1.fill.packing
                  : t.common.saving
                : t.r2.t1.fill.packAskYes(ask.batches, last)}
            </Button>
            <Button size="lg" disabled={busy} onClick={() => onAnswer(false)}>
              {t.r2.t1.fill.packAskNo(last)}
            </Button>
            <Button size="lg" variant="quiet" disabled={busy} onClick={onCancel}>
              {t.common.cancel}
            </Button>
          </div>
        </div>
      ) : null}
    </Sheet>
  );
}
