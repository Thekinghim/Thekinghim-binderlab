import type { CSSProperties } from "react";

import { MobileFold } from "@/components/ui/mobile-fold";
import { cn } from "@/lib/cn";
import { ensureBrief, type BriefView } from "@/server/assistant/brief/service";
import { loadContext, requireViewer } from "@/server/data/core";

import { ArrowLink } from "./sections";

/** Raden "Fel" när inget är fel (samma text som den fasta raden). */
const NOTHING_WRONG = /^inget akut/i;

async function loadBrief(): Promise<BriefView | null> {
  try {
    const [ctx, viewer] = await Promise.all([loadContext(), requireViewer()]);
    if (!ctx.canEdit) return null;
    const r = await ensureBrief({ viewer, trigger: "visit", now: new Date(ctx.now) });
    return r.status === "ok" ? r.brief : null;
  } catch (error) {
    // Briefen ska aldrig stoppa Hem.
    console.error("[hem] Morgonbriefen kunde inte läsas:", error);
    return null;
  }
}

/**
 * Morgonbriefen överst på Hem: tre rader, "I går", "Fel" och "Gör i dag", som AI skriver
 * en gång per dag (src/server/assistant/brief). Bara för ägare och admin, och inget alls
 * när AI saknas eller något går fel. Raderna glider in i tur och ordning.
 */
export async function MorningBrief({
  todoHref,
  className,
}: {
  todoHref: string;
  className?: string;
}) {
  const brief = await loadBrief();
  if (!brief) return null;
  const problem = !NOTHING_WRONG.test(brief.lines.problem);
  const rows = [
    { label: "I går", text: brief.lines.yesterday, alert: false },
    { label: "Fel", text: brief.lines.problem, alert: problem },
    { label: "Gör i dag", text: brief.lines.today, alert: false },
  ];
  // Under md: en rad "Morgonbrief" som öppnar briefen (från md öppen som förut).
  return (
    <MobileFold
      className={cn("fade-in", className)}
      summary="Morgonbrief"
      meta={problem ? <span className="text-signal-fg">Fel</span> : null}
    >
      <section
        aria-labelledby="morgonbrief"
        className="rounded-md border border-line bg-surface px-4 py-4 md:px-5"
      >
        <div className="flex items-baseline justify-between gap-4">
          <h2 id="morgonbrief" className="label text-muted">
            Morgonbrief
          </h2>
          <ArrowLink href={todoHref}>Att göra</ArrowLink>
        </div>
        <dl className="mt-3 flex flex-col gap-2">
          {rows.map((r, i) => (
            <div
              key={r.label}
              className="rise grid grid-cols-[5.5rem_minmax(0,1fr)] items-baseline gap-x-3"
              style={{ "--i": i + 1 } as CSSProperties}
            >
              <dt className={cn("label", r.alert ? "text-signal-fg" : "text-subtle")}>{r.label}</dt>
              <dd className="text-base text-fg">{r.text}</dd>
            </div>
          ))}
        </dl>
      </section>
    </MobileFold>
  );
}
