"use client";

import { NBSP, formatDelta, formatSek } from "@/lib/format";
import { motion } from "@/lib/tokens";
import type { Model } from "../model";
import { machines, storeById } from "../sample-data";
import {
  BorderSpecimen,
  ColorTable,
  DataRamp,
  MotionTimeline,
  RadiusSpecimen,
  SpacingSpecimen,
  TypeScale,
  colorTokenCount,
  durations,
  typeScale,
} from "../token-specimens";
import { contrast, resolveToken, type ThemeTokens } from "../tokens";
import { SpecSection, Sub } from "./section";

/** Lägsta kontrasten för text mot bakgrunden i ett läge (fg, muted, subtle, disabled). */
function minTextContrast(tokens: Record<string, string>): number {
  const bg = resolveToken(tokens, "--bl-bg");
  const all = ["--bl-fg", "--bl-fg-muted", "--bl-fg-subtle", "--bl-fg-disabled"].map(
    (t) => contrast(resolveToken(tokens, t), bg) ?? 0,
  );
  return Math.min(...all);
}

const oneDecimal = (r: number) => `${(Math.floor(r * 10) / 10).toFixed(1).replace(".", ",")}:1`;

export function ColorSection({ index, tokens }: { index: number; tokens: ThemeTokens }) {
  const darkMin = minTextContrast(tokens.dark);
  const lightMin = minTextContrast(tokens.light);
  return (
    <SpecSection
      id="farg"
      index={index}
      eyebrow="Färg och lägen"
      title="Gråskala och en signal."
      aside={`Lägsta textkontrast ${oneDecimal(Math.min(darkMin, lightMin))} mot bakgrunden.`}
      meta={[
        { label: "Tokens", value: `${colorTokenCount} st` },
        { label: "Text mörkt", value: `≥ ${oneDecimal(darkMin)}` },
        { label: "Text ljust", value: `≥ ${oneDecimal(lightMin)}` },
      ]}
    >
      <div className="lg:col-span-12">
        <ColorTable tokens={tokens} />
      </div>
      <Sub
        index={`${String(index).padStart(2, "0")}.1`}
        label="Dataskala"
        meta="6 steg"
        className="lg:col-span-8"
      >
        <DataRamp tokens={tokens} />
      </Sub>
      <Sub
        index={`${String(index).padStart(2, "0")}.2`}
        label="Signal"
        meta="1 färg"
        title="Bara för det som någon ska åtgärda."
        className="lg:col-span-4"
      >
        <ul className="flex flex-col text-sm text-muted">
          {[
            ["Tomt fack", "glyf, kant och nod"],
            ["Titel utan inköpspris", "glyf och text"],
            ["Fel som stoppar arbete", "glyf"],
          ].map(([k, v]) => (
            <li
              key={k}
              className="flex items-baseline justify-between gap-3 border-b border-line py-2"
            >
              <span className="text-fg">{k}</span>
              <span className="meta text-subtle">{v}</span>
            </li>
          ))}
          <li className="flex items-baseline justify-between gap-3 border-b border-line py-2">
            <span>Varning, t.ex. fyllnad under 20 %</span>
            <span className="meta text-subtle">fg, halvfet</span>
          </li>
          <li className="flex items-baseline justify-between gap-3 py-2">
            <span>Rekord, toppar, fokus, dekor</span>
            <span className="meta text-subtle">aldrig</span>
          </li>
        </ul>
      </Sub>
    </SpecSection>
  );
}

export function TypeSection({ index, model }: { index: number; model: Model }) {
  return (
    <SpecSection
      id="typografi"
      index={index}
      eyebrow="Typografi"
      title="Geist för ord och tal."
      aside={`Geist${NBSP}Mono för etiketter, id och tider. ${typeScale("").length} steg, minst 11${NBSP}px.`}
      space="tight"
    >
      <div className="lg:col-span-12">
        <TypeScale revenue={formatSek(model.t.revenue / 100)} />
      </div>
    </SpecSection>
  );
}

export function MeasureSection({ index, model }: { index: number; model: Model }) {
  const n = String(index).padStart(2, "0");
  const top = model.machines[0];
  const delta =
    model.prev && model.prev.revenue
      ? `${formatDelta(model.t.revenue / model.prev.revenue - 1, 1)} mot föregående`
      : "ingen jämförelse";
  const machine = top?.machine ?? machines[0];
  return (
    <SpecSection
      id="matt"
      index={index}
      eyebrow="Mått och rörelse"
      title={`8${NBSP}px-rytm och radier på 2, 4 och 6${NBSP}px.`}
      aside={`Övergångar ${motion.fast}–${motion.slow}${NBSP}ms, laddning i loop.`}
      space="tight"
    >
      <Sub index={`${n}.1`} label="Avstånd" meta="px" className="lg:col-span-7">
        <SpacingSpecimen value={formatSek(model.t.revenue / 100)} delta={delta} />
      </Sub>
      <div className="flex min-w-0 flex-col gap-12 lg:col-span-5">
        <Sub index={`${n}.2`} label="Radier" meta="4× förstorat">
          <RadiusSpecimen />
        </Sub>
        <Sub index={`${n}.3`} label="Kanter" meta="1 px">
          <BorderSpecimen
            row={{
              id: machine?.code ?? "",
              name: machine ? (storeById.get(machine.storeId)?.name ?? "") : "",
              value: formatSek((top?.totals.revenue ?? 0) / 100),
            }}
          />
        </Sub>
      </div>
      <Sub
        index={`${n}.4`}
        label="Rörelse"
        meta={`${durations.length} tider`}
        className="lg:col-span-12"
      >
        <MotionTimeline />
      </Sub>
    </SpecSection>
  );
}
