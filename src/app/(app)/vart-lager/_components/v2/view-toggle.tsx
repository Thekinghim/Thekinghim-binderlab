"use client";

import "./view-toggle.css";

import { cn } from "@/lib/cn";

import type { ShelfView } from "../../_lib/shelf";

/*
 * Hylla eller Tabell (Vårt lager och Inköpspriser). Valet sparas i en kaka per sida, så att
 * sidan öppnas i samma vy nästa gång (servern läser kakan). Utan kaka: Hylla.
 */

function remember(cookie: string, view: ShelfView) {
  try {
    document.cookie = `${cookie}=${view}; path=/; max-age=31536000; samesite=lax`;
  } catch {
    // Kakor avstängda: valet gäller bara den här gången.
  }
}

const SHELF_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <rect x="4" y="4" width="6" height="16" rx="1" />
    <rect x="14" y="4" width="6" height="16" rx="1" />
  </svg>
);
const TABLE_ICON = (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d="M4 6h16M4 12h16M4 18h16" />
  </svg>
);

export function ViewToggle({
  value,
  onChange,
  cookie,
  className,
}: {
  value: ShelfView;
  onChange: (v: ShelfView) => void;
  cookie: string;
  className?: string;
}) {
  const pick = (v: ShelfView) => {
    if (v === value) return;
    remember(cookie, v);
    onChange(v);
  };
  return (
    <div role="group" aria-label="Visa som" className={cn("vl-vt", className)}>
      <button type="button" aria-pressed={value === "hylla"} onClick={() => pick("hylla")}>
        {SHELF_ICON}
        Hylla
      </button>
      <button type="button" aria-pressed={value === "tabell"} onClick={() => pick("tabell")}>
        {TABLE_ICON}
        Tabell
      </button>
    </div>
  );
}
