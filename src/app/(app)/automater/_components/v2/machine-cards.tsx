"use client";

import "./machine-cards.css";

import { useCallback, useEffect, useRef, useState } from "react";

import { Badge } from "@/components/v2/badge";
import { ButtonLink } from "@/components/v2/button";
import { MachineGlyph } from "@/components/v2/machine-glyph";
import { PackImage } from "@/components/v2/pack-image";
import { FleetStatusBadge } from "@/components/v2/status-dot";
import { cn } from "@/lib/cn";
import { formatInt } from "@/lib/format";

import { cardSummary, type CardLine, type MachineCard } from "../../_lib/machine-cards";

const MAX_LINES = 3;

/**
 * Lager i automaterna (mockupen visuellt/01): ett kort per automat med automatens bild (packen
 * och fyllnaden på skärmen) och det som ska fyllas på. Korten kommer i ordningen "behöver mest
 * först". Dator: ett rutnät. Telefon: ett kort i taget som man sveper mellan (scroll-snap,
 * nästa kort skymtar), prickar under och alla automater som små bilder att hoppa till.
 * En rad öppnar registreringen (onLine) för den som får registrera.
 */
export function MachineCards({
  cards,
  canRegister,
  onLine,
  from = "lager",
}: {
  cards: readonly MachineCard[];
  canRegister: boolean;
  onLine?: (machineId: string, titleId: string) => void;
  /** ?fran= på länken till Fyll på. */
  from?: string;
}) {
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);

  // Vilket kort syns (telefon): det vars mitt ligger närmast spårets mitt.
  useEffect(() => {
    const el = track.current;
    if (!el) return;
    let frame = 0;
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const items = Array.from(el.children) as HTMLElement[];
        const mid = el.scrollLeft + el.clientWidth / 2;
        let best = 0;
        let dist = Infinity;
        items.forEach((c, i) => {
          const d = Math.abs(c.offsetLeft + c.offsetWidth / 2 - mid);
          if (d < dist) {
            dist = d;
            best = i;
          }
        });
        setIndex(best);
      });
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(frame);
      el.removeEventListener("scroll", onScroll);
    };
  }, []);

  const goTo = useCallback((i: number) => {
    const el = track.current;
    const card = el?.children[i] as HTMLElement | undefined;
    if (!el || !card) return;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    el.scrollTo({
      left: card.offsetLeft - (el.clientWidth - card.offsetWidth) / 2,
      behavior: reduce ? "auto" : "smooth",
    });
    setIndex(i);
  }, []);

  if (cards.length === 0) return null;

  return (
    <div className="mcards">
      <div
        ref={track}
        className="mc-track"
        role="list"
        aria-label="Automaterna, den som behöver mest först"
      >
        {cards.map((c, i) => (
          <Card
            key={c.id}
            c={c}
            canRegister={canRegister}
            onLine={onLine}
            from={from}
            current={i === index}
          />
        ))}
      </div>

      {cards.length > 1 ? (
        <div className="mc-nav">
          <div className="mc-dots" aria-hidden="true">
            {cards.map((c, i) => (
              <span
                key={c.id}
                className={cn(
                  "d",
                  i === index && "on",
                  c.glyph === "offline" || c.glyph === "empty"
                    ? "crit"
                    : c.dueToday || c.glyph === "refill"
                      ? "warn"
                      : undefined,
                )}
              />
            ))}
          </div>
          {/* Ingen aria-live: texten skulle läsas upp för varje kort man sveper förbi. */}
          <p className="mc-hint">
            Svep för nästa automat · {formatInt(index + 1)} av {formatInt(cards.length)}
          </p>
          <section className="mc-all" aria-label="Alla automater">
            <div className="mc-all-h">
              <b>Alla automater</b>
              <span>Behöver mest först</span>
            </div>
            <div className="mc-all-g">
              {cards.map((c, i) => (
                <button
                  key={c.id}
                  type="button"
                  className="mc-jump"
                  aria-current={i === index ? "true" : undefined}
                  aria-label={`${c.name}, ${cardSummary(c)}`}
                  onClick={() => goTo(i)}
                >
                  <MachineGlyph
                    look={c.look}
                    size="m"
                    status={c.glyph}
                    slots={c.slots}
                    decorative
                  />
                  <span>{c.code}</span>
                </button>
              ))}
            </div>
          </section>
        </div>
      ) : null}
    </div>
  );
}

function Card({
  c,
  canRegister,
  onLine,
  from,
  current,
}: {
  c: MachineCard;
  canRegister: boolean;
  onLine?: (machineId: string, titleId: string) => void;
  from: string;
  current: boolean;
}) {
  const shown = c.lines.slice(0, MAX_LINES);
  const rest = c.lines.length - shown.length;
  const needed = c.lines.filter((l) => l.kind !== "info").length;
  const calm = needed === 0;
  return (
    <article
      role="listitem"
      className={cn("mc", c.dueToday && "due")}
      aria-labelledby={`mc-${c.id}`}
      data-current={current ? "true" : undefined}
    >
      <header className="mc-h">
        <span className="mc-who">
          <b id={`mc-${c.id}`}>{c.name}</b>
          <small>{[c.storeName ?? "Ingen butik", c.city].filter(Boolean).join(" · ")}</small>
        </span>
        {needed > 0 && c.status !== "offline" ? (
          <Badge tone="warning" dot>
            Fyll på {formatInt(needed)}
          </Badge>
        ) : c.status ? (
          <FleetStatusBadge status={c.status} daysLeft={c.daysLeft} />
        ) : null}
      </header>

      <div className="mc-fig">
        <MachineGlyph look={c.look} size="l" status={c.glyph} slots={c.slots} name={c.code} />
      </div>

      {calm ? (
        <p className="mc-calm">
          {c.status === "offline" ? "Ingen kontakt. Inget att fylla på just nu." : cardSummary(c)}
        </p>
      ) : null}
      {shown.length > 0 ? (
        <ul className={cn("mc-lines", calm && "info")}>
          {shown.map((l) => (
            <li key={l.titleId}>
              <Line
                l={l}
                onClick={canRegister && onLine ? () => onLine(c.id, l.titleId) : undefined}
              />
            </li>
          ))}
          {rest > 0 ? (
            <li className="mc-rest">
              + {formatInt(rest)} {rest === 1 ? "titel" : "titlar"} till
            </li>
          ) : null}
        </ul>
      ) : null}
      {c.missing > 0 ? (
        <p className="mc-missing">
          {formatInt(c.missing)} {c.missing === 1 ? "titel saknas" : "titlar saknas"} i vårt lager.
        </p>
      ) : null}

      {canRegister && (c.take > 0 || (needed > 0 && c.status !== "offline")) ? (
        <div className="mc-go">
          <ButtonLink
            href={`/fyll-pa/${c.id}?fran=${encodeURIComponent(from)}`}
            variant={c.dueToday ? "act" : "default"}
            size="lg"
            touch
            className="w-full"
          >
            Fyll på {c.name}
          </ButtonLink>
        </div>
      ) : null}
    </article>
  );
}

function Line({ l, onClick }: { l: CardLine; onClick?: () => void }) {
  const f = l.target > 0 ? Math.max(0, Math.min(1, l.onHand / l.target)) : 0;
  const body = (
    <>
      <PackImage title={l.name} size="s" />
      <span className="t">
        <b>{l.name}</b>
        <small>
          <span className={cn(l.onHand <= 0 ? "crit" : f <= 0.25 ? "warn" : undefined)}>
            {l.onHand <= 0 ? "Slut" : `${formatInt(l.onHand)}${l.kind === "info" ? "" : " kvar"}`}
          </span>
          {l.kind === "take"
            ? ` · ta med ${formatInt(l.take)}`
            : l.kind === "room"
              ? ` · plats för ${formatInt(l.take)}`
              : ` av ${formatInt(l.target)}`}
        </small>
        <span className="v2-track mc-bar" aria-hidden="true">
          <i
            className={l.onHand <= 0 || f <= 0.25 ? "critical" : f <= 0.5 ? "warning" : undefined}
            style={{ transform: `scaleX(${f})` }}
          />
        </span>
      </span>
    </>
  );
  return onClick ? (
    <button type="button" className="mc-line" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="mc-line">{body}</div>
  );
}
