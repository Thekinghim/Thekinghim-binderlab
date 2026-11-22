import type { Metadata } from "next";
import Link from "next/link";

import { personOptions } from "@/analytics/team";
import { weekdayDay } from "@/analytics/todos/text";
import { kmText } from "@/analytics/visits";
import { ChannelTags } from "@/components/ui/channel-tags";
import { Icon } from "@/components/ui/icon";
import { MineToggle } from "@/components/ui/mine-toggle";
import { Badge } from "@/components/v2/badge";
import { ButtonLink } from "@/components/v2/button";
import { Card, CardBody } from "@/components/v2/card";
import { Empty } from "@/components/v2/empty";
import { Notice } from "@/components/v2/notice";
import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";
import { requireRoute } from "@/server/data/core";

import { PersonPicker } from "../../_team/person-picker";
import { DriftFrame } from "../_components/drift-frame";
import { plural, sentenceEnd } from "../_lib/display";
import { loadVisitPlan } from "../_lib/load";
import { dayRouteView } from "../_lib/route";

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
    <DriftFrame
      ctx={ctx}
      sub={
        <>
          <b>{stops === 0 ? "Inga besök behövs i veckan." : sentenceEnd(plan.summary)}</b>
          {stops === 0 ? (
            <span>Lagret räcker 7 dagar.</span>
          ) : late > 0 ? (
            <span>{`${plural(late, "automat hinner", "automater hinner")} ta slut före besöket.`}</span>
          ) : null}
        </>
      }
    >
      <div className="ops-bar">
        <MineToggle
          mine={mine}
          hrefMine="/drift/besok?mina=1"
          hrefAll="/drift/besok"
          label="Vems besök"
        />
        {stops > 0 ? (
          <a href={calendarHref()} className="v2-btn touch">
            <Icon name="calendar" className="shrink-0" />
            Veckan i kalender
          </a>
        ) : null}
      </div>

      {!hasWarehouse ? (
        <Notice
          tone="info"
          title="Vårt lager har inget saldo, så packlistan räknar med att allt finns."
          action={
            <ButtonLink href="/lager" size="sm" touch>
              Öppna Lager
            </ButtonLink>
          }
        />
      ) : null}

      {plan.overflow.length > 0 ? (
        <Notice
          tone="critical"
          title={`${plural(plan.overflow.length, "automat", "automater")} fick inte plats i veckans besöksdagar: ${plan.overflow.map((id) => machineCode.get(id) ?? id).join(", ")}.`}
        />
      ) : null}

      {plan.days.length === 0 ? (
        <Card>
          <Empty title="Inga besök behövs de närmaste 7 dagarna." />
        </Card>
      ) : (
        plan.days.map((day) => {
          const route = dayRouteView(day, data.machines, places);
          return (
            <section key={day.date} aria-labelledby={`dag-${day.date}`} className="v2-section">
              <div className="v2-section-hd flex-wrap">
                <div className="min-w-0">
                  <h2 id={`dag-${day.date}`}>{sentenceEnd(day.title)}</h2>
                  <p>
                    {day.routeMethod === "distance" ? "Efter avstånd" : "Efter brådska"}
                    {day.totalMeters !== null ? ` · ${kmText(day.totalMeters)} med återresa` : ""}
                  </p>
                </div>
                <div className="acts flex-initial">
                  {route.mapsUrls.map((url, n) => (
                    <a
                      key={url}
                      href={url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className={cn("v2-btn touch", n === 0 && "act")}
                    >
                      <Icon name="external" className="shrink-0" />
                      {route.mapsUrls.length > 1
                        ? `Google Maps ${n + 1}/${route.mapsUrls.length}`
                        : "Öppna i Google Maps"}
                    </a>
                  ))}
                  <a href={calendarHref(day.date)} className="v2-btn touch">
                    <Icon name="calendar" className="shrink-0" />
                    Lägg i kalender
                  </a>
                </div>
              </div>
              {route.missing.length > 0 ? (
                <p className="ops-p mb-3">
                  {`Adress saknas: `}
                  {route.missing.map((m, n) => (
                    <span key={m.storeId ?? m.name}>
                      {n > 0 ? ", " : ""}
                      {m.storeId && ctx.canEdit ? (
                        <Link
                          href={`/butiker/${m.storeId}`}
                          className="text-v2-ink underline underline-offset-2"
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
                <p className="ops-p mb-3">
                  {ctx.canEdit
                    ? "Lägg in butikens kartlänk för kortaste väg."
                    : "Ordning efter brådska."}
                </p>
              ) : null}
              <div className="v2-cols">
                <ol className="v2-stack">
                  {day.stops.map((stop) => (
                    <li key={stop.machineId}>
                      <Card
                        as="article"
                        title={
                          <>
                            <span className="tnum text-v2-mute">
                              {String(stop.sequence).padStart(2, "0")}
                            </span>
                            <Link
                              href={`/drift/automat/${stop.machineId}`}
                              className="min-w-0 truncate hover:underline"
                            >
                              {`${(machineCode.get(stop.machineId) ?? "").replace("-", "‑")} ${stop.machineName}`}
                            </Link>
                          </>
                        }
                        actions={
                          <span className="flex shrink-0 items-center gap-3">
                            {stop.late ? <Badge tone="warning">Hinner ta slut</Badge> : null}
                            <span className="tnum text-v2-xs text-v2-mute">
                              {`${formatInt(stop.totalPacks)}${NBSP}pack`}
                            </span>
                          </span>
                        }
                      >
                        <CardBody className="flex flex-col gap-3">
                          <div className="flex flex-wrap items-center gap-2">
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
                          </div>
                          {/* Telefon: packlistan först; prognosraderna ligger under Underlag. */}
                          <ul
                            className={cn(
                              "flex flex-col gap-1 text-v2-sm text-v2-mute",
                              stop.packs.length > 0 && "max-[900px]:hidden",
                            )}
                          >
                            {stop.reasons.slice(0, 3).map((r) => (
                              <li key={r}>{r}</li>
                            ))}
                            {stop.reasons.length > 3 ? (
                              <li>
                                <details className="ops-more">
                                  <summary>
                                    {`Och ${formatInt(stop.reasons.length - 3)} ${stop.reasons.length - 3 === 1 ? "titel" : "titlar"} till`}
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
                        </CardBody>
                        {stop.packs.length > 0 ? (
                          <div className="v2-table-wrap border-t border-v2-line">
                            <table className="v2-table">
                              <caption className="sr-only">{`Packlista för ${stop.machineName}`}</caption>
                              <thead>
                                <tr>
                                  <th scope="col">Packlista</th>
                                  <th scope="col" className="num">
                                    Ta med
                                  </th>
                                  <th scope="col" className="num ph-hide">
                                    Kvar vid besök
                                  </th>
                                  <th scope="col" className="num ph-hide">
                                    Mål
                                  </th>
                                </tr>
                              </thead>
                              <tbody>
                                {stop.packs.map((p) => (
                                  <tr key={p.titleId}>
                                    <td className="[overflow-wrap:anywhere]">
                                      {p.titleName}
                                      {p.capacity !== null && p.channels.length > 0 ? (
                                        <ChannelTags
                                          channels={p.channels}
                                          className="mt-0.5 flex"
                                        />
                                      ) : null}
                                      {p.shortBy > 0 ? (
                                        <span className="block text-v2-xs text-v2-crit-text">{`${formatInt(p.shortBy)} pack saknas i vårt lager`}</span>
                                      ) : null}
                                    </td>
                                    <td className="num font-[550]">{formatInt(p.quantity)}</td>
                                    <td className="num ph-hide text-v2-mute">
                                      {formatInt(p.projectedAtVisit)}
                                    </td>
                                    <td className="num ph-hide text-v2-mute">
                                      {formatInt(p.target)}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        ) : null}
                        <div className="border-t border-v2-line2 px-[18px] py-1.5 max-[900px]:px-4">
                          <details className="ops-more">
                            <summary>Underlag</summary>
                            {stop.packs.length > 0 ? (
                              <ul className="mt-1 flex flex-col gap-1 text-v2-sm text-v2-mute min-[901px]:hidden">
                                {stop.reasons.map((r) => (
                                  <li key={r}>{r}</li>
                                ))}
                              </ul>
                            ) : null}
                            <p className="ops-p mt-1 mb-2">{stop.evidence.rule}</p>
                          </details>
                        </div>
                      </Card>
                    </li>
                  ))}
                </ol>
                <aside aria-label={`Att lasta ${day.date}`}>
                  <Card
                    title="Att lasta"
                    actions={
                      <span className="tnum text-v2-xs text-v2-mute">{`${formatInt(day.totalPacks)} st`}</span>
                    }
                  >
                    <ul className="ops-list">
                      {day.load
                        .filter((l) => l.quantity > 0)
                        .map((l) => (
                          <li
                            key={l.titleId}
                            className="flex items-baseline justify-between gap-3 text-v2-sm"
                          >
                            <span className="min-w-0 text-v2-ink">{l.titleName}</span>
                            <span className="tnum font-[550] text-v2-ink">
                              {formatInt(l.quantity)}
                            </span>
                          </li>
                        ))}
                    </ul>
                  </Card>
                </aside>
              </div>
            </section>
          );
        })
      )}

      {plan.notNeeded.length > 0 ? (
        <Card
          title={`${plural(plan.notNeeded.length, "automat", "automater")} klarar sig`}
          actions={<span className="text-v2-xs text-v2-mute">Senaste besöksdag</span>}
        >
          <ul className="ops-list">
            {plan.notNeeded.map((n) => (
              <li
                key={n.machineId}
                className="flex items-baseline justify-between gap-3 text-v2-sm"
              >
                <span className="font-[550] text-v2-ink">
                  {machineCode.get(n.machineId) ?? n.machineId}
                </span>
                <span className="text-v2-mute">
                  {n.needBy ? `Senast ${weekdayDay(n.needBy)}` : "Ingen försäljning att räkna på"}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      ) : null}
    </DriftFrame>
  );
}
