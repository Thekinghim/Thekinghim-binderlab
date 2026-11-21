"use client";

import { useAssistantPanel } from "@/components/assistant/assistant-panel";
import { routesForRole } from "@/components/shell/nav";

import { PeriodSegment } from "../period-segment";
import { useV2Shell } from "./shell-context";

/** "Uppdaterad 10:43" (senaste synk från Awish, i organisationens tidszon). */
export function UpdatedAt() {
  const shell = useV2Shell();
  if (!shell?.syncedAt) return null;
  const d = new Date(shell.syncedAt);
  if (Number.isNaN(d.getTime())) return null;
  const time = new Intl.DateTimeFormat("sv-SE", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: shell.timeZone,
  }).format(d);
  return (
    <span
      className="upd"
      title={shell.syncState === "failed" ? "Senaste synken misslyckades" : undefined}
    >
      Uppdaterad {time}
      {shell.syncState === "failed" ? " · synken misslyckades" : ""}
    </span>
  );
}

const ICON = {
  search: "M10.5 17.5a7 7 0 1 1 0-14 7 7 0 0 1 0 14zM20 20l-4.5-4.5",
  spark: "M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8z",
};

/** Sök (öppnar kommandomenyn), Assistenten och periodvalet, till höger i sidhuvudet. */
export function HeaderTools({ period = false }: { period?: boolean }) {
  const shell = useV2Shell();
  const assistant = useAssistantPanel();
  const hasAssistant = shell ? routesForRole(shell.role).some((r) => r.id === "assistent") : false;
  return (
    <div className="tools">
      <UpdatedAt />
      {hasAssistant && assistant ? (
        <button
          type="button"
          className="v2-btn ico quiet"
          aria-label="Fråga assistenten"
          title="Fråga assistenten"
          onClick={() => assistant.open()}
        >
          <svg
            width="17"
            height="17"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d={ICON.spark} />
          </svg>
        </button>
      ) : null}
      {shell ? (
        <button
          type="button"
          className="v2-btn ico quiet"
          aria-label="Sök"
          title="Sök · Ctrl K"
          onClick={shell.openCommand}
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
            <path d={ICON.search} />
          </svg>
        </button>
      ) : null}
      {period ? <PeriodSegment /> : null}
    </div>
  );
}
