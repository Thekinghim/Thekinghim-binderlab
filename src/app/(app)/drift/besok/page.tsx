import type { Metadata } from "next";
import Link from "next/link";

import { personOptions } from "@/analytics/team";
import { weekdayDay } from "@/analytics/todos/text";
import { kmText } from "@/analytics/visits";
import { ChannelTags } from "@/components/ui/channel-tags";
import { Panel, PanelSection } from "@/components/ui/frame";
import { Icon } from "@/components/ui/icon";
import { MineToggle } from "@/components/ui/mine-toggle";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";
import { requireRoute } from "@/server/data/core";

import { PersonPicker } from "../../_team/person-picker";
import { plural, sentenceEnd } from "../_lib/display";
import { loadVisitPlan } from "../_lib/load";
import { dayRouteView } from "../_lib/route";

/** Länk som ser ut som en knapp. */
const linkButton =
  "inline-flex h-9 items-center justify-center gap-2 rounded-sm border px-3.5 text-base font-medium whitespace-nowrap transition-[background-color,border-color,color] duration-fast ease-instrument";
const linkPrimary =
  "border-inverse bg-inverse text-on-inverse hover:border-inverse-hover hover:bg-inverse-hover";
const linkSecondary =
  "border-line-strong bg-surface text-fg hover:border-line-control hover:bg-hover";

export const metadata: Metadata = { title: "Besöksplan" };

/**
 * Besöksplanen för veckan (@/analytics/visits): vilka automater som behöver besök, när,
 * vad som ska med och i vilken ordning. Lagret och försäljningstakten de senaste 14 dagarna
 * avgör; misstänkt fel och ur drift ger ett besök i dag.
 */
export default async function VisitPlanPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireRoute("drift");
  const sp = await searchParams;
  const mine = sp.mina === "1";
  const { plan, data, hasWarehouse, team, responsibles, places } = await loadVisitPlan(ctx, {
    mine,
  });
  const machineCode = new Map(data.machines.map((m) => [m.id, m.code]));
  const me = ctx.user.id;
  const calendarHref = (date?: string) => {
    const q = new URLSearchParams();
    if (date) q.set("dag", date);
    if (mine) q.set("mina", "1");
    const s = q.toString();
    return `/drift/besok/kalender${s ? `?${s}` : ""}`;
  };
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

      <div
        className="rise flex flex-wrap items-center gap-3"
        style={{ "--i": 1 } as React.CSSProperties}
      >
        <MineToggle
          mine={mine}
          hrefMine="/drift/besok?mina=1"
          hrefAll="/drift/besok"
          label="Vems besök"
        />
        {stops > 0 ? (
          <a href={calendarHref()} className={cn(linkButton, linkSecondary, "h-8 text-sm")}>
            <Icon name="calendar" className="shrink-0" />
            Veckan i kalender
          </a>
        ) : null}
      </div>

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
              {(() => {
                const route = dayRouteView(day, data.machines, places);
                return (
                  <div className="flex flex-col gap-3">
                    <div className="flex flex-wrap gap-2">
                      {route.mapsUrls.map((url, n) => (
                        <a
                          key={url}
                          href={url}
                          target="_blank"
                          rel="noopener noreferrer"
                          className={cn(linkButton, n === 0 ? linkPrimary : linkSecondary)}
                        >
                          <Icon name="external" className="shrink-0" />
                          {route.mapsUrls.length > 1
                            ? `Google Maps ${n + 1}/${route.mapsUrls.length}`
                            : "Öppna i Google Maps"}
                        </a>
                      ))}
                      <a href={calendarHref(day.date)} className={cn(linkButton, linkSecondary)}>
                        <Icon name="calendar" className="shrink-0" />
                        Lägg i kalender
                      </a>
                    </div>
                    {route.missing.length > 0 ? (
                      <p className="text-sm text-muted">
                        {`Adress saknas: `}
                        {route.missing.map((m, n) => (
                          <span key={m.storeId ?? m.name}>
                            {n > 0 ? ", " : ""}
                            {m.storeId && ctx.canEdit ? (
                              <Link
                                href={`/butiker/${m.storeId}`}
                                className="rounded-xs text-fg underline underline-offset-2"
                              >
                                {m.name}
                              </Link>
                            ) : (
                              m.name
                            )}
                          </span>
                        ))}
                        {ctx.canEdit ? ". Butiken → Ändra → Adress." : "."}
                      </p>
                    ) : route.needsLocation ? (
                      <p className="text-sm text-muted">
                        {ctx.canEdit
                          ? "Ordning efter brådska. Klistra in kartlänken på butiken för kortaste väg."
                          : "Ordning efter brådska."}
                      </p>
                    ) : null}
                  </div>
                );
              })()}
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
                          <span className="flex flex-wrap items-center gap-3">
                            <PersonPicker
                              target={{ kind: "machine", machineId: stop.machineId }}
                              value={responsibles.get(stop.machineId) ?? ""}
                              options={personOptions(
                                me,
                                team,
                                responsibles.get(stop.machineId) ?? null,
                              )}
                              editable={ctx.canEdit}
                            />
                            <span className="meta text-subtle">
                              {stop.late ? "Efter beräknat slut · " : ""}
                              {`${formatInt(stop.totalPacks)}${NBSP}pack`}
                            </span>
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
                                      {p.capacity !== null && p.channels.length > 0 ? (
                                        <ChannelTags
                                          channels={p.channels}
                                          className="mt-0.5 flex"
                                        />
                                      ) : null}
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
