"use client";

import { useState, type CSSProperties } from "react";

import { Card } from "@/components/v2/card";
import { Segmented } from "@/components/v2/segmented";
import { usePhone } from "@/components/v2/use-media";
import { formatInt, NBSP } from "@/lib/format";

import type { GeoCard } from "./cards-data";

const kr = (ore: number) => `${formatInt(Math.round(ore / 100))}${NBSP}kr`;

type By = "stad" | "automat";

/**
 * Vinst per stad eller per automat (Analys): topp 10 (5 på telefon), resten bakom "Visa alla".
 * Staplarna är vinsten mot den största raden; andelen är av all vinst i perioden.
 */
export function GeoBody({ data }: { data: GeoCard }) {
  const phone = usePhone();
  const [by, setBy] = useState<By>("stad");
  const [all, setAll] = useState(false);
  const rows =
    by === "stad"
      ? data.cities.map((c) => ({
          key: c.city,
          name: c.city,
          sub: `${formatInt(c.machines)} st · ${kr(c.perMachineOre)}/st`,
          value: c.profitOre,
          shareBp: c.shareBp,
        }))
      : data.machines.map((m) => ({
          key: m.machineId,
          name: m.name,
          sub: [m.code, m.city].filter(Boolean).join(" · "),
          value: m.profitOre,
          shareBp: data.totalOre > 0 ? Math.round((m.profitOre * 10_000) / data.totalOre) : 0,
        }));
  const limit = phone ? 5 : 10;
  const shown = all ? rows : rows.slice(0, limit);
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <Card
      className="x-c x-geo"
      title={`Vinst per ${by === "stad" ? "stad" : "automat"}`}
      actions={
        <Segmented
          options={[
            { value: "stad", label: "Stad" },
            { value: "automat", label: "Automat" },
          ]}
          value={by}
          onChange={(v) => {
            setBy(v);
            setAll(false);
          }}
          ariaLabel="Visa per"
        />
      }
    >
      <div className="x-b">
        <div className="x-bl2">
          {shown.map((r, i) => (
            <div className="x-br" key={r.key}>
              <span className="x-bn">
                <b>{r.name}</b>
                <small>{r.sub}</small>
              </span>
              <span className="x-bt" aria-hidden="true">
                <i
                  style={
                    {
                      width: `${(Math.max(0, r.value) / max) * 100}%`,
                      "--i": i,
                    } as CSSProperties
                  }
                />
              </span>
              <span className="x-bv">{kr(r.value)}</span>
              <span className="x-bp">
                {Math.round(r.shareBp / 100)}
                {NBSP}%
              </span>
            </div>
          ))}
        </div>
        {rows.length > limit ? (
          <button
            type="button"
            className="x-more"
            onClick={() => setAll((v) => !v)}
            aria-expanded={all}
          >
            {all ? "Visa färre" : `Visa alla ${formatInt(rows.length)}`}
          </button>
        ) : null}
        <div className="x-ft">
          <span>Totalt {kr(data.totalOre)}</span>
          <span>Snitt {kr(data.perMachineOre)} per automat</span>
        </div>
      </div>
    </Card>
  );
}
