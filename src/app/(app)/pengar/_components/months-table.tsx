"use client";

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";

import { DownloadLink } from "@/components/v2/download-link";
import { PHONE_QUERY } from "@/components/v2/use-media";

import type { MonthTable } from "@/server/data/v2/analytics/money-model";
import { monthShort } from "@/server/data/v2/analytics/money-model";

import { formatInt } from "@/lib/format";

type SortKey = number | "avg";

/** "283" (kronor per dag, hela kronor) eller "–". */
function cell(ore: number | null): string {
  return ore === null ? "–" : formatInt(Math.round(ore / 100));
}

/**
 * Vinst per automat · kr per dag i tjänst, 12 månader (prototypens .yt). Färgen visar
 * nivån, rubrikerna sorterar, CSV-knappen hämtar samma tabell. På telefon är tabellen
 * hopfälld under rubriken.
 */
export function MonthsTable({ table }: { table: MonthTable }) {
  const lastFull = (() => {
    for (let i = table.months.length - 1; i >= 0; i--) if (!table.months[i]!.running) return i;
    return table.months.length - 1;
  })();
  const [sort, setSort] = useState<{ key: SortKey; dir: "desc" | "asc" }>({
    key: lastFull,
    dir: "desc",
  });
  const rows = useMemo(() => {
    const val = (r: MonthTable["rows"][number]) =>
      sort.key === "avg" ? r.averageOre : (r.values[sort.key] ?? null);
    return [...table.rows].sort((a, b) => {
      const av = val(a);
      const bv = val(b);
      if (av === null && bv === null) return a.code.localeCompare(b.code);
      if (av === null) return 1;
      if (bv === null) return -1;
      return sort.dir === "desc" ? bv - av : av - bv;
    });
  }, [table.rows, sort]);
  const by = (key: SortKey) =>
    setSort((s) => ({ key, dir: s.key === key && s.dir === "desc" ? "asc" : "desc" }));
  const ariaSort = (key: SortKey) =>
    sort.key === key ? (sort.dir === "desc" ? "descending" : "ascending") : undefined;
  const running = table.months.find((m) => m.running);
  // Telefon: hopfälld under rubriken (prototypens "Visa"), dator: öppen. Servern ritar den
  // öppen för alla; före hydreringen (toggled === null) döljer CSS innehållet på telefonen
  // (data-auto, money.css). Då hoppar inget efter hydreringen och tabellen öppnas aldrig
  // först för att sedan fällas ihop.
  const [toggled, setToggled] = useState<boolean | null>(null);
  const open = toggled ?? true;
  // Efter hydreringen på telefon: stäng den på riktigt (ser likadan ut, CSS döljde redan
  // innehållet), så att skärmläsaren säger "hopfälld" och "Visa" öppnar den som vanligt.
  // Stängningen ger ett toggle-event, och onToggle sparar läget (toggled = false).
  const ref = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (el && window.matchMedia(PHONE_QUERY).matches) el.open = false;
  }, []);

  return (
    <details
      ref={ref}
      className="v2-card g4-year"
      open={open}
      data-auto={toggled === null ? "" : undefined}
      onToggle={(e) => {
        if (e.currentTarget.open !== open) setToggled(e.currentTarget.open);
      }}
    >
      <summary className="v2-card-hd">
        <h2>Vinst per automat · kr per dag i tjänst, {table.months.length} mån</h2>
        <span className="g4-ysh">Visa</span>
        <div className="g4-xbtns">
          <DownloadLink className="v2-btn sm" href="/pengar/export" fallbackName="vinst-12-man.csv">
            Exportera (CSV)
          </DownloadLink>
        </div>
      </summary>
      <div className="g4-ywrap">
        <table className="g4-yt">
          <thead>
            <tr>
              <th scope="col">Automat</th>
              {table.months.map((m, i) => (
                <th key={m.month} scope="col" aria-sort={ariaSort(i)}>
                  <button type="button" onClick={() => by(i)}>
                    {monthShort(m.month)}
                    {m.running ? "*" : ""}
                  </button>
                </th>
              ))}
              <th scope="col" style={{ paddingRight: 18 }} aria-sort={ariaSort("avg")}>
                <button type="button" onClick={() => by("avg")}>
                  Snitt
                </button>
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.machineId}>
                <th scope="row">
                  <b>{r.name}</b>
                  <span className="id">{r.code}</span>
                </th>
                {r.values.map((v, i) => (
                  <td
                    key={table.months[i]!.month}
                    className={v === null ? "na" : table.months[i]!.running ? "now" : undefined}
                    style={
                      v === null
                        ? undefined
                        : ({ "--a": Math.max(0, Math.min(1, v / table.maxOre)) } as CSSProperties)
                    }
                  >
                    {cell(v)}
                  </td>
                ))}
                <td className="sum">{cell(r.averageOre)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr>
              <th scope="row">
                <b>Alla</b> <span className="id">snitt per automat</span>
              </th>
              {table.totals.map((v, i) => (
                <td key={table.months[i]!.month}>{cell(v)}</td>
              ))}
              <td className="sum">{cell(table.totalAverageOre)}</td>
            </tr>
          </tfoot>
        </table>
      </div>
      <p className="g4-yft">
        Alla rader i samma enhet: kr per automat och dag i tjänst, så att nya och gamla automater
        går att jämföra. Alla = alla automaters vinst delad med alla deras dagar i tjänst.
        {running ? ` * ${monthShort(running.month)} pågår.` : ""} Tryck på en rubrik för att
        sortera.
      </p>
    </details>
  );
}
