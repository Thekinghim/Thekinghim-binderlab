"use client";

/**
 * Hjältekortets klientdelar: intro-rörelsen bara första gången, "Visa alla nyckeltal" på
 * telefon och engångsfirandet när månadens mål nås.
 */

import { useEffect, useRef, useState, type ReactNode } from "react";

import { Button } from "@/components/v2/button";
import { PackFan } from "@/components/v2/pack-visuals";
import { cn } from "@/lib/cn";

/* ------------------------------------------------------------------ */
/* Intro: bara vid första visningen                                    */
/* ------------------------------------------------------------------ */

// Modulens minne överlever klientnavigering (periodbyte, tillbaka till Hem) men inte en
// omladdning. Servern renderar alltid med rörelsen; första hydreringen stämmer därför.
let introPlayed = false;

/**
 * Kortens trappade fade-up spelas när Hem laddas. Byter man period eller kommer tillbaka
 * till Hem i samma flik står korten still (`calm`), så att siffrorna inte hoppar varje gång.
 */
export function HeroIntro({ children, className }: { children: ReactNode; className?: string }) {
  const [calm] = useState(() => introPlayed);
  useEffect(() => {
    introPlayed = true;
  }, []);
  return <div className={cn(className, calm && "calm")}>{children}</div>;
}

/* ------------------------------------------------------------------ */
/* Visa alla nyckeltal (telefon)                                       */
/* ------------------------------------------------------------------ */

/**
 * Den kompakta raden: på telefon syns de fyra första; knappen visar resten. På dator syns
 * alltid alla och knappen är dold (hem.css).
 */
export function KpiRow({
  count,
  children,
  label,
}: {
  count: number;
  children: ReactNode;
  label: string;
}) {
  const [open, setOpen] = useState(false);
  return (
    <div role="group" className={cn("v2-card hh-kpis", open && "open")} aria-label={label}>
      {children}
      {count > 4 ? (
        <button
          type="button"
          className="hh-more"
          aria-expanded={open}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Visa färre" : `Visa alla nyckeltal (${count})`}
          <svg width="12" height="12" viewBox="0 0 24 24" aria-hidden="true">
            <path
              d="M6 9l6 6 6-6"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.4"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        </button>
      ) : null}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Målet nått!                                                         */
/* ------------------------------------------------------------------ */

function readFlag(key: string): boolean {
  try {
    return window.localStorage.getItem(key) !== null;
  } catch {
    // Utan lagring (privat läge): fira inte, hellre än att fira vid varje besök.
    return true;
  }
}

function writeFlag(key: string) {
  try {
    window.localStorage.setItem(key, new Date().toISOString());
  } catch {
    /* ingen lagring: inget att spara */
  }
}

/**
 * Engångsfirandet när månadens mål är nått: en gång per person, organisation, månad och mål
 * (flaggan i webbläsarens lagring). Ett modalt fönster med packen i solfjäder, en bock och
 * "Snyggt, stäng". Med prefers-reduced-motion tonar det bara in (hem.css).
 */
export function GoalCelebration({
  storageKey,
  titles,
  heading,
  body,
}: {
  storageKey: string;
  titles: readonly string[];
  heading: string;
  body: ReactNode;
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (readFlag(storageKey)) return;
    const d = ref.current;
    if (!d || d.open) return;
    // Lite efter korten, så att ringen hinner fyllas innan fönstret kommer.
    const t = window.setTimeout(() => {
      try {
        d.showModal();
        // Fokus på själva fönstret, inte på knappen: annars ritar Chrome en fokusring direkt.
        d.focus();
      } catch {
        return;
      }
      writeFlag(storageKey);
    }, 700);
    return () => window.clearTimeout(t);
  }, [storageKey]);

  const close = () => ref.current?.close();
  return (
    <dialog
      ref={ref}
      className="hh-cele"
      tabIndex={-1}
      aria-labelledby="hh-cele-h"
      onClick={(e) => {
        // Klick utanför rutan stänger.
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="hh-cbox">
        <PackFan titles={titles} size="l" />
        <span className="hh-check" aria-hidden="true">
          <svg viewBox="0 0 24 24">
            <path d="M5 12.5l4.5 4.5L19 7.5" />
          </svg>
        </span>
        <h2 id="hh-cele-h">{heading}</h2>
        <p>{body}</p>
        <Button size="lg" variant="act" className="w-full" onClick={close}>
          Snyggt, stäng
        </Button>
      </div>
    </dialog>
  );
}
