"use client";

import "./fill-list.css";

import { useState, type ReactNode } from "react";
import { Drawer } from "vaul";

import { Badge } from "@/components/v2/badge";
import { Button } from "@/components/v2/button";
import { mapsSearchUrl } from "@/components/v2/links";
import { MachineGlyph } from "@/components/v2/machine-glyph";
import { PackImage } from "@/components/v2/pack-image";
import { usePhone } from "@/components/v2/use-media";
import { useT } from "@/i18n/client";
import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";
import type { MachineLook } from "@/lib/machine-look";

import type { FillStore } from "../_lib/data";
import type { Done } from "../_lib/done-store";
import {
  cardChip,
  fillAction,
  fillPacks,
  glyphSlotsOf,
  glyphStatusFor,
  titlar,
} from "../_lib/list";
import type { FillMachine } from "../_lib/model";
import type { MachineLink } from "../_lib/tiles";

/* -------------------------------------------------------------------------- */
/* Små ikoner (samma linjestil som V2:s ikoner)                               */
/* -------------------------------------------------------------------------- */

function Ico({ d, size = 16, w = 1.8 }: { d: ReactNode; size?: number; w?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={w}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {d}
    </svg>
  );
}
const NAV = <path d="m3 11 19-9-9 19-2-8-8-2z" />;
const BAG = (
  <>
    <path d="M6 7h12l-1 13H7L6 7Z" />
    <path d="M9 7a3 3 0 0 1 6 0" />
  </>
);
const DOWN = <path d="m6 9 6 6 6-6" />;
const CHECK = <path d="M20 6 9 17l-5-5" />;
const PEN = <path d="M4 20h4L19 9l-4-4L4 16v4Z" />;
const X = <path d="M6 6l12 12M18 6 6 18" />;

/** Butikens namn och stad ("Bio Fyren · Enköping"). */
export function placeLine(m: Pick<FillMachine, "place">, store: FillStore | null): string {
  return [store?.name ?? m.place, store?.city].filter(Boolean).join(" · ");
}

function mapsOf(store: FillStore | null): string | null {
  return store
    ? mapsSearchUrl({ address: store.address, city: store.city, lat: store.lat, lng: store.lng })
    : null;
}

/** Ett kort i listan är en länk: vanligt tryck öppnar automaten i appen. */
function open(onOpen: () => void) {
  return (e: React.MouseEvent<HTMLAnchorElement>) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey) return;
    e.preventDefault();
    onOpen();
  };
}

/* -------------------------------------------------------------------------- */
/* Automat som behöver påfyllning: stort kort                                 */
/* -------------------------------------------------------------------------- */

/**
 * Stort kort (val 3): bilden av automaten (96 px, skärmen = facken, tomma i rött), märket
 * ("1 slut"), namnet och butiken, packen att fylla (64 px, "+N", röd ram när slut) och "Fyll 3
 * titlar · 43 pack". Hela kortet öppnar automaten; "Kör dit" (dator) står bredvid.
 */
export function NeedCard({
  m,
  store,
  link,
  look,
  href,
  ariaLabel,
  next,
  onOpen,
}: {
  m: FillMachine;
  store: FillStore | null;
  link: MachineLink | null;
  look: MachineLook | null;
  href: string;
  ariaLabel: string;
  /** Först i tur (mörk ram och "Nästa"). */
  next: boolean;
  onOpen: () => void;
}) {
  const chip = cardChip(m, link);
  const packs = fillPacks(m);
  const act = fillAction(packs);
  const maps = mapsOf(store);
  const shown = packs.slice(0, 5);
  const more = packs.length - shown.length;
  return (
    <div className={cn("fl-need", next && "next", maps && "has-maps")}>
      <a href={href} onClick={open(onOpen)} aria-label={ariaLabel} className="fl-link">
        <span className="fl-top">
          <MachineGlyph
            look={look}
            size="m"
            status={glyphStatusFor(m, link)}
            slots={glyphSlotsOf(m)}
            decorative
            className="fl-glyph"
          />
          <span className="fl-info">
            {next || chip ? (
              <span className="fl-chips">
                {next ? (
                  <span className="v2-badge fl-next">
                    <Ico d={NAV} size={12} w={2.2} />
                    Nästa
                  </span>
                ) : null}
                {chip ? (
                  <Badge tone={chip.tone} dot={chip.tone !== "warning"}>
                    {chip.text}
                  </Badge>
                ) : null}
              </span>
            ) : null}
            <b className="fl-name">{m.name || m.code}</b>
            <span className="fl-store">{placeLine(m, store)}</span>
            <span className="fl-meta">{m.code}</span>
          </span>
        </span>
        {packs.length > 0 ? (
          <span className="fl-packs">
            {shown.map((p) => (
              <span key={p.titleId} className={cn("fl-nd", p.empty && "empty")}>
                <PackImage title={p.name} size="m" />
                <b className="plus">{p.want > 0 ? `+${formatInt(p.want)}` : "slut"}</b>
              </span>
            ))}
            {more > 0 ? <span className="fl-more">+{titlar(more)}</span> : null}
          </span>
        ) : null}
        <span className="fl-act">
          <span className="v2-btn act lg fl-fill">
            {act.label}
            {act.packs ? <span className="dim">{`· ${act.packs}`}</span> : null}
          </span>
        </span>
      </a>
      {maps ? (
        <a
          href={maps}
          target="_blank"
          rel="noopener noreferrer"
          className="v2-btn lg fl-drive"
          aria-label={`Kör dit: ${placeLine(m, store)}`}
        >
          <Ico d={NAV} />
          Kör dit
        </a>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Okänd nivå                                                                 */
/* -------------------------------------------------------------------------- */

/** Ingen Awish-läsning: skärmen blek med "?", titlarna som blekta packbilder med "?". */
export function UnknownCard({
  m,
  store,
  link,
  look,
  href,
  ariaLabel,
  onOpen,
}: {
  m: FillMachine;
  store: FillStore | null;
  link: MachineLink | null;
  look: MachineLook | null;
  href: string;
  ariaLabel: string;
  onOpen: () => void;
}) {
  const slots = glyphSlotsOf(m);
  return (
    <a href={href} onClick={open(onOpen)} aria-label={ariaLabel} className="fl-unk">
      <MachineGlyph
        look={look}
        size="m"
        status={link === "offline" ? "offline" : "ok"}
        slots={slots}
        decorative
      />
      <span className="fl-unk-b">
        <span className="fl-unk-hd">
          <b>{m.name || m.code}</b>
          <span>{placeLine(m, store)}</span>
        </span>
        {slots.length > 0 ? (
          <span className="fl-unk-row">
            {slots.slice(0, 12).map((s, i) => (
              <span key={`${s.title}-${i}`} className="sl">
                <PackImage title={s.title} size="xs" />
                <i>?</i>
              </span>
            ))}
          </span>
        ) : (
          <span className="fl-unk-none">Hur full den är syns efter nästa läsning</span>
        )}
      </span>
      <span className="v2-btn fl-count">Räkna</span>
    </a>
  );
}

/* -------------------------------------------------------------------------- */
/* Allt fullt: en hopfälld rad                                                */
/* -------------------------------------------------------------------------- */

export function FullFold({
  machines,
  looks,
  links,
  stores,
  open: isOpen,
  onToggle,
  hrefOf,
  ariaOf,
  onOpen,
}: {
  machines: readonly FillMachine[];
  looks: Readonly<Record<string, MachineLook>>;
  links: Readonly<Record<string, MachineLink>>;
  stores: Readonly<Record<string, FillStore>>;
  open: boolean;
  onToggle: () => void;
  hrefOf: (id: string) => string;
  ariaOf: (m: FillMachine) => string;
  onOpen: (id: string) => void;
}) {
  const n = machines.length;
  const stack = machines.slice(0, 6);
  return (
    <div className={cn("fl-full", isOpen && "open")}>
      <button type="button" className="fl-full-hd" aria-expanded={isOpen} onClick={onToggle}>
        <span className="fl-stack" aria-hidden="true">
          {stack.map((m) => (
            <MachineGlyph
              key={m.id}
              look={looks[m.id] ?? null}
              size="s"
              status={links[m.id] === "offline" ? "offline" : "ok"}
              decorative
            />
          ))}
        </span>
        <span className="fl-full-t">
          <b>Allt fullt</b>
          <span>
            {formatInt(n)}
            {NBSP}
            {n === 1 ? "automat" : "automater"}
          </span>
        </span>
        <span className="fl-chev" aria-hidden="true">
          <Ico d={DOWN} size={18} />
        </span>
      </button>
      {isOpen ? (
        <ul className="fl-full-list">
          {machines.map((m) => (
            <li key={m.id}>
              <a href={hrefOf(m.id)} onClick={open(() => onOpen(m.id))} aria-label={ariaOf(m)}>
                <MachineGlyph
                  look={looks[m.id] ?? null}
                  size="s"
                  status={glyphStatusFor(m, links[m.id] ?? null)}
                  decorative
                />
                <span className="t">
                  <b>{m.name || m.code}</b>
                  <small>{placeLine(m, stores[m.id] ?? null)}</small>
                </span>
                <span className="p">
                  {m.fillPct !== null ? `${formatInt(m.fillPct)}${NBSP}%` : "–"}
                </span>
              </a>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Ta med                                                                     */
/* -------------------------------------------------------------------------- */

/** Ta med: packen för automaterna som behöver påfyllning (×N). Ett tryck öppnar Ta med-listan. */
export function BringCard({
  items,
  total,
  onOpen,
}: {
  items: readonly { titleId: string; name: string; want: number }[];
  total: number;
  onOpen: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className="fl-bring"
      onClick={onOpen}
      aria-label={`${t.fill.bringOpen}: ${formatInt(total)} pack`}
    >
      <span className="br-hd">
        <span className="br-t">
          <Ico d={BAG} />
          Ta med
        </span>
        <span className="br-n">{`${formatInt(total)}${NBSP}pack`}</span>
      </span>
      {items.length > 0 ? (
        <span className="br-row" aria-hidden="true">
          {items.map((i) => (
            <span key={i.titleId} className="br-i">
              <PackImage title={i.name} size="m" />
              <b>{formatInt(i.want)}</b>
            </span>
          ))}
        </span>
      ) : null}
    </button>
  );
}

/* -------------------------------------------------------------------------- */
/* Kvittot efter Klar                                                         */
/* -------------------------------------------------------------------------- */

/** Bocken som ritar sig själv (ingen rörelse med prefers-reduced-motion, se CSS). */
function DrawnCheck({ size }: { size: number }) {
  return (
    <svg className="fl-chk" width={size} height={size} viewBox="0 0 52 52" aria-hidden="true">
      <circle className="c" cx="26" cy="26" r="24" />
      <path className="p" d="M15 27l7.5 7.5L37.5 19" />
    </svg>
  );
}

export interface NextStop {
  readonly machine: FillMachine;
  readonly store: FillStore | null;
  readonly look: MachineLook | null;
  readonly link: MachineLink | null;
}

/**
 * Kvittot: bocken, "Automat 01 påfylld", butiken, packen med "+N", "22 pack · 6 min · 4 titlar",
 * lagret kvar (eller "sparas när nätet är tillbaka"), omstarten och "Stämmer inte? Ångra".
 * role="status" med "Klart! 22 pack påfyllda" för skärmläsaren.
 */
function ReceiptBody({
  done,
  title,
  onUndo,
}: {
  done: Done;
  /** Rubriken (i arket: Drawer.Title). */
  title: (text: string) => ReactNode;
  onUndo: () => Promise<void>;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const r = done.receipt;
  const items = r?.items ?? [];
  return (
    <div className="fl-rc" role="status" aria-live="polite">
      <span className="sr-only">{t.fill.doneTitle(done.packs)}</span>
      <DrawnCheck size={56} />
      {title(r ? `${r.name} påfylld` : t.fill.doneTitle(done.packs))}
      {r?.place ? <p className="rc-s">{r.place}</p> : null}
      {items.length > 0 ? (
        <ul className="rc-packs" aria-label="Påfyllt">
          {items.slice(0, 6).map((i, n) => (
            <li
              key={i.titleId}
              className="rp"
              style={{ "--i": n } as React.CSSProperties}
              aria-label={`${i.name} +${formatInt(i.qty)}`}
            >
              <PackImage title={i.name} size="m" />
              <b aria-hidden="true">+{formatInt(i.qty)}</b>
            </li>
          ))}
        </ul>
      ) : null}
      <p className="rc-stat">
        <span>
          <b>{formatInt(done.packs)}</b> pack
        </span>
        {r?.minutes != null ? (
          <>
            <i aria-hidden="true" />
            <span>
              <b>{formatInt(r.minutes)}</b> min
            </span>
          </>
        ) : null}
        {items.length > 0 ? (
          <>
            <i aria-hidden="true" />
            <span>
              <b>{formatInt(items.length)}</b> {items.length === 1 ? "titel" : "titlar"}
            </span>
          </>
        ) : null}
      </p>
      {done.offline || done.left ? (
        <p className="rc-left">{done.offline ? t.fill.doneOffline : done.left}</p>
      ) : null}
      {done.restart ? (
        // Butiken stänger av strömmen på natten: skärmen läser antalen när den startar.
        <p className="rc-restart" data-restart-reminder>
          {t.fill.restartScreen}
        </p>
      ) : null}
      <p className="rc-fix">
        <span>Stämmer inte?</span>
        <Button
          variant="quiet"
          size="sm"
          touch
          pending={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await onUndo();
            } finally {
              setBusy(false);
            }
          }}
        >
          <Ico d={PEN} size={14} />
          {busy ? t.common.undoing : t.common.undo}
        </Button>
      </p>
    </div>
  );
}

/** Nästa stopp: bilden, namnet och butiken, packen att fylla och "Kör dit" (eller Öppna). */
function NextBlock({
  next,
  onRoute,
  onOpenNext,
}: {
  next: NextStop;
  /** Ruttens nästa stopp: stort "Kör dit". Annars: öppna nästa automat. */
  onRoute: boolean;
  onOpenNext: () => void;
}) {
  const m = next.machine;
  const packs = fillPacks(m);
  const maps = mapsOf(next.store);
  return (
    <div className="fl-ns">
      <p className="ns-l">{onRoute ? "Nästa stopp" : "Nästa"}</p>
      <div className="ns-c">
        <MachineGlyph
          look={next.look}
          size="m"
          status={glyphStatusFor(m, next.link)}
          slots={glyphSlotsOf(m)}
          decorative
        />
        <span className="ns-i">
          <b>
            {m.name || m.code} · {next.store?.name ?? m.place}
          </b>
          {next.store?.city ? <span className="mute">{next.store.city}</span> : null}
          {packs.length > 0 ? (
            <span className="ns-p">
              {packs.slice(0, 4).map((p) => (
                <PackImage key={p.titleId} title={p.name} size="xs" />
              ))}
              <span className="mute">{titlar(packs.length)}</span>
            </span>
          ) : null}
        </span>
      </div>
      {onRoute && maps ? (
        <a href={maps} target="_blank" rel="noopener noreferrer" className="v2-btn act lg fl-go">
          <Ico d={NAV} size={18} w={2} />
          Kör dit
        </a>
      ) : (
        <Button
          size="lg"
          variant={onRoute ? "act" : "default"}
          className="fl-go"
          onClick={onOpenNext}
        >
          {`Öppna ${m.name || m.code}`}
        </Button>
      )}
    </div>
  );
}

/**
 * Kvittot som ark efter Klar (telefonen, och på datorn när en automat är öppen): ritas en gång
 * direkt efter Klar och stängs med Stäng, "Klar för i dag" (rutten) eller genom att dra ner.
 */
export function ReceiptSheet({
  done,
  open: isOpen,
  next,
  onClose,
  onUndo,
  onOpenNext,
  onEndDay,
}: {
  done: Done;
  open: boolean;
  next: NextStop | null;
  onClose: () => void;
  onUndo: () => Promise<void>;
  onOpenNext: () => void;
  /** Rutten: "Klar för i dag" (tillbaka till Rutt). */
  onEndDay?: () => void;
}) {
  const phone = usePhone();
  const onRoute = done.receipt?.onRoute ?? false;
  return (
    <Drawer.Root
      open={isOpen}
      onOpenChange={(o) => (!o ? onClose() : undefined)}
      direction={phone ? "bottom" : "right"}
    >
      <Drawer.Portal>
        <Drawer.Overlay className="v2-scrim" />
        <Drawer.Content className="v2-sheet fl-rsheet" aria-describedby={undefined}>
          {phone ? <span className="grab" aria-hidden="true" /> : null}
          <div className="fl-rsheet-b">
            <ReceiptBody
              done={done}
              onUndo={onUndo}
              title={(text) => (
                <Drawer.Title asChild>
                  <h2>{text}</h2>
                </Drawer.Title>
              )}
            />
            {next ? (
              <NextBlock
                next={next}
                onRoute={onRoute}
                onOpenNext={() => {
                  onClose();
                  onOpenNext();
                }}
              />
            ) : null}
            {onRoute && onEndDay ? (
              <Button variant="quiet" size="lg" className="fl-end" onClick={onEndDay}>
                Klar för i dag
              </Button>
            ) : (
              <Button
                variant={next ? "quiet" : "act"}
                size="lg"
                className="fl-end"
                onClick={onClose}
              >
                Stäng
              </Button>
            )}
          </div>
        </Drawer.Content>
      </Drawer.Portal>
    </Drawer.Root>
  );
}

/** Kvittot som kort i högerspalten (datorn, listan), med Stäng. */
export function ReceiptCard({
  done,
  onClose,
  onUndo,
}: {
  done: Done;
  onClose: () => void;
  onUndo: () => Promise<void>;
}) {
  const t = useT();
  return (
    <section className="fl-rcard">
      <button type="button" className="fl-x" onClick={onClose} aria-label={t.common.close}>
        <Ico d={X} size={16} />
      </button>
      <ReceiptBody done={done} onUndo={onUndo} title={(text) => <h2>{text}</h2>} />
    </section>
  );
}

/**
 * Den gjorda påfyllningen som rad i listan: "Automat 01 · Bio Fyren", "Klar 09:42", packen med
 * "+N" och "+22 pack". På telefonen bär raden bekräftelsen (role="status", Ångra, Stäng); på
 * datorn gör kortet i högerspalten det och raden är bara en rad.
 */
export function DoneRow({
  done,
  clock,
  status,
  onUndo,
  onClose,
}: {
  done: Done;
  /** "09:42". */
  clock: string | null;
  /** Raden bär bekräftelsen (telefonen). */
  status: boolean;
  onUndo: () => Promise<void>;
  onClose: () => void;
}) {
  const t = useT();
  const [busy, setBusy] = useState(false);
  const r = done.receipt;
  const items = r?.items ?? [];
  // Telefonen: bara namnet (raden är smal); datorn: namnet och butiken.
  const head = r
    ? status
      ? r.name
      : [r.name, r.place.split(" · ")[0]].filter(Boolean).join(" · ")
    : null;
  return (
    <div
      className={cn("fl-done", status && "st")}
      role={status ? "status" : undefined}
      aria-live={status ? "polite" : undefined}
    >
      <span className="dn-c" aria-hidden="true">
        <Ico d={CHECK} size={16} w={2.6} />
      </span>
      <span className="dn-t">
        {status ? <span className="sr-only">{t.fill.doneTitle(done.packs)}</span> : null}
        <b>{head ?? `${formatInt(done.packs)}${NBSP}pack påfyllda`}</b>
        <span className="mute">
          {[
            clock ? `Klar ${clock}` : null,
            status ? `+${formatInt(done.packs)}${NBSP}pack` : null,
            status && done.offline ? t.fill.doneOffline : null,
          ]
            .filter(Boolean)
            .join(" · ")}
        </span>
        {status && done.restart ? (
          <span className="dn-restart" data-restart-reminder>
            {t.fill.restartScreen}
          </span>
        ) : null}
      </span>
      {!status && items.length > 0 ? (
        <span className="dn-p" aria-hidden="true">
          {items.slice(0, 4).map((i) => (
            <span key={i.titleId} className="dp">
              <PackImage title={i.name} size="xs" />
              <b>+{formatInt(i.qty)}</b>
            </span>
          ))}
        </span>
      ) : null}
      {!status ? <span className="dn-n">{`+${formatInt(done.packs)}${NBSP}pack`}</span> : null}
      {status ? (
        <span className="dn-a">
          <Button
            size="sm"
            touch
            pending={busy}
            onClick={async () => {
              setBusy(true);
              try {
                await onUndo();
              } finally {
                setBusy(false);
              }
            }}
          >
            {busy ? t.common.undoing : t.common.undo}
          </Button>
          <button type="button" className="fl-x" onClick={onClose} aria-label={t.common.close}>
            <Ico d={X} size={16} />
          </button>
        </span>
      ) : null}
    </div>
  );
}
