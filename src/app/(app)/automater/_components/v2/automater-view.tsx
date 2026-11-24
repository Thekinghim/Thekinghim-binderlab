"use client";

import { approxKr } from "@/analytics/forecast/common";
import "./automater-v2.css";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { showsLoss } from "@/analytics/fleet-status";
import { Badge } from "@/components/v2/badge";
import { Button, ButtonLink } from "@/components/v2/button";
import { CallLink } from "@/components/v2/call-link";
import { Chips } from "@/components/v2/chips";
import { FillBar, fillTone } from "@/components/v2/fill-bar";
import { MachineGlyph, glyphStatusOf } from "@/components/v2/machine-glyph";
import { PackImage } from "@/components/v2/pack-image";
import { SearchField } from "@/components/v2/search-field";
import { Sheet } from "@/components/v2/sheet";
import { Sparkline } from "@/components/v2/sparkline";
import { FleetStatusBadge } from "@/components/v2/status-dot";
import { usePhone } from "@/components/v2/use-media";
import { cn } from "@/lib/cn";
import { formatDecimal, formatInt, formatSek, MINUS, NBSP } from "@/lib/format";

import type { HistoryEntry } from "@/server/data/v2/analytics/history-model";

import { machineHistory } from "../../actions";
import type { AutomaterV2Data } from "../../_lib/v2-data";
import {
  AUTO_FILTER_LABEL,
  AUTO_FILTERS,
  filterCounts,
  glyphSlotsOf,
  groupMachines,
  matchesFilter,
  matchesSearch,
  needsFill,
  orderSlots,
  roomFor,
  sinceText,
  sortMachines,
  type AutoFilter,
  type AutoGroup,
  type AutoMachine,
  type AutoSort,
  type AutoSortKey,
} from "../../_lib/v2-model";

const kr = (ore: number) => formatSek(Math.round(ore / 100));
const fillHref = (m: Pick<AutoMachine, "id">) => `/fyll-pa/${m.id}?fran=automater`;

/** "+43 %" / "−52 %" mot medianen. null utan median eller vinst. */
function vsMedianPct(e: AutoMachine["economy"]): number | null {
  if (!e || e.profitPerDayOre === null || e.vsMedianOre === null) return null;
  const median = e.profitPerDayOre - e.vsMedianOre;
  if (median <= 0) return null;
  return Math.round((e.vsMedianOre / median) * 100);
}

function pctText(n: number): string {
  return `${n > 0 ? "+" : n < 0 ? MINUS : "±"}${formatInt(Math.abs(n))}${NBSP}%`;
}

function packsPerDay(milli: number): string {
  return `${formatDecimal(Math.round(milli / 100) / 10)}${NBSP}pack`;
}

function dayLabel(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("sv-SE", { day: "numeric", month: "short", timeZone })
    .format(new Date(iso))
    .replace(".", "");
}

function powerText(m: AutoMachine): string {
  return m.power ? `Strömmen av ${m.power.off}–${m.power.on} varje dag` : "Strömmen är alltid på";
}

/** Rubriker och sorteringsnycklar. Pengakolumnerna bara med ekonomi. */
const COLUMNS: readonly {
  key: AutoSortKey;
  label: string;
  right?: boolean;
  money?: boolean;
  title?: string;
  /** Liten rad under rubriken: fönstret talet gäller ("30 d"), när det inte följer perioden. */
  sub?: string;
}[] = [
  { key: "n", label: "Automat" },
  { key: "s", label: "Läge" },
  { key: "f", label: "Fylld" },
  { key: "d", label: "Tom om", right: true },
  { key: "l", label: "Senast fylld", right: true, title: "Dagar sedan senaste påfyllning" },
  {
    key: "p",
    label: "Vinst/dag",
    right: true,
    money: true,
    sub: "30 d",
    title: "Vår vinst per dag i drift, senaste 30 dagarna (följer inte periodvalet)",
  },
  {
    key: "x",
    label: "Mot snitt",
    right: true,
    money: true,
    sub: "30 d",
    title: "Vinst per dag mot medianen för alla automater, senaste 30 dagarna",
  },
];

/**
 * Automater (V2): sök, filterchips, gruppera Stad/Butik/Ingen, sortera på rubrikerna och välj
 * en automat (till höger på datorn, ark på telefonen). Valet och filtret står i adressen
 * (?valj=<kod>, ?f=offline), så att länkar från Hem och Ctrl K öppnar rätt.
 */
export function AutomaterView({
  data,
  initialFilter,
  initialSelected,
}: {
  data: AutomaterV2Data;
  initialFilter: AutoFilter;
  initialSelected: string | null;
}) {
  const phone = usePhone();
  const now = Date.parse(data.now);
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<AutoFilter>(initialFilter);
  const [group, setGroup] = useState<AutoGroup>("stad");
  const [sort, setSort] = useState<AutoSort>({ key: "s", dir: 1 });
  const [shut, setShut] = useState<ReadonlySet<string>>(new Set());
  const byCode = (code: string | null) =>
    code ? (data.machines.find((m) => m.code === code || m.id === code) ?? null) : null;
  const [selectedId, setSelectedId] = useState<string | null>(
    () => byCode(initialSelected)?.id ?? null,
  );
  const [sheetOpen, setSheetOpen] = useState(false);

  const counts = useMemo(() => filterCounts(data.machines, data.economy), [data]);
  const visible = useMemo(
    () =>
      sortMachines(
        data.machines.filter((m) => matchesFilter(m, filter) && matchesSearch(m, q)),
        sort,
        now,
      ),
    [data.machines, filter, q, sort, now],
  );
  const groups = useMemo(
    () => groupMachines(visible, group, data.cityOrder),
    [visible, group, data.cityOrder],
  );
  // Datorn: utan val visas den första automaten (den som behöver mest).
  const selected =
    data.machines.find((m) => m.id === selectedId) ?? (phone ? null : (visible[0] ?? null));

  // Adressen följer filtret och valet (ersätter, ingen ny historik).
  useEffect(() => {
    const url = new URL(window.location.href);
    if (filter === "alla") url.searchParams.delete("f");
    else url.searchParams.set("f", filter);
    const code = data.machines.find((m) => m.id === selectedId)?.code;
    if (code) url.searchParams.set("valj", code);
    else url.searchParams.delete("valj");
    if (url.href !== window.location.href)
      window.history.replaceState(window.history.state, "", url);
  }, [filter, selectedId, data.machines]);

  const choose = useCallback(
    (m: AutoMachine) => {
      setSelectedId(m.id);
      if (phone) setSheetOpen(true);
    },
    [phone],
  );
  // Escape stänger valet på telefonen (arket stänger själv), på datorn tömmer det sökningen.
  const listRef = useRef<HTMLDivElement>(null);
  const onListKey = (e: React.KeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    const rows = Array.from(listRef.current?.querySelectorAll<HTMLElement>("[data-row]") ?? []);
    const i = rows.indexOf(document.activeElement as HTMLElement);
    const next = rows[Math.max(0, Math.min(rows.length - 1, i + (e.key === "ArrowDown" ? 1 : -1)))];
    if (next) {
      e.preventDefault();
      next.focus();
      const m = data.machines.find((x) => x.id === next.dataset.row);
      if (m && !phone) setSelectedId(m.id);
    }
  };

  const toggleSort = (key: AutoSortKey) =>
    setSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: 1 }));

  const chipOptions = AUTO_FILTERS.filter((f) => counts[f] !== undefined).map((f) => ({
    value: f,
    label: AUTO_FILTER_LABEL[f],
    count: counts[f],
  }));
  const cols = COLUMNS.filter((c) => !c.money || data.economy);

  return (
    <div className="v2-auto">
      <section className="pn o-list" aria-label="Automater">
        <div className="atools">
          <SearchField
            value={q}
            onChange={setQ}
            placeholder="Sök automat, butik, stad, titel"
            hotkey
          />
          <Chips
            options={chipOptions}
            value={filter}
            onChange={setFilter}
            ariaLabel="Visa"
            scroll
          />
          <div className="grp" role="group" aria-label="Gruppera">
            <span>Gruppera</span>
            {(["stad", "butik", "ingen"] as const).map((g) => (
              <button key={g} type="button" aria-pressed={group === g} onClick={() => setGroup(g)}>
                {g === "stad" ? "Stad" : g === "butik" ? "Butik" : "Ingen"}
              </button>
            ))}
          </div>
        </div>
        <div className={cn("arow head", !data.economy && "nomoney")} role="row">
          {cols.map((c) => (
            <button
              key={c.key}
              type="button"
              className={cn("sb", c.right && "r")}
              title={c.title}
              aria-sort={
                sort.key === c.key ? (sort.dir === 1 ? "ascending" : "descending") : undefined
              }
              onClick={() => toggleSort(c.key)}
            >
              {c.sub ? (
                <span className="sl">
                  <span>{c.label}</span>
                  <small>{c.sub}</small>
                </span>
              ) : (
                c.label
              )}
              {sort.key === c.key ? (
                <span aria-hidden="true">{sort.dir === 1 ? "↑" : "↓"}</span>
              ) : null}
            </button>
          ))}
          <span />
        </div>
        <div ref={listRef} role="listbox" aria-label="Automater" onKeyDown={onListKey}>
          {visible.length === 0 ? (
            <div className="aempty">
              Inga automater matchar.
              <Button
                size="sm"
                variant="plain"
                onClick={() => {
                  setQ("");
                  setFilter("alla");
                }}
              >
                Visa alla
              </Button>
            </div>
          ) : (
            groups.map((g) => {
              const isShut = shut.has(g.key);
              const rows = g.machines.map((m) => (
                <Row
                  key={m.id}
                  m={m}
                  economy={data.economy}
                  canFill={data.canFill}
                  selected={selected?.id === m.id}
                  now={now}
                  timeZone={data.timeZone}
                  onChoose={() => choose(m)}
                />
              ));
              if (group === "ingen") return <div key={g.key}>{rows}</div>;
              return (
                <div key={g.key} className={cn("ag", isShut && "shut")}>
                  <button
                    type="button"
                    className="agh"
                    aria-expanded={!isShut}
                    onClick={() =>
                      setShut((prev) => {
                        const next = new Set(prev);
                        if (next.has(g.key)) next.delete(g.key);
                        else next.add(g.key);
                        return next;
                      })
                    }
                  >
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2.2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      aria-hidden="true"
                    >
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                    <b>{g.label}</b>
                    <span>
                      {formatInt(g.machines.length)}{" "}
                      {g.machines.length === 1 ? "automat" : "automater"}
                    </span>
                    {g.needFill > 0 ? (
                      <span className="o">{formatInt(g.needFill)} behöver påfyllning</span>
                    ) : null}
                    {g.offline > 0 ? (
                      <span className="o crit">{formatInt(g.offline)} offline</span>
                    ) : null}
                    {g.needFill === 0 && g.offline === 0 ? <span>· inget att göra</span> : null}
                    {data.economy && g.profitPerDayOre !== null ? (
                      <span
                        className="gk"
                        title="Summa vinst per dag för gruppen, senaste 30 dagarna"
                      >
                        Σ {kr(g.profitPerDayOre)}/dag · 30{NBSP}d
                      </span>
                    ) : null}
                  </button>
                  <div className="agb">
                    <div>{rows}</div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </section>

      {!phone ? (
        <aside className="adet" aria-label="Vald automat">
          {selected ? <Detail key={selected.id} m={selected} data={data} /> : null}
        </aside>
      ) : (
        <Sheet
          open={sheetOpen && selected !== null}
          onOpenChange={(open) => {
            setSheetOpen(open);
            if (!open) setSelectedId(null);
          }}
          title={selected ? selected.name : "Automat"}
          description={
            selected ? [selected.storeName, selected.code].filter(Boolean).join(" · ") : undefined
          }
        >
          {selected ? <Detail key={selected.id} m={selected} data={data} sheet /> : null}
        </Sheet>
      )}
    </div>
  );
}

function Row({
  m,
  economy,
  canFill,
  selected,
  now,
  timeZone,
  onChoose,
}: {
  m: AutoMachine;
  economy: boolean;
  canFill: boolean;
  selected: boolean;
  now: number;
  timeZone: string;
  onChoose: () => void;
}) {
  const vs = vsMedianPct(m.economy);
  const tone = fillTone(m.fillBp);
  const soon = m.daysLeft !== null && m.daysLeft <= 3;
  return (
    <div
      role="option"
      tabIndex={0}
      data-row={m.id}
      aria-selected={selected}
      className={cn("arow", !economy && "nomoney")}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest("a,button")) return;
        onChoose();
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onChoose();
        }
      }}
    >
      <span className="c-n">
        {/* Automatens bild (40 px): läget är skärmens färg. Texten står bredvid. */}
        <MachineGlyph
          look={m.appearance}
          size="s"
          status={glyphStatusOf(m.status)}
          decorative
          className="gl"
        />
        <span className="tx">
          <b>{m.name}</b>
          <small>
            {m.storeName ?? "Ingen butik"}
            <span className="hidden max-[900px]:inline"> · {m.code}</span>
          </small>
        </span>
      </span>
      <span className="c-s">
        <FleetStatusBadge status={m.status} daysLeft={m.daysLeft} />
      </span>
      <span className="c-f">
        <FillBar bp={m.fillBp} width={56} />
      </span>
      <span className={cn("c-d r", soon && "warn")}>
        {m.units === 0 ? "Tom" : m.daysLeft === null ? "–" : `${formatInt(m.daysLeft)}${NBSP}d`}
      </span>
      <span className="c-k r mute">{sinceText(m.lastRefillAt, now, timeZone)}</span>
      {economy ? (
        <>
          <span className="c-v r">
            {m.economy?.profitPerDayOre != null ? kr(m.economy.profitPerDayOre) : "–"}
          </span>
          <span className={cn("c-x r", vs !== null && (vs >= 0 ? "pf" : vs <= -40 ? "warn" : ""))}>
            {vs === null ? (m.status === "startklar" ? "Ny" : "–") : pctText(vs)}
          </span>
        </>
      ) : null}
      <span className="c-a">
        {m.status === "offline" ? (
          <CallLink phone={m.phone} name={m.contactName} size="sm" />
        ) : canFill && needsFill(m) ? (
          <ButtonLink size="sm" variant="act" href={fillHref(m)}>
            Fyll på
          </ButtonLink>
        ) : null}
      </span>
      <span className="c-m">
        <span className={cn(tone === "warning" && "warn", tone === "critical" && "crit")}>
          {/* Utan fyllnad: statusen ("I drift", "Offline") i stället för ett streck. */}
          {m.fillBp === null ? m.statusLabel : `${Math.round(m.fillBp / 100)}${NBSP}%`}
        </span>
        <span className={cn("v2-dot", m.tone !== "neutral" && m.tone)} aria-hidden="true" />
      </span>
      <span className="mbar" aria-hidden="true">
        <i
          className={tone}
          style={{ transform: `scaleX(${Math.max(0, Math.min(1, (m.fillBp ?? 0) / 10_000))})` }}
        />
      </span>
    </div>
  );
}

function Detail({
  m,
  data,
  sheet = false,
}: {
  m: AutoMachine;
  data: AutomaterV2Data;
  sheet?: boolean;
}) {
  const [tab, setTab] = useState<"o" | "h">("o");
  const slots = useMemo(() => orderSlots(m.slots), [m.slots]);
  const glyphSlots = useMemo(() => glyphSlotsOf(m.slots), [m.slots]);
  const room = roomFor(m);
  const empty = m.emptyChannels;
  const e = m.economy;
  const loss = e?.lossProfitPerDayOre ?? null;
  const now = Date.parse(data.now);
  const offlineFor = m.offlineSince !== null ? sinceText(m.offlineSince, now, data.timeZone) : null;

  return (
    // I arket ramar arket in innehållet: panelerna får ingen egen ram (ingen dubbelram).
    <div className={cn("v2-auto-det flex flex-col gap-[14px]", sheet && "in-sheet")}>
      <div className="dtabs" role="tablist" aria-label="Visa">
        <button type="button" role="tab" aria-selected={tab === "o"} onClick={() => setTab("o")}>
          Översikt
        </button>
        <button type="button" role="tab" aria-selected={tab === "h"} onClick={() => setTab("h")}>
          Historik
        </button>
      </div>
      {tab === "h" ? (
        <History m={m} timeZone={data.timeZone} />
      ) : (
        <>
          <section className="pn sum" aria-live="polite" aria-label="Vald automat">
            <div className="who2">
              <span className="lab">{[m.code, m.city].filter(Boolean).join(" · ")}</span>
              <span className="flex items-center gap-1.5">
                <FleetStatusBadge status={m.status} daysLeft={m.daysLeft} />
                {empty > 0 && m.status !== "tom" ? (
                  <Badge tone="warning">
                    {formatInt(empty)} {empty === 1 ? "fack tomt" : "fack tomma"}
                  </Badge>
                ) : null}
              </span>
            </div>
            {sheet ? null : <h3>{m.name}</h3>}
            <p className={cn("spow", m.status === "offline" && "warn")}>
              {m.status === "offline"
                ? `${m.offlineSince ? `Ingen kontakt sedan ${offlineFor === "i dag" ? "i dag" : dayLabel(m.offlineSince, data.timeZone)}` : "Ingen kontakt"}. ${powerText(m)}.`
                : powerText(m)}
            </p>
            <div className="dgl">
              {/* Automaten som den ser ut i butiken: packen och fyllnaden på skärmen. */}
              <MachineGlyph
                look={m.appearance}
                size="l"
                status={glyphStatusOf(m.status)}
                slots={glyphSlots}
                name={m.code}
                className="gl"
              />
              <div className="dgl-t">
                {m.fillBp === null ? (
                  // Utan fackdata från Awish: en lugn rad i stället för tomma staplar.
                  <p className="line mute">Fyllnad okänd – Awish har inte skickat facken än.</p>
                ) : (
                  <>
                    <div className="bigp">
                      <span>
                        {`${Math.round(m.fillBp / 100)}${NBSP}%`} <span className="s">fylld</span>
                      </span>
                      {m.capacity !== null && m.units !== null ? (
                        <small>
                          {formatInt(m.units)} av {formatInt(m.capacity)} pack
                        </small>
                      ) : null}
                    </div>
                    <span className="v2-track bigtrack block" aria-hidden="true">
                      <i
                        className={fillTone(m.fillBp)}
                        style={{
                          transform: `scaleX(${Math.max(0, Math.min(1, m.fillBp / 10_000))})`,
                        }}
                      />
                    </span>
                  </>
                )}
                <p className={cn("line", needsFill(m) && "warn")}>
                  {m.status === "offline" ? (
                    "Säljer inget tills den är online igen."
                  ) : m.units === 0 ? (
                    "Tom. Säljer inget tills den fylls på."
                  ) : m.daysLeft !== null ? (
                    <>
                      Tom om ca{" "}
                      <b>
                        {formatInt(m.daysLeft)} {m.daysLeft === 1 ? "dag" : "dagar"}
                      </b>
                      {empty > 0 ? ` · ${formatInt(empty)} fack slut` : ""}
                    </>
                  ) : (
                    "Säljer inte just nu."
                  )}
                </p>
              </div>
            </div>
            <dl className="sf">
              {e ? (
                <>
                  <div>
                    <dt>Intäkt {data.periodLabel}</dt>
                    <dd>
                      {e.revenueOre !== null ? kr(e.revenueOre) : "–"}
                      <Sparkline values={m.sales30} height={18} className="w-16" />
                    </dd>
                  </div>
                  <div>
                    <dt>Vinst {data.periodLabel}</dt>
                    <dd className="pf">{e.profitOre !== null ? kr(e.profitOre) : "–"}</dd>
                  </div>
                </>
              ) : (
                <>
                  <div>
                    <dt>I automaten</dt>
                    <dd>{m.units === null ? "–" : `${formatInt(m.units)} pack`}</dd>
                  </div>
                  <div>
                    <dt>Tom om</dt>
                    <dd>{m.daysLeft === null ? "–" : `${formatInt(m.daysLeft)} d`}</dd>
                  </div>
                </>
              )}
              <div>
                <dt>Sålt per dag</dt>
                <dd>{packsPerDay(m.perDayMilli)}</dd>
              </div>
              <div>
                <dt>Senast fylld</dt>
                <dd>{m.lastRefillAt ? dayLabel(m.lastRefillAt, data.timeZone) : "–"}</dd>
              </div>
              {e && showsLoss(loss) ? (
                <div className="wide">
                  <dt>{m.status === "offline" ? "Offline kostar ca" : "Tomma fack kostar ca"}</dt>
                  <dd className="warn">{approxKr(loss)} vinst/dag</dd>
                </div>
              ) : null}
            </dl>
            <div className="go">
              {m.status === "offline" ? (
                <>
                  {m.phone ? <CallLink phone={m.phone} name={m.contactName} size="lg" /> : null}
                  <small>Ring butiken och be dem kolla strömmen.</small>
                </>
              ) : data.canFill ? (
                <>
                  <ButtonLink
                    size="lg"
                    variant={needsFill(m) ? "act" : "default"}
                    href={fillHref(m)}
                  >
                    Fyll på
                  </ButtonLink>
                  {room !== null && room > 0 ? (
                    <small>Plats för {formatInt(room)} pack till.</small>
                  ) : null}
                </>
              ) : null}
            </div>
          </section>

          {slots.length > 0 ? (
            <section className="pn" aria-label="Facken">
              <div className="hd">
                <b>Facken · {formatInt(slots.reduce((n, s) => n + s.slots, 0))}</b>
                <span className="lk">
                  {m.name} · {m.code}
                </span>
              </div>
              <div className="sgrid">
                {slots.map((s) => {
                  const isEmpty = s.units <= 0;
                  const cap = s.capacity ?? 0;
                  const on = cap > 0 ? Math.round((Math.min(s.units, cap) / cap) * 10) : 0;
                  return (
                    <div key={s.titleId} className={cn("scard", isEmpty && "e")}>
                      <span className="nr">
                        {s.channels.length > 0 ? `Fack ${s.channels.join(", ")}` : "Fack"}
                      </span>
                      <div className="ti">{s.name}</div>
                      <div className="row">
                        <PackImage title={s.name} size="m" />
                        {cap > 0 ? (
                          <span className="blk" aria-hidden="true">
                            {Array.from({ length: 10 }, (_, i) => (
                              <i key={i} className={i < on ? "on" : undefined} />
                            ))}
                          </span>
                        ) : null}
                      </div>
                      <div className="ct">
                        <b>{formatInt(s.units)}</b>
                        {s.capacity !== null ? ` av ${formatInt(s.capacity)}` : " pack"}
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {m.storeName ? (
            data.economy ? (
              <Link className="pn shopline" href="/butiker">
                <span className="lab">Butik</span>
                <span className="sl-t">
                  <b>{m.storeName}</b>
                  <small>
                    {m.power ? `Strömmen av ${m.power.off}–${m.power.on}` : "Alltid på"}
                  </small>
                </span>
                <span className="lk">
                  Butiker <span aria-hidden="true">→</span>
                </span>
              </Link>
            ) : (
              <div className="pn shopline">
                <span className="lab">Butik</span>
                <span className="sl-t">
                  <b>{m.storeName}</b>
                  <small>
                    {[m.address, m.city].filter(Boolean).join(", ") ||
                      (m.power ? `Strömmen av ${m.power.off}–${m.power.on}` : "Alltid på")}
                  </small>
                </span>
              </div>
            )
          ) : null}
        </>
      )}
    </div>
  );
}

function History({ m, timeZone }: { m: AutoMachine; timeZone: string }) {
  const [state, setState] = useState<
    | { kind: "loading" }
    | { kind: "error"; text: string }
    | { kind: "ok"; rows: readonly HistoryEntry[] }
  >({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let live = true;
    machineHistory(m.id)
      .then((res) => {
        if (!live) return;
        setState(
          res.ok ? { kind: "ok", rows: res.data ?? [] } : { kind: "error", text: res.error },
        );
      })
      .catch(() => live && setState({ kind: "error", text: "Historiken kunde inte läsas." }));
    return () => {
      live = false;
    };
  }, [m.id, attempt]);
  return (
    <section className="pn" aria-label="Historik">
      <div className="hd">
        <b>Historik · {m.name}</b>
        <span className="lk">{m.code}</span>
      </div>
      {state.kind === "loading" ? (
        <div className="flex flex-col gap-2 p-4" aria-busy="true">
          {Array.from({ length: 4 }, (_, i) => (
            <span key={i} className="v2-skel h-9" />
          ))}
        </div>
      ) : state.kind === "error" ? (
        <div className="aempty">
          {state.text}
          <Button
            size="sm"
            onClick={() => {
              setState({ kind: "loading" });
              setAttempt((n) => n + 1);
            }}
          >
            Försök igen
          </Button>
        </div>
      ) : state.rows.length === 0 ? (
        <div className="aempty">Inget har hänt med automaten än.</div>
      ) : (
        <ol>
          {state.rows.map((r, i) => (
            <li key={`${r.at}-${i}`} className="hrow">
              <time dateTime={r.at}>{dayLabel(r.at, timeZone)}</time>
              <span>
                <b className={r.alert ? "crit" : undefined}>{r.title}</b>
                <small>{r.detail}</small>
              </span>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
