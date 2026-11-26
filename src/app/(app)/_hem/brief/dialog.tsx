"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
} from "react";

import type { BriefCard } from "@/analytics/brief";

import { BriefArtwork } from "./art";
import { BRIEF_OPEN_EVENT, markSeen, seenToday, todayIn } from "./once";

import "./brief.css";

interface Payload {
  readonly day: string | null;
  readonly cards: readonly BriefCard[];
}

/** Sidor där rutan inte öppnas av sig själv (kom igång-guiden). */
const QUIET_PATHS = ["/kom-igang"];

/** Vänta så här länge på att ett annat ark eller en dialog stängs (försök × intervall). */
const RETRY_MS = 1_500;
const RETRIES = 40;

/** Ett annat ark (vaul), en dialog (Radix) eller kommandomenyn är öppen. */
function otherModalOpen(): boolean {
  return (
    document.querySelector(
      [
        "dialog[open]:not([data-brief])",
        '[role="dialog"][data-state="open"]',
        '[role="alertdialog"]',
        "[data-vaul-drawer][data-state='open']",
        '[aria-modal="true"]:not([data-brief])',
      ].join(","),
    ) !== null
  );
}

function reducedMotion(): boolean {
  try {
    return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
}

/** Efter att sidan laddats och webbläsaren har tid över (blockerar aldrig första ritningen). */
function whenIdle(run: () => void): () => void {
  let cancelled = false;
  let idle: number | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const go = () => {
    if (cancelled) return;
    const w = window as Window & {
      requestIdleCallback?: (cb: () => void, o?: { timeout: number }) => number;
    };
    if (w.requestIdleCallback)
      idle = w.requestIdleCallback(() => !cancelled && run(), { timeout: 2_500 });
    else timer = setTimeout(() => !cancelled && run(), 600);
  };
  const onLoad = () => {
    timer = setTimeout(go, 700);
  };
  if (document.readyState === "complete") onLoad();
  else window.addEventListener("load", onLoad, { once: true });
  return () => {
    cancelled = true;
    window.removeEventListener("load", onLoad);
    if (timer) clearTimeout(timer);
    const w = window as Window & { cancelIdleCallback?: (id: number) => void };
    if (idle !== null) w.cancelIdleCallback?.(idle);
  };
}

async function fetchBrief(signal?: AbortSignal): Promise<Payload | null> {
  try {
    const res = await fetch("/dagens-brief", {
      headers: { accept: "application/json" },
      cache: "no-store",
      signal,
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Payload;
    return Array.isArray(data?.cards) ? data : null;
  } catch {
    return null;
  }
}

/** Låser sidan bakom (utan att den hoppar när rullningslisten försvinner på datorn). */
function lockScroll(): () => void {
  const html = document.documentElement;
  const gap = window.innerWidth - html.clientWidth;
  const prev = { overflow: html.style.overflow, paddingRight: html.style.paddingRight };
  html.style.overflow = "hidden";
  if (gap > 0) html.style.paddingRight = `${gap}px`;
  return () => {
    html.style.overflow = prev.overflow;
    html.style.paddingRight = prev.paddingRight;
  };
}

/**
 * Dagens brief: en ruta mitt på skärmen med 1–6 kort att svepa mellan, första gången appen
 * öppnas varje dag (per användare och enhet, ./once.ts), och när som helst från knappen på
 * Hem. Monteras en gång i skalet (layouten). Underlaget hämtas efter att sidan laddats
 * (GET /dagens-brief); går något fel visas ingenting.
 */
export function DailyBrief({ userKey, timeZone }: { userKey: string; timeZone: string }) {
  const pathname = usePathname();
  const [cards, setCards] = useState<readonly BriefCard[] | null>(null);
  const [open, setOpen] = useState(false);
  const cache = useRef<{ at: number; data: Payload } | null>(null);

  const show = useCallback(
    (data: Payload) => {
      if (data.cards.length === 0) return;
      markSeen(userKey, data.day ?? todayIn(timeZone));
      setCards(data.cards);
      setOpen(true);
    },
    [userKey, timeZone],
  );

  // Av sig själv: en gång per dag, när sidan laddats och inget annat ark är öppet.
  // Appen på hemskärmen laddas sällan om: står den öppen över natten räknas nästa gång den
  // visas (visibilitychange) som att den öppnas, så rutan kommer även då.
  const quiet = QUIET_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`));
  useEffect(() => {
    if (quiet) return;
    const ac = new AbortController();
    let retry: ReturnType<typeof setTimeout> | null = null;
    let stopIdle: (() => void) | null = null;
    let running = false;
    const run = () => {
      if (running || ac.signal.aborted || seenToday(userKey, todayIn(timeZone))) return;
      running = true;
      stopIdle = whenIdle(async () => {
        const data = await fetchBrief(ac.signal);
        if (ac.signal.aborted) return;
        if (!data || data.cards.length === 0) {
          running = false;
          return;
        }
        cache.current = { at: Date.now(), data };
        let tries = 0;
        const attempt = () => {
          retry = null;
          if (ac.signal.aborted) return;
          if (seenToday(userKey, data.day ?? todayIn(timeZone))) {
            running = false;
            return;
          }
          if (document.visibilityState === "hidden" || otherModalOpen()) {
            if (++tries <= RETRIES) retry = setTimeout(attempt, RETRY_MS);
            else running = false;
            return;
          }
          running = false;
          show(data);
        };
        attempt();
      });
    };
    const onVisible = () => {
      if (document.visibilityState === "visible") run();
    };
    run();
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      ac.abort();
      stopIdle?.();
      if (retry) clearTimeout(retry);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [quiet, userKey, timeZone, show]);

  // Knappen på Hem: hämtar på nytt (eller återanvänder ett svar från senaste minuten).
  useEffect(() => {
    const onOpen = async () => {
      const hit = cache.current;
      const data = hit && Date.now() - hit.at < 60_000 ? hit.data : await fetchBrief();
      if (!data) return;
      cache.current = { at: Date.now(), data };
      show(data);
    };
    window.addEventListener(BRIEF_OPEN_EVENT, onOpen);
    return () => window.removeEventListener(BRIEF_OPEN_EVENT, onOpen);
  }, [show]);

  if (!open || !cards) return null;
  return <BriefDialog cards={cards} onClosed={() => setOpen(false)} />;
}

/** Själva rutan (native <dialog>: fokus stannar i rutan, Escape stänger). */
function BriefDialog({ cards, onClosed }: { cards: readonly BriefCard[]; onClosed: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const track = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const closing = useRef(false);
  const unlock = useRef<(() => void) | null>(null);
  const downOnBackdrop = useRef(false);

  // Senaste onClosed utan att rutan öppnas på nytt när skalet ritas om.
  const onClosedRef = useRef(onClosed);
  useEffect(() => {
    onClosedRef.current = onClosed;
  }, [onClosed]);

  const finish = useCallback(() => {
    const el = ref.current;
    if (el?.open) el.close();
    unlock.current?.();
    unlock.current = null;
    onClosedRef.current();
  }, []);

  const close = useCallback(
    (instant = false) => {
      const el = ref.current;
      if (!el || closing.current) return;
      closing.current = true;
      if (instant || reducedMotion()) {
        el.dataset.state = "closed";
        finish();
        return;
      }
      el.dataset.state = "closing";
      // Ut snabbare än in (150 ms); reserv om transitionend aldrig kommer.
      setTimeout(finish, 170);
    },
    [finish],
  );

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    try {
      el.showModal();
    } catch {
      el.setAttribute("open", "");
    }
    unlock.current = lockScroll();
    // Knappen som gör något får fokus (Enter), utan att sidan rullar.
    el.querySelector<HTMLElement>("[data-brief-primary]")?.focus({ preventScroll: true });
    // Nästa bildruta: från 0,96 och genomskinlig till på plats (brief.css).
    const raf = requestAnimationFrame(() => {
      el.dataset.state = "open";
    });
    const onCancel = (e: Event) => {
      e.preventDefault();
      close();
    };
    // Stängd av webbläsaren själv (t.ex. Escape två gånger): städa ändå.
    const onNativeClose = () => {
      if (!closing.current) {
        closing.current = true;
        finish();
      }
    };
    el.addEventListener("cancel", onCancel);
    el.addEventListener("close", onNativeClose);
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener("cancel", onCancel);
      el.removeEventListener("close", onNativeClose);
      unlock.current?.();
      unlock.current = null;
    };
  }, [close, finish]);

  const onScroll = useCallback(() => {
    const t = track.current;
    if (!t || t.clientWidth === 0) return;
    const i = Math.max(0, Math.min(cards.length - 1, Math.round(t.scrollLeft / t.clientWidth)));
    setIndex((prev) => (prev === i ? prev : i));
  }, [cards.length]);

  const goTo = useCallback((i: number, smooth: boolean) => {
    const t = track.current;
    if (!t) return;
    t.scrollTo({
      left: i * t.clientWidth,
      behavior: smooth && !reducedMotion() ? "smooth" : "auto",
    });
    setIndex(i);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLDialogElement>) => {
    if (e.key === "ArrowRight" && index < cards.length - 1) {
      e.preventDefault();
      goTo(index + 1, false);
    } else if (e.key === "ArrowLeft" && index > 0) {
      e.preventDefault();
      goTo(index - 1, false);
    }
  };

  const card = cards[index] ?? cards[0];

  return (
    // Tryck utanför kortet (på den mörka ytan) stänger.
    <dialog
      ref={ref}
      data-brief=""
      data-state="closed"
      className="v2-brief"
      aria-labelledby="dagens-brief-rubrik"
      aria-modal="true"
      onKeyDown={onKeyDown}
      onPointerDown={(e) => {
        downOnBackdrop.current = e.target === e.currentTarget;
      }}
      onClick={(e) => {
        // Bara ett tryck som både börjar och slutar på den mörka ytan (inte ett drag ut ur kortet).
        if (e.target === e.currentTarget && downOnBackdrop.current) close();
      }}
    >
      <BriefDeck
        cards={cards}
        index={index}
        trackRef={track}
        onScroll={onScroll}
        onDot={(i) => goTo(i, true)}
        footer={
          <>
            <button type="button" className="v2-btn lg plain" onClick={() => close()}>
              Stäng
            </button>
            {card?.action ? (
              <Link
                prefetch={false}
                href={card.action.href}
                className="v2-btn lg act"
                onClick={() => close(true)}
                data-brief-primary=""
              >
                {card.action.label}
              </Link>
            ) : (
              <button
                type="button"
                className="v2-btn lg act"
                onClick={() => close()}
                data-brief-primary=""
              >
                Klart
              </button>
            )}
          </>
        }
      />
    </dialog>
  );
}

/** Kortet i rutan: korten att svepa mellan, prickarna och knapparna (utan beteende). */
export function BriefDeck({
  cards,
  index,
  trackRef,
  onScroll,
  onDot,
  footer,
}: {
  cards: readonly BriefCard[];
  index: number;
  trackRef?: Ref<HTMLDivElement>;
  onScroll?: () => void;
  onDot?: (i: number) => void;
  footer?: ReactNode;
}) {
  const many = cards.length > 1;
  return (
    <div className="bf-card">
      <h2 id="dagens-brief-rubrik" className="sr-only">
        Dagens brief
      </h2>
      <div
        ref={trackRef}
        className="bf-track"
        onScroll={onScroll}
        aria-roledescription={many ? "karusell" : undefined}
      >
        {cards.map((c, i) => (
          <section
            key={c.key}
            className="bf-slide"
            data-tone={c.tone}
            aria-roledescription={many ? "kort" : undefined}
            aria-label={many ? `${i + 1} av ${cards.length}` : undefined}
            aria-hidden={many && i !== index ? true : undefined}
          >
            <div className="bf-art">
              <BriefArtwork art={c.art} />
            </div>
            <h3 className="bf-title">{c.title}</h3>
            <p className="bf-line">{c.line}</p>
          </section>
        ))}
      </div>
      {many ? (
        <div className="bf-dots">
          {cards.map((c, i) => (
            <button
              key={c.key}
              type="button"
              className="bf-dot"
              aria-label={`Kort ${i + 1} av ${cards.length}`}
              aria-current={i === index ? "true" : undefined}
              onClick={() => onDot?.(i)}
            />
          ))}
        </div>
      ) : null}
      {footer ? <div className="bf-foot">{footer}</div> : null}
    </div>
  );
}
