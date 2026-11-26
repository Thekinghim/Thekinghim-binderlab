"use client";

import { BRIEF_OPEN_EVENT } from "./once";

/** "Dagens brief" i Hems sidhuvud: öppnar rutan igen (DailyBrief i skalet lyssnar). */
export function BriefButton() {
  return (
    <button
      type="button"
      className="v2-btn quiet bf-open"
      aria-label="Dagens brief"
      title="Dagens brief"
      onClick={() => window.dispatchEvent(new Event(BRIEF_OPEN_EVENT))}
    >
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.7"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden="true"
      >
        <rect x="4" y="5" width="16" height="14" rx="3" />
        <path d="M8 10h8M8 14h5" />
      </svg>
      <span className="bf-open-label">Dagens brief</span>
    </button>
  );
}
