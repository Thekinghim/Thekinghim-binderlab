"use client";

import { useState, type CSSProperties } from "react";

import { Card } from "@/components/v2/card";
import { Segmented } from "@/components/v2/segmented";
import type { CityProfit } from "@/server/data/v2/analytics/money-model";

import { kr, signedPct } from "./fmt";

type Mode = "per" | "total";

/**
 * Vinst per stad (prototypens .cityl): en rad per stad med stapel, vinst per automat eller
 * totalt och förändringen; raden fälls ut till stadens automater.
 */
export function CityList({ cities, days }: { cities: readonly CityProfit[]; days: string }) {
  const [mode, setMode] = useState<Mode>("per");
  const value = (c: CityProfit) => (mode === "per" ? c.perMachineOre : c.totalOre);
  const max = Math.max(1, ...cities.map((c) => Math.max(0, value(c))));
  return (
    <Card
      title={`Vinst per stad · ${days}`}
      actions={
        <Segmented<Mode>
          ariaLabel="Visa vinst"
          value={mode}
          onChange={setMode}
          options={[
            { value: "per", label: "Per automat" },
            { value: "total", label: "Totalt" },
          ]}
        />
      }
      className="g4-city"
    >
      <div>
        {cities.map((c, i) => (
          <details key={c.city}>
            <summary className="cr">
              <span className="cn">
                {c.city} <small>{c.machines} st</small>
              </span>
              <span className="cb" aria-hidden="true">
                <i
                  style={
                    {
                      "--i": i,
                      width: `${(Math.max(0, value(c)) / max) * 100}%`,
                    } as CSSProperties
                  }
                />
              </span>
              <span className="cv">
                {kr(value(c))}
                {mode === "per" ? <small>/automat</small> : null}
              </span>
              <span className={c.deltaBp === null ? "ct" : c.deltaBp >= 0 ? "ct up" : "ct dn"}>
                {c.deltaBp === null ? "" : signedPct(c.deltaBp)}
              </span>
            </summary>
            <div className="cms">
              {c.items.map((m) => (
                <div key={m.machineId} className="cm">
                  <span>
                    {m.name} {m.code ? <span className="id">{m.code}</span> : null}
                  </span>
                  <span className="tnum">{kr(m.profitOre)}</span>
                </div>
              ))}
            </div>
          </details>
        ))}
      </div>
    </Card>
  );
}
