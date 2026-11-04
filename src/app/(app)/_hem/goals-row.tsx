import type { CSSProperties } from "react";

import type { GoalStatus } from "@/analytics/goals";
import { StatusTag, type Status } from "@/components/ui/status-tag";
import { formatInt, formatMonth } from "@/lib/format";
import { cn } from "@/lib/cn";

import { GoalCount } from "./goal-count";
import type { HomeGoal } from "./goals";
import { ArrowLink } from "./sections";
import { dateOf, kr } from "./text";

const STATUS: Record<GoalStatus, { tag: Status; text: string }> = {
  "on-track": { tag: "ok", text: "I fas" },
  behind: { tag: "warning", text: "Efter" },
  met: { tag: "ok", text: "Nått" },
  missed: { tag: "critical", text: "Missat" },
};

/**
 * Under md visas bara första målet, som en rad utan kort; resten nås via "Alla mål".
 */
const value = (g: HomeGoal, v: number) => (g.unit === "ore" ? kr(v) : formatInt(v));

/**
 * Mål i {månad} på Hem: högst tre kort med utfall, mål, en stapel med prognosmarkering och
 * läget. Utan mål: en länk för att sätta ett (bara för den som får ändra), annars inget.
 */
export function GoalsRow({
  goals,
  today,
  canEdit,
  href,
  style,
}: {
  goals: HomeGoal[];
  today: string;
  canEdit: boolean;
  /** /expansion?vy=mal med skalets parametrar. */
  href: string;
  style?: CSSProperties;
}) {
  const month = formatMonth(dateOf(today), { year: "never" });
  if (goals.length === 0) {
    if (!canEdit) return null;
    return (
      <div className="rise" style={style}>
        <ArrowLink href={href}>{`Sätt ett mål för ${month}`}</ArrowLink>
      </div>
    );
  }
  return (
    <section aria-labelledby="mal" className="rise flex flex-col gap-3 max-md:gap-0" style={style}>
      <div className="flex items-baseline justify-between gap-4">
        <h2 id="mal" className="label text-muted">
          {`Mål i ${month}`}
        </h2>
        <ArrowLink href={href}>Alla mål</ArrowLink>
      </div>
      <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {goals.map((g, i) => (
          <GoalCard key={g.id} goal={g} index={i} />
        ))}
      </ul>
    </section>
  );
}

function GoalCard({ goal: g, index }: { goal: HomeGoal; index: number }) {
  const status = STATUS[g.status];
  const need =
    g.requiredPerDay !== null && g.metric !== "active_machines"
      ? ` · kräver ${kr(g.requiredPerDay)}/dag`
      : "";
  const done = g.status === "met" || g.status === "missed";
  return (
    <li
      className={cn(
        "lift flex min-w-0 flex-col gap-3 rounded-sm border border-line bg-surface p-4",
        // Under md: en rad utan kort, och bara det första målet (resten via "Alla mål").
        "max-md:gap-2 max-md:rounded-none max-md:border-x-0 max-md:border-t-0 max-md:bg-transparent max-md:px-0 max-md:py-3",
        index > 0 && "max-md:hidden",
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <p className="label min-w-0 truncate text-muted">
          {g.label}
          {g.scopeName ? <span className="text-subtle">{` · ${g.scopeName}`}</span> : null}
        </p>
        <StatusTag status={status.tag} className="-mt-0.5 shrink-0">
          {status.text}
        </StatusTag>
      </div>
      <p className="tnum flex flex-wrap items-baseline gap-x-1.5">
        <GoalCount
          id={g.id}
          value={g.actual}
          unit={g.unit}
          className="text-xl font-medium text-fg md:text-2xl"
        />
        <span className="meta text-subtle">{`av ${value(g, g.target)}`}</span>
      </p>
      <div
        className="relative h-1.5 w-full overflow-visible bg-hover"
        role="img"
        aria-label={`Utfall ${value(g, g.actual)} av ${value(g, g.target)}${done ? "" : `, prognos ${value(g, g.forecast)}`}`}
      >
        <span
          className={cn(
            "grow-x absolute inset-y-0 left-0",
            g.status === "missed" ? "bg-signal" : "bg-data-1",
          )}
          style={{ width: `${g.barBp / 100}%`, "--i": index } as CSSProperties}
        />
        {g.forecastBp !== null ? (
          <span
            aria-hidden
            className="fade-in absolute -inset-y-1 w-px bg-fg"
            style={{ left: `calc(${g.forecastBp / 100}% - ${g.forecastBp >= 10_000 ? 1 : 0}px)` }}
          />
        ) : null}
      </div>
      {/* Klar månad: utfallet står redan som det stora talet. */}
      {done ? null : (
        <p className="meta tnum text-subtle">{`Prognos ${value(g, g.forecast)}${need}`}</p>
      )}
    </li>
  );
}
