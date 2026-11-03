import type { Metadata } from "next";
import Link from "next/link";

import { weekdayDay } from "@/analytics/todos/text";
import { kmText } from "@/analytics/visits";
import { Panel, PanelSection } from "@/components/ui/frame";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { formatInt, NBSP } from "@/lib/format";
import { requireRoute } from "@/server/data/core";

import { plural, sentenceEnd } from "../_lib/display";
import { loadVisitPlan } from "../_lib/load";

export const metadata: Metadata = { title: "Besöksplan" };

/**
 * Besöksplanen för veckan (@/analytics/visits): vilka automater som behöver besök, när,
 * vad som ska med och i vilken ordning. Lagret och försäljningstakten de senaste 14 dagarna
 * avgör; misstänkt fel och ur drift ger ett besök i dag.
 */
export default async function VisitPlanPage() {
  const ctx = await requireRoute("drift");
  const { plan, data, hasWarehouse } = await loadVisitPlan(ctx);
  const machineCode = new Map(data.machines.map((m) => [m.id, m.code]));
  const stops = plan.days.reduce((n, d) => n + d.stops.length, 0);
  const late = plan.days.flatMap((d) => d.stops).filter((s) => s.late).length;

  return (
    <div className="flex flex-col gap-10">
      <SectionHeader
        className="rise"
        as="h1"
        size="xl"
        eyebrow="Besöksplan"
        title={stops === 0 ? "Inga besök behövs i veckan." : sentenceEnd(plan.summary)}
        aside={
          stops === 0
            ? "Lagret räcker 7 dagar."
            : late > 0
              ? `${plural(late, "besök hamnar", "besök hamnar")} efter beräknat slut: ingen besöksdag fanns i tid.`
              : undefined
        }
        meta={[
          { label: "Besök", value: formatInt(stops) },
          { label: "Pack", value: formatInt(plan.totalPacks) },
          { label: "Dagar", value: formatInt(plan.days.length) },
        ]}
      />

      {!hasWarehouse ? (
        <StateMessage
          kind="not-configured"
          compact
          message="Centrallagret har inget saldo, så packlistan räknar med att allt finns."
          action={{ label: "Öppna Lager", href: "/lager" }}
        />
      ) : null}

      {plan.overflow.length > 0 ? (
        <StateMessage
          kind="error"
          compact
          message={`${plural(plan.overflow.length, "automat", "automater")} fick inte plats i veckans besöksdagar: ${plan.overflow.map((id) => machineCode.get(id) ?? id).join(", ")}.`}
        />
      ) : null}

      {plan.days.length === 0 ? (
        <StateMessage kind="empty" compact message="Inga besök behövs de närmaste 7 dagarna." />
      ) : (
        <div className="flex flex-col gap-12">
          {plan.days.map((day, i) => (
            <section
              key={day.date}
              aria-labelledby={`dag-${day.date}`}
              className="rise flex flex-col gap-6"
              style={{ "--i": i + 1 } as React.CSSProperties}
            >
              <SectionHeader
                id={`dag-${day.date}`}
                eyebrow={day.routeMethod === "distance" ? "Efter avstånd" : "Efter brådska"}
                title={sentenceEnd(day.title)}
                aside={
                  day.totalMeters !== null ? `${kmText(day.totalMeters)} med återresa.` : undefined
                }
                size="md"
              />
              <div className="grid gap-8 lg:grid-cols-12">
                <ol className="flex flex-col gap-4 lg:col-span-8">
                  {day.stops.map((stop) => (
                    <li key={stop.machineId}>
                      <Panel className="lift">
                        <div className="flex flex-wrap items-baseline justify-between gap-3">
                          <div className="flex items-baseline gap-3">
                            <span className="meta tnum text-subtle">
                              {String(stop.sequence).padStart(2, "0")}
                            </span>
                            <Link
                              href={`/drift/automat/${stop.machineId}`}
                              className="rounded-xs text-base text-fg hover:underline"
                            >
                              {`${(machineCode.get(stop.machineId) ?? "").replace("-", "‑")} ${stop.machineName}`}
                            </Link>
                          </div>
                          <span className="meta text-subtle">
                            {stop.late ? "Efter beräknat slut · " : ""}
                            {`${formatInt(stop.totalPacks)}${NBSP}pack`}
                          </span>
                        </div>
                        <ul className="mt-2 flex flex-col gap-1 text-sm text-muted">
                          {stop.reasons.slice(0, 3).map((r) => (
                            <li key={r}>{r}</li>
                          ))}
                          {stop.reasons.length > 3 ? (
                            <li>
                              <details>
                                <summary className="w-fit cursor-pointer rounded-xs hover:text-fg">
                                  {`Och ${formatInt(stop.reasons.length - 3)} titlar till`}
                                </summary>
                                <ul className="mt-1 flex flex-col gap-1">
                                  {stop.reasons.slice(3).map((r) => (
                                    <li key={r}>{r}</li>
                                  ))}
                                </ul>
                              </details>
                            </li>
                          ) : null}
                        </ul>
                        {stop.packs.length > 0 ? (
                          <PanelSection
                            label="Packlista"
                            meta={`${formatInt(stop.totalPacks)} st`}
                            className="mt-4"
                          >
                            <table className="w-full text-sm">
                              <caption className="sr-only">{`Packlista för ${stop.machineName}`}</caption>
                              <thead>
                                <tr className="label text-subtle">
                                  <th scope="col" className="py-1 text-left font-normal">
                                    Titel
                                  </th>
                                  <th scope="col" className="py-1 text-right font-normal">
                                    Ta med
                                  </th>
                                  <th
                                    scope="col"
                                    className="hidden py-1 text-right font-normal sm:table-cell"
                                  >
                                    Kvar vid besök
                                  </th>
                                  <th
                                    scope="col"
                                    className="hidden py-1 text-right font-normal sm:table-cell"
                                  >
                                    Mål
                                  </th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-line">
                                {stop.packs.map((p) => (
                                  <tr key={p.titleId}>
                                    <td className="py-2 pr-2 text-fg">
                                      {p.titleName}
                                      {p.shortBy > 0 ? (
                                        <span className="block text-xs text-muted">{`${formatInt(p.shortBy)} pack saknas i centrallagret`}</span>
                                      ) : null}
                                    </td>
                                    <td className="tnum py-2 text-right text-fg">
                                      {formatInt(p.quantity)}
                                    </td>
                                    <td className="tnum hidden py-2 text-right text-muted sm:table-cell">
                                      {formatInt(p.projectedAtVisit)}
                                    </td>
                                    <td className="tnum hidden py-2 text-right text-muted sm:table-cell">
                                      {formatInt(p.target)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </PanelSection>
                        ) : null}
                        <details className="mt-4">
                          <summary className="w-fit cursor-pointer rounded-xs text-sm text-muted hover:text-fg">
                            Underlag
                          </summary>
                          <p className="mt-2 text-sm text-muted">{stop.evidence.rule}</p>
                        </details>
                      </Panel>
                    </li>
                  ))}
                </ol>
                <aside className="lg:col-span-4" aria-label={`Att lasta ${day.date}`}>
                  <Panel>
                    <PanelSection label="Att lasta" meta={`${formatInt(day.totalPacks)} st`}>
                      <ul className="flex flex-col divide-y divide-line text-sm">
                        {day.load
                          .filter((l) => l.quantity > 0)
                          .map((l) => (
                            <li
                              key={l.titleId}
                              className="flex items-baseline justify-between gap-3 py-2"
                            >
                              <span className="text-fg">{l.titleName}</span>
                              <span className="tnum text-fg">{formatInt(l.quantity)}</span>
                            </li>
                          ))}
                      </ul>
                    </PanelSection>
                  </Panel>
                </aside>
              </div>
            </section>
          ))}
        </div>
      )}

      {plan.notNeeded.length > 0 ? (
        <section aria-labelledby="inte-besok" className="flex flex-col gap-4">
          <SectionHeader
            id="inte-besok"
            eyebrow="Inget besök i veckan"
            title={`${plural(plan.notNeeded.length, "automat", "automater")} klarar sig.`}
            aside="Senaste dag för besök vid nuvarande takt."
            size="sm"
          />
          <ul className="flex flex-col divide-y divide-line border-y border-line text-sm">
            {plan.notNeeded.map((n) => (
              <li key={n.machineId} className="flex items-baseline justify-between gap-3 py-2">
                <span className="meta text-fg">{machineCode.get(n.machineId) ?? n.machineId}</span>
                <span className="meta text-subtle">
                  {n.needBy ? `Senast ${weekdayDay(n.needBy)}` : "Ingen försäljning att räkna på"}
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </div>
  );
}
