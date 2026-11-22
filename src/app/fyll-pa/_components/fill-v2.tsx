"use client";

import "./fill-v2.css";

import { useMemo, useState, type ReactNode } from "react";

import { Badge } from "@/components/v2/badge";
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
  mysteryNote,
  mysteryShortAtHome,
  type FillMachine,
  type FillRow,
  type PackAsk,
} from "../_lib/model";
import {
  bringCount,
  listChip,
  stepperBounds,
  tileView,
  urgentPacks,
  type MachineLink,
} from "../_lib/tiles";

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
/* Automaten överst: kompakt rubrik (ägarens val A)                           */
/* -------------------------------------------------------------------------- */

/**
 * Rubriken i Fyll på (V2): tillbaka, "Automat 09 · Rutor och Rollspel" (ett tryck byter automat,
 * eller ruttens stegrad "Stopp 2 av 5"), EN rad under ("Sala · 33 % fylld · Awish läst 09:46")
 * med ett litet märke när automaten är offline eller strömmen är av, och en rad med Kör dit,
 * Ring, Uppdatera och nätet. Inget stort adresskort.
 */
export function MachineTop({
  m,
  store,
  machines,
  onPick,
  onBack,
  backLabel,
  route,
  syncLabel,
  link,
  tools,
}: {
  m: FillMachine;
  store: FillStore | null;
  machines: readonly FillMachine[];
  onPick: (id: string) => void;
  onBack: () => void;
  backLabel: string;
  /** Ruttläget: "Stopp 2 av 5" i stället för väljaren. */
  route: { index: number; total: number; onPrev?: () => void; onNext?: () => void } | null;
  syncLabel?: string;
  /** Offline, eller strömmen av just nu (maskinhälsan). */
  link?: MachineLink | null;
  /** Uppdatera och nätet, till höger på raden under. */
  tools?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const place = store?.name ?? m.place;
  const title = m.name && m.name !== place ? `${m.name} · ${place}` : place;
  const sub = [
    store?.city,
    m.fillPct !== null ? `${formatInt(m.fillPct)}${NBSP}% fylld` : null,
    syncLabel,
  ]
    .filter(Boolean)
    .join(" · ");
  const power = powerText(store);
  const chip =
    link === "offline" ? (
      <Badge tone="critical" dot>
        Offline
      </Badge>
    ) : link === "power_off" ? (
      <Badge dot title={power ?? undefined}>
        Strömmen av
      </Badge>
    ) : null;
  return (
    <header className="mtop">
      <div className="mt1">
        <button type="button" className="back" onClick={onBack} aria-label={backLabel}>
          <svg
            width="22"
            height="22"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M15 18l-6-6 6-6" />
          </svg>
        </button>
        <div className="mt-t">
          <h1>
            {route ? (
              <span className="nm">{title}</span>
            ) : (
              <Sheet
                open={open}
                onOpenChange={setOpen}
                title="Byt automat"
                description="Störst behov först."
                trigger={
                  <button type="button" className="nm pickb" aria-haspopup="dialog">
                    <span className="nmt">{title}</span>
                    <svg
                      width="16"
                      height="16"
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
          </h1>
          {sub || chip ? (
            <p className="sub">
              {sub ? <span>{sub}</span> : null}
              {chip}
            </p>
          ) : null}
        </div>
      </div>
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
      <div className="mt2">
        <span className="links">
          {store ? (
            <>
              <MapsLink
                address={store.address}
                city={store.city}
                lat={store.lat}
                lng={store.lng}
                size="sm"
                className="plain"
              />
              <CallLink phone={store.phone} name={store.contactName} size="sm" className="plain" />
            </>
          ) : null}
        </span>
        {tools ? <span className="tools">{tools}</span> : null}
      </div>
    </header>
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
/* Ett fack (en titel) som ruta, och arket för facket                         */
/* -------------------------------------------------------------------------- */

/**
 * En ruta per fack (ägarens val A): stor packbild (blek när facket är slut och inget är valt),
 * titeln, en stapel med "nytt/kapacitet" (grön när facket blir fullt), "Slut" när facket är tomt.
 * Vald: mörk kant och "+N". Ett tryck fyller facket eller öppnar arket (tiles.ts).
 */
export function SlotTile({
  row: r,
  value,
  onTap,
}: {
  row: FillRow;
  value: number;
  onTap: () => void;
}) {
  const v = tileView(r, value);
  const cap = r.capacity;
  const label = [
    r.name,
    cap !== null
      ? `${formatInt(v.shown)} av ${formatInt(cap)} i automaten`
      : `${formatInt(v.shown)} i automaten`,
    v.out ? "slut" : null,
    value > 0 ? `fyller på ${formatInt(value)}` : null,
  ]
    .filter(Boolean)
    .join(", ");
  return (
    <button
      type="button"
      className={cn("tile", value > 0 && "on", v.full && "full")}
      aria-label={label}
      aria-pressed={value > 0}
      onClick={onTap}
    >
      {value > 0 ? (
        <span className="plus" aria-hidden="true">
          +{formatInt(value)}
        </span>
      ) : null}
      <span className="img" aria-hidden="true">
        <PackImage title={r.name} size="tile" className={cn(v.out && "dim")} />
      </span>
      <span className="nm" aria-hidden="true">
        {r.name}
      </span>
      <span className="fl" aria-hidden="true">
        <span className={cn("bar", cap === null && "unk")}>
          {cap !== null ? (
            <>
              <i className="add" style={{ transform: `scaleX(${v.shownShare})` }} />
              <i className="now" style={{ transform: `scaleX(${v.nowShare})` }} />
            </>
          ) : null}
        </span>
        <span className="n">
          {cap !== null ? `${formatInt(v.shown)}/${formatInt(cap)}` : formatInt(v.shown)}
        </span>
      </span>
      {v.out ? (
        <span className="chips" aria-hidden="true">
          <Badge tone="critical">Slut</Badge>
        </span>
      ) : null}
    </button>
  );
}

/**
 * Arket för ett fack: stegaren (48 px), "Töm", läget och lagret, varningarna (utan uttag,
 * mystery, fullt men säljer fort) och "Fel antal i automaten?". Samma regler som förut.
 */
export function SlotSheet({
  row: r,
  open,
  onClose,
  value,
  onChange,
  sourceName,
  hasSource,
  countSlot,
}: {
  row: FillRow;
  open: boolean;
  onClose: () => void;
  value: number;
  onChange: (v: number) => void;
  sourceName: string;
  hasSource: boolean;
  /** "Fel antal i automaten?" (räkna om), samma formulär som förut. */
  countSlot: ReactNode;
}) {
  const t = useT();
  const { min, max } = stepperBounds(r);
  const short = value > Math.max(0, r.home);
  const fullNote = fullFastNote(r, t);
  const mystery = mysteryNote(r, value, t);
  const shortBatch = hasSource && value === 0 ? mysteryShortAtHome(r) : null;
  const cap = r.capacity;
  const v = tileView(r, value);
  const empty = r.status === "empty" || r.now <= 0;
  return (
    <Sheet
      open={open}
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      title={r.name}
      description={
        cap !== null
          ? `${formatInt(r.now)} av ${formatInt(cap)} i automaten`
          : `${formatInt(r.now)} i automaten`
      }
      footer={
        <>
          <Button size="lg" onClick={() => onChange(0)} disabled={value === 0}>
            Töm
          </Button>
          <Button size="lg" variant="act" onClick={onClose}>
            Stäng
          </Button>
        </>
      }
    >
      <div className="v2-slotsheet">
        <div className="ss-top">
          <PackImage title={r.name} size="xl" className={cn(v.out && "dim")} />
          <div className="ss-facts">
            {empty ? (
              <small className="crit">Slut</small>
            ) : r.emptySlots > 0 ? (
              <small className="o">{t.fill.needEmptySlots(r.emptySlots)}</small>
            ) : r.status === "low" ? (
              <small className="o">{t.fill.statusLow}</small>
            ) : null}
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
                {t.r2.t1.fill.mysteryReady(Math.max(0, r.home), sourceName)}
              </small>
            ) : null}
          </div>
        </div>
        {shortBatch !== null ? (
          <Button size="lg" onClick={() => onChange(shortBatch)}>
            {t.r2.t1.fill.mysteryFillBatch(shortBatch)}
          </Button>
        ) : null}
        <div className="ss-step">
          <Stepper
            className="big"
            value={value}
            onChange={onChange}
            min={min}
            max={max}
            label={r.name}
            lessLabel={t.fill.lessAria(r.name)}
            moreLabel={t.fill.moreAria(r.name)}
            inputId={`antal-${r.titleId}`}
          />
          <span className={cn("gets", v.full && value > 0 && "full")} aria-live="polite">
            {cap !== null ? `${formatInt(v.shown)}/${formatInt(cap)}` : formatInt(v.shown)}
            {v.full && value > 0 ? " · fullt" : ""}
          </span>
        </div>
        <div className="ss-cnt">{countSlot}</div>
      </div>
    </Sheet>
  );
}

/* -------------------------------------------------------------------------- */
/* Listan: ett kort per automat                                               */
/* -------------------------------------------------------------------------- */

/**
 * En automat i listan (V2, val A): namn, kod och stad, fyllnaden som stapel med procent,
 * "Ta med N pack", upp till sex packbilder för titlar som är slut eller snart slut (bleka när
 * de är slut) och ett märke (Offline, Slut, Fyll på i dag, Strömmen av).
 */
export function FillCard({
  machine: m,
  store,
  link,
  href,
  ariaLabel,
  onOpen,
}: {
  machine: FillMachine;
  store: FillStore | null;
  link?: MachineLink | null;
  href: string;
  ariaLabel: string;
  onOpen: () => void;
}) {
  const place = store?.name ?? m.place;
  const title = m.name && m.name !== place ? `${m.name} · ${place}` : place;
  const chip = listChip(m, link);
  const bring = bringCount(m);
  const packs = urgentPacks(m);
  return (
    <a
      href={href}
      onClick={(e) => {
        if (e.metaKey || e.ctrlKey || e.shiftKey) return;
        e.preventDefault();
        onOpen();
      }}
      aria-label={ariaLabel}
      className={cn(
        "mcard",
        chip?.tone === "critical" ? "crit" : chip?.tone === "warning" && "hot",
      )}
    >
      <span className="top2">
        <span className="min-w-0">
          <b>{title}</b>
          <small>{[m.code, store?.city].filter(Boolean).join(" · ")}</small>
        </span>
        {chip ? (
          <Badge tone={chip.tone} dot={chip.tone !== "warning"}>
            {chip.text}
          </Badge>
        ) : null}
      </span>
      {m.fillPct !== null ? (
        <span className="fillrow">
          <span className="bar" aria-hidden="true">
            <i
              className={cn("now", m.fillPct <= 25 && "o")}
              style={{ transform: `scaleX(${Math.max(0, Math.min(1, m.fillPct / 100))})` }}
            />
          </span>
          <span className="pc">{`${formatInt(m.fillPct)}${NBSP}%`}</span>
        </span>
      ) : (
        <span className="need none">Hur full den är syns efter nästa läsning</span>
      )}
      <span className="foot2">
        <span className={cn("need", bring === 0 && "none")}>
          {bring > 0 ? `Ta med ${formatInt(bring)}${NBSP}pack` : "Inget behövs"}
        </span>
        {packs.length > 0 ? (
          <span className="pks" aria-hidden="true">
            {packs.map((p) => (
              <PackImage key={p.titleId} title={p.name} size="m" className={cn(p.empty && "dim")} />
            ))}
          </span>
        ) : null}
      </span>
    </a>
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
