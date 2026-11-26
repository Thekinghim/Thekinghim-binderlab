"use client";

import { approxKr } from "@/analytics/forecast/common";
import "./rutt.css";

import { useMemo, useOptimistic, useTransition } from "react";

import { Badge } from "@/components/v2/badge";
import { Button, ButtonLink } from "@/components/v2/button";
import { CallLink, MapsLink, RouteMapsLink } from "@/components/v2/call-link";
import { Card } from "@/components/v2/card";
import { Empty, emptyPacks } from "@/components/v2/empty";
import { PackImage } from "@/components/v2/pack-image";
import { FleetStatusBadge } from "@/components/v2/status-dot";
import { toastUndo, toastV2 } from "@/components/v2/toast";
import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";
import type { DayRoute, RouteStop } from "@/server/data/v2/types";

import { changeRoute, undoRouteChange } from "../actions";
import { CHECKLIST, dayKeys, useDayChecks } from "../_lib/day-checks";
import { addInFlight, visibleRoute, type InFlight } from "../_lib/pending";
import { reach } from "../_lib/reach";
import type { RouteChangeKind } from "../_lib/service";
import { durationText, emptyRouteText } from "@/server/data/v2/route-model";
import { LimitsSheet } from "./limits-sheet";

function weekdayShort(date: string): string {
  const d = new Date(`${date}T12:00:00Z`);
  const w = new Intl.DateTimeFormat("sv-SE", { weekday: "short", timeZone: "UTC" }).format(d);
  return w.charAt(0).toUpperCase() + w.slice(1).replace(".", "");
}

function placeText(s: RouteStop): string {
  const address = s.store?.address?.trim() ?? "";
  const city = s.store?.city?.trim() ?? "";
  // Adressen har ofta redan staden ("Hamngatan 8, 731 32 Köping"): skriv den inte två gånger.
  const place =
    city && address.includes(city) ? address : [address, city].filter(Boolean).join(", ");
  return [s.store?.name, place].filter(Boolean).join(" · ");
}

export function RouteView({
  route,
  scope,
  canEdit,
  canRefill,
  canEditLimits,
}: {
  route: DayRoute;
  /** "<org>:<användare>": nyckeln för bockarna i webbläsaren. */
  scope: string;
  /** Ägare, admin och påfyllare: hoppa över, till i morgon, lägg till. */
  canEdit: boolean;
  /** Får öppna Fyll på. */
  canRefill: boolean;
  /** Ägare och admin: dagens gräns. */
  canEditLimits: boolean;
}) {
  const [, startTransition] = useTransition();
  // Det man tryckt på syns direkt; servern svarar med den nya rutten (action-svaret). Går det
  // inte fram släpper React läget och stoppet står där igen, med "Ingen kontakt".
  const [inFlight, markInFlight] = useOptimistic<InFlight, Parameters<typeof addInFlight>[1]>(
    {},
    addInFlight,
  );
  const keys = dayKeys(scope, route.date);
  const [packed, togglePacked] = useDayChecks(keys.pack);
  const [checks, toggleCheck] = useDayChecks(keys.check);
  const [checkedStops, toggleChecked] = useDayChecks(keys.checked);

  const byId = useMemo(() => new Map(route.stops.map((s) => [s.machineId, s])), [route.stops]);
  const view = visibleRoute(route, inFlight, checkedStops);
  const remaining = view.remaining;
  const first = remaining[0] ?? null;
  const stopCount = view.stops.length;
  const substituteFor = useMemo(() => {
    const m = new Map<string, { titleName: string; slots: number; forTitleName: string }>();
    for (const s of route.substitutes) {
      const cur = m.get(s.forTitleId);
      m.set(s.forTitleId, {
        titleName: s.titleName,
        forTitleName: s.forTitleName,
        slots: (cur?.slots ?? 0) + s.slots,
      });
    }
    return m;
  }, [route.substitutes]);
  const subPacks = route.substitutes.reduce((a, s) => a + s.packs, 0);

  function run(machineId: string, change: RouteChangeKind, name: string) {
    if (inFlight[machineId]) return;
    startTransition(async () => {
      markInFlight({ key: machineId, kind: change });
      const r = await reach(() => changeRoute(machineId, change));
      if (!r.ok) {
        toastV2(r.error, { tone: "critical" });
        return;
      }
      const data = r.data;
      if (!data) return;
      const title =
        change === "skip"
          ? `${name} hoppas över i dag`
          : change === "later"
            ? `${name} flyttas till i morgon`
            : `${name} ligger i dagens rutt`;
      toastUndo(title, undefined, () => undo(data.id, data.replaced));
    });
  }

  function undo(id: string, restore: RouteChangeKind | null = null) {
    if (inFlight[id]) return;
    startTransition(async () => {
      markInFlight({ key: id, kind: "undo" });
      const u = await reach(() => undoRouteChange(id, restore));
      if (!u.ok) toastV2(u.error, { tone: "critical" });
    });
  }

  const startHref = first ? `/fyll-pa/${first.machineId}?rutt=1` : null;
  const origin = route.depot?.address ?? null;
  const mapStops = remaining
    .map(
      (s) =>
        [s.store?.address, s.store?.city].filter(Boolean).join(", ") ||
        (s.store?.location ? `${s.store.location.lat},${s.store.location.lng}` : ""),
    )
    .filter(Boolean);

  const empty = emptyRouteText({
    ...route,
    stops: view.stops,
    // Allt just flyttat (innan servern svarat): samma text som när det är sparat.
    removed: view.removedNow
      ? [
          ...route.removed,
          ...route.stops.map((x) => ({
            id: x.machineId,
            machineId: x.machineId,
            name: x.name,
            change: "skip" as const,
          })),
        ]
      : route.removed,
  });
  const titleLine =
    stopCount === 0
      ? empty.title
      : [
          route.cities.length > 0 ? route.cities.join(" → ") : `${formatInt(stopCount)} stopp`,
          route.km !== null ? `${formatInt(route.km)}${NBSP}km` : null,
          route.minutes !== null ? `ca ${durationText(route.minutes)}` : null,
        ]
          .filter(Boolean)
          .join(" · ");

  const overflowLine =
    route.overflow.length > 0 ? (
      <span className="o">
        {route.overflow.length === 1
          ? `${route.overflow[0]!.name} ryms inte i veckans rutter`
          : `${formatInt(route.overflow.length)} automater ryms inte i veckans rutter`}
        {canEditLimits ? " · höj gränsen under Kommande dagar" : ""}
      </span>
    ) : null;
  const changes =
    route.removed.length > 0 || route.added.length > 0 ? (
      <div className="rchanges">
        {[...route.removed, ...route.added].map((c) => {
          const undoing = inFlight[c.id] !== undefined;
          return (
            <div className="lrow" key={c.id}>
              <div>
                <b>{c.name}</b>
                <small>
                  {c.change === "skip"
                    ? "Hoppas över i dag"
                    : c.change === "later"
                      ? "Flyttad till i morgon"
                      : "Lagd i rutten i dag"}
                </small>
              </div>
              {canEdit ? (
                <Button size="sm" onClick={() => undo(c.id)} disabled={undoing} pending={undoing}>
                  Ångra
                </Button>
              ) : null}
            </div>
          );
        })}
      </div>
    ) : null;
  // Inga stopp i dag: EN rad som säger varför, i stället för rubriken, ett tomt stoppkort och
  // en tom packlista med samma besked.
  const nothing = stopCount === 0;
  const packEmpty = route.load.length === 0;

  return (
    <div className="v2-rutt">
      {nothing ? null : (
        <div className="rsum-row">
          <div className="rsum">
            <b>{titleLine}</b>
            <span>
              {formatInt(stopCount)} stopp
              {route.savesProfitPerDayOre !== null && route.savesProfitPerDayOre > 0 ? (
                <>
                  {" "}
                  · räddar{" "}
                  <span className="pf">{approxKr(route.savesProfitPerDayOre)} vinst/dag</span>
                </>
              ) : null}
              {packEmpty ? "" : ` · ${formatInt(route.totalPacks)} pack`}
              {subPacks > 0 ? ` (plus ${formatInt(subPacks)} ersättare)` : ""}
              {route.short.length > 0 ? (
                <>
                  {" "}
                  ·{" "}
                  <span className="o">
                    {route.short.length === 1
                      ? "1 titel räcker inte hemma"
                      : `${route.short.length} titlar räcker inte hemma`}
                  </span>
                </>
              ) : null}
            </span>
            {overflowLine}
          </div>
          <div className="rsum-go">
            {mapStops.length > 0 ? (
              <RouteMapsLink
                stops={mapStops}
                origin={origin}
                size="touch"
                className="max-[900px]:w-full"
              />
            ) : null}
            {/* Dator: Starta rutt i sidhuvudet (telefonen har den klistrade raden längst ner). */}
            {startHref && canRefill ? (
              <ButtonLink href={startHref} variant="act" className="max-[900px]:hidden">
                {remaining.length === stopCount ? "Starta rutt" : "Fortsätt rutten"}
              </ButtonLink>
            ) : null}
          </div>
        </div>
      )}

      {/* Inga stopp: ingen packlista, så stoppkolumnen tar hela bredden (dator). */}
      <div className={cn("work", nothing && "one")}>
        <div className="col">
          {nothing ? (
            <Card className="o-empty">
              <Empty packs={emptyPacks([])} done={route.needing === 0} title={empty.title}>
                {empty.body ? <p>{empty.body}.</p> : null}
                {overflowLine ? <p>{overflowLine}</p> : null}
              </Empty>
              {changes}
            </Card>
          ) : (
            <Card
              className="o-stops"
              title={`I dag · ${formatInt(stopCount)} stopp`}
              actions={
                <span className="hd-note">
                  {route.routeMethod === "distance" ? "Kortast väg" : "Bråttom först"}
                </span>
              }
            >
              {view.groups.map((g, gi) => (
                <div className="rcity" key={`${g.city ?? "-"}-${gi}`}>
                  <div className="rch">
                    <b>{g.city ?? "Utan stad"}</b>
                    <span>
                      {formatInt(g.machineIds.length)} stopp · {formatInt(g.packs)} pack
                    </span>
                  </div>
                  {g.machineIds.map((id) => {
                    const s = byId.get(id);
                    if (!s) return null;
                    return (
                      <StopRow
                        key={id}
                        stop={s}
                        canEdit={canEdit}
                        canRefill={canRefill}
                        busy={inFlight[id] !== undefined}
                        checkedHere={s.kind === "check" && checkedStops.has(id)}
                        onCheckedHere={(on) => toggleChecked(id, on)}
                        checks={checks}
                        toggleCheck={toggleCheck}
                        onChange={run}
                        substitute={s.lines
                          .map((l) => substituteFor.get(l.titleId))
                          .find((x) => x !== undefined)}
                      />
                    );
                  })}
                </div>
              ))}
              {changes}
            </Card>
          )}

          <Card
            className="o-later"
            // Antalet står i listan; i rubriken bröt det raden bredvid gränsen (telefon).
            title="Kommande dagar"
            actions={
              canEditLimits ? (
                <LimitsSheet limits={route.limits} />
              ) : (
                <span className="hd-note">
                  Max {route.limits.maxStops} stopp · {formatInt(route.limits.maxPacks)} pack/dag
                </span>
              )
            }
          >
            {route.upcoming.length === 0 ? (
              <p className="rempty">Inga fler besök behövs den här veckan.</p>
            ) : (
              route.upcoming.map((d) => {
                const urgent = [...d.stops]
                  .filter((s) => s.daysLeft !== null)
                  .sort((a, b) => (a.daysLeft ?? 99) - (b.daysLeft ?? 99))[0];
                const cities = [...new Set(d.stops.map((s) => s.city ?? "").filter(Boolean))];
                return (
                  <div className="lrow" key={d.date}>
                    <div>
                      <b>
                        {weekdayShort(d.date)} · {formatInt(d.stops.length)} stopp ·{" "}
                        {formatInt(d.packs)} pack
                      </b>
                      <small>
                        {d.cities.length > 0 ? `${d.cities.join(" → ")} · ` : ""}
                        {d.stops.map((s) => s.name).join(", ")}
                      </small>
                    </div>
                    <div className="lgo">
                      {urgent ? (
                        <span className="lurg">
                          {urgent.name} · tom om {urgent.daysLeft}
                          {NBSP}d
                        </span>
                      ) : null}
                      {canEdit
                        ? (cities.length > 0 ? cities : [null]).map((city) => {
                            const list = d.stops.filter((s) => city === null || s.city === city);
                            // Bara knappen man tryckte på väntar; resten går att trycka på.
                            const adding = list.some((s) => inFlight[s.machineId] !== undefined);
                            return (
                              <Button
                                key={city ?? "alla"}
                                size="sm"
                                disabled={adding}
                                pending={adding}
                                onClick={() => {
                                  for (const s of list) run(s.machineId, "add", s.name);
                                }}
                              >
                                {city ?? "Alla"} i dag
                              </Button>
                            );
                          })
                        : null}
                    </div>
                  </div>
                );
              })
            )}
          </Card>
        </div>

        {nothing ? null : (
          // Telefon: packlistan först när den har något; tom är den en rad efter stoppen.
          <div className={cn("col", packEmpty && "pack-empty")}>
            <Card
              className="o-pack"
              title={packEmpty ? "Packlista" : `Packlista · ${formatInt(route.totalPacks)} pack`}
              actions={
                packEmpty ? null : (
                  <span className="hd-note">
                    {formatInt(route.load.filter((l) => packed.has(l.titleId)).length)} av{" "}
                    {formatInt(route.load.length)} packade
                  </span>
                )
              }
            >
              {packEmpty ? (
                <p className="rempty">
                  {remaining.some((s) => s.kind === "fill")
                    ? // Stopp att fylla men inget i listan (okänd kapacitet): inte "Allt är fullt".
                      "Inget i listan. Se Fyll på för vad som ska med."
                    : "Inget att packa i dag."}
                </p>
              ) : (
                <>
                  {route.short.map((sh) => {
                    const line = route.load.find((l) => l.titleId === sh.titleId);
                    const sub = substituteFor.get(sh.titleId);
                    const need = (line?.quantity ?? 0) + sh.shortBy;
                    return (
                      <div className="pw" key={sh.titleId}>
                        <PackImage title={sh.titleName} size="m" />
                        <div>
                          <b>
                            {sh.titleName}: behövs {formatInt(need)}, hemma{" "}
                            {formatInt(line?.home ?? 0)}
                          </b>
                          <small>
                            {formatInt(sh.shortBy)} saknas hemma.
                            {sub
                              ? ` ${sub.slots === 1 ? "1 fack får" : `${sub.slots} fack får`} ${sub.titleName}.`
                              : " Beställ eller packa fler."}
                          </small>
                        </div>
                        {sub ? <Badge tone="plain">Ersättare</Badge> : null}
                      </div>
                    );
                  })}
                  <ul className="plist">
                    {route.load.map((l) => {
                      const on = packed.has(l.titleId);
                      const short = l.shortBy > 0;
                      return (
                        <li key={l.titleId}>
                          <label className={cn("prow", on && "on", short && "o")}>
                            <input
                              type="checkbox"
                              checked={on}
                              onChange={() => togglePacked(l.titleId)}
                            />
                            <span className="pkx" aria-hidden="true">
                              <svg width="10" height="10" viewBox="0 0 12 12" fill="none">
                                <path
                                  d="M2.5 6.2 5 8.6l4.5-5"
                                  stroke="currentColor"
                                  strokeWidth="1.8"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </svg>
                            </span>
                            <span className="pkb">
                              <PackImage title={l.titleName} size="m" />
                            </span>
                            <span className="pkt">
                              <b>{l.titleName}</b>
                              <small>
                                {l.home !== null ? `Hemma ${formatInt(l.home)}` : "Hemma okänt"}
                                {short ? ` · behövs ${formatInt(l.quantity + l.shortBy)}` : ""}
                              </small>
                            </span>
                            <span className="pkq">{formatInt(l.quantity)}</span>
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                  <p className="pft">
                    Bocka av det du packat. Det sparas i den här webbläsaren i dag.
                  </p>
                </>
              )}
            </Card>
          </div>
        )}
      </div>

      {startHref && canRefill ? (
        <div className="rgo">
          {mapStops.length > 0 ? (
            <RouteMapsLink
              stops={mapStops}
              origin={origin}
              label="Öppna i Maps"
              className="lg max-[900px]:hidden"
            />
          ) : null}
          <ButtonLink href={startHref} variant="act" size="lg">
            {remaining.length === stopCount
              ? `Starta rutt · ${formatInt(stopCount)} stopp`
              : `Fortsätt · ${formatInt(remaining.length)} stopp kvar`}
          </ButtonLink>
        </div>
      ) : null}
      <p className="rnote">
        Automater som är tomma, blir tomma i morgon eller är offline kommer med först. Sedan fylls
        dagen med det som brådskar, upp till {route.limits.maxStops} stopp eller{" "}
        {formatInt(route.limits.maxPacks)} pack.
        {route.km === null && stopCount > 0
          ? " Körsträckan visas när butikerna har koordinater."
          : " Sträcka och tid är ungefärliga."}
      </p>
    </div>
  );
}

function StopRow({
  stop: s,
  canEdit,
  canRefill,
  busy,
  checkedHere,
  onCheckedHere,
  checks,
  toggleCheck,
  onChange,
  substitute,
}: {
  stop: RouteStop;
  canEdit: boolean;
  canRefill: boolean;
  /** Ett tryck på just det här stoppet väntar på servern. */
  busy: boolean;
  /** Offline-stoppet är kollat ("Stoppet klart" i Fyll på, sparat i den här telefonen). */
  checkedHere: boolean;
  onCheckedHere: (on: boolean) => void;
  checks: ReadonlySet<string>;
  toggleCheck: (id: string) => void;
  onChange: (machineId: string, change: RouteChangeKind, name: string) => void;
  substitute: { titleName: string; slots: number; forTitleName: string } | undefined;
}) {
  const done = s.done || checkedHere;
  const loss = s.lossProfitPerDayOre;
  const lossLead =
    s.status === "tom"
      ? "Tom nu · t"
      : s.status === "startklar"
        ? "Ny i dag · t"
        : s.daysLeft === 1
          ? "Tom i morgon · t"
          : "T";
  const lossBadge =
    loss !== null && loss >= 500 && !done ? (
      <Badge tone={s.status === "tom" || s.status === "offline" ? "critical" : "warning"}>
        {lossLead}appar {approxKr(loss)} vinst/dag
      </Badge>
    ) : null;
  return (
    <div className={cn("stop", done && "done")}>
      <span
        className="sno"
        aria-label={done ? `Stopp ${s.sequence}, klart` : `Stopp ${s.sequence}`}
      >
        {done ? (
          <svg width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true">
            <path
              d="M2.5 6.2 5 8.6l4.5-5"
              stroke="currentColor"
              strokeWidth="1.8"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : (
          s.sequence
        )}
      </span>
      <div className="sb">
        <div className="st1">
          <b>{s.name}</b>
          {s.done ? (
            <Badge tone="success" dot>
              Påfylld i dag
            </Badge>
          ) : checkedHere ? (
            <Badge tone="success" dot>
              Kollad i dag
            </Badge>
          ) : s.kind === "check" ? (
            <Badge tone="critical" dot>
              Offline · kolla på plats
            </Badge>
          ) : s.status ? (
            <FleetStatusBadge status={s.status} daysLeft={s.daysLeft} />
          ) : null}
          {s.added ? <Badge tone="info">Tillagd</Badge> : null}
          {lossBadge}
        </div>
        <small>
          {placeText(s)}
          {s.code ? <span className="v2-id"> {s.code}</span> : null}
          {s.power ? (
            <>
              <br />
              {s.power}
            </>
          ) : null}
        </small>
        {s.kind === "check" && !done ? (
          <ul className="chk">
            {CHECKLIST.map((text, i) => {
              const id = `${s.machineId}:${i}`;
              return (
                <li key={id}>
                  <label>
                    <input
                      type="checkbox"
                      checked={checks.has(id)}
                      onChange={() => toggleCheck(id)}
                    />
                    {text}
                  </label>
                </li>
              );
            })}
          </ul>
        ) : null}
        {s.packs > 0 ? (
          <details className="stitles">
            <summary>
              Ta med <b>{formatInt(s.packs)} pack</b>
              {s.emptySlots > 0
                ? ` · ${s.emptySlots === 1 ? "1 fack tomt" : `${formatInt(s.emptySlots)} fack tomma`}`
                : ""}
            </summary>
            <div>
              {s.lines
                .filter((l) => l.quantity > 0)
                .map((l) => (
                  <span key={l.titleId}>
                    <PackImage title={l.titleName} size="xs" />
                    {formatInt(l.quantity)} {l.titleName}
                  </span>
                ))}
              {substitute ? (
                <span className="sub">
                  {substitute.forTitleName} räcker inte:{" "}
                  {substitute.slots === 1 ? "1 fack" : `${substitute.slots} fack`} får{" "}
                  {substitute.titleName}
                </span>
              ) : null}
            </div>
          </details>
        ) : s.kind === "fill" && !s.done ? (
          <p className="sreason">
            {s.reasons[0] ?? (s.added ? "Lagd i rutten." : "Något är slut. Se Fyll på.")}
          </p>
        ) : null}
        <div className="sact">
          <MapsLink
            address={s.store?.address}
            city={s.store?.city}
            lat={s.store?.location?.lat}
            lng={s.store?.location?.lng}
            size="touch"
          />
          <CallLink phone={s.store?.phone} name={s.store?.contactName} size="touch" />
        </div>
      </div>
      <div className="sgo">
        {s.kind === "check" ? (
          <ButtonLink prefetch={false} href={`/automater?valj=${encodeURIComponent(s.code)}`} touch>
            Öppna
          </ButtonLink>
        ) : canRefill && !s.done ? (
          <ButtonLink prefetch={false} href={`/fyll-pa/${s.machineId}?rutt=1`} touch>
            Fyll på
          </ButtonLink>
        ) : null}
        {checkedHere && !s.done ? (
          <Button variant="plain" touch onClick={() => onCheckedHere(false)}>
            Ångra klart
          </Button>
        ) : canEdit && !done ? (
          <>
            <Button
              variant="plain"
              touch
              disabled={busy}
              onClick={() => onChange(s.machineId, "skip", s.name)}
            >
              Hoppa över
            </Button>
            <Button
              variant="plain"
              touch
              disabled={busy}
              onClick={() => onChange(s.machineId, "later", s.name)}
            >
              Till i morgon
            </Button>
          </>
        ) : null}
      </div>
    </div>
  );
}
