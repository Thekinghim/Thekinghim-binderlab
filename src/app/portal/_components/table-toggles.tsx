"use client";

import { useId, useState, type ReactNode } from "react";

/**
 * Knapparna under staplarna ("Visa tabell", "Per vecka"): en i taget öppnar sin tabell
 * under. Tabellerna renderas på servern och finns i sidan; knappen visar eller döljer dem.
 */
export function TableToggles({
  panels,
  summary,
}: {
  panels: { id: string; label: string; content: ReactNode }[];
  summary?: ReactNode;
}) {
  const uid = useId();
  const [open, setOpen] = useState<string | null>(null);
  return (
    <>
      <div className="pt-tabrow">
        {panels.map((p) => (
          <button
            key={p.id}
            type="button"
            className="v2-btn touch pt-tabbtn"
            aria-expanded={open === p.id}
            aria-controls={`${uid}-${p.id}`}
            onClick={() => setOpen((o) => (o === p.id ? null : p.id))}
          >
            <svg aria-hidden viewBox="0 0 16 16" width="14" height="14">
              <path
                d="M2.5 3.5h11v9h-11zM2.5 6.5h11M2.5 9.5h11M6.5 6.5v6"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
              />
            </svg>
            {p.label}
          </button>
        ))}
        {summary ? <span className="pt-tsum">{summary}</span> : null}
      </div>
      {panels.map((p) => (
        <div key={p.id} id={`${uid}-${p.id}`} hidden={open !== p.id} className="pt-tabpanel">
          {p.content}
        </div>
      ))}
    </>
  );
}
