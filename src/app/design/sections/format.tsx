"use client";

import { Fragment, useState } from "react";
import { Segmented } from "@/components/ui/segmented";
import {
  EN_DASH,
  MINUS,
  NBSP,
  formatDateTime,
  formatKronor,
  formatPercent,
  formatPeriodShort,
  formatSignedKronor,
} from "@/lib/format";
import { REF_NOW } from "../sample-data";
import { SpecSection } from "./section";

const d = (y: number, m: number, day: number, h = 0, min = 0) => new Date(y, m - 1, day, h, min);

/**
 * Formateringsreglerna som före/efter i produkttext. "Efter" kommer ur
 * src/lib/format.ts, så att raden visar exakt det panelen, rapporten och
 * mejlet skriver. Funktionerna och deras indata står i docs/design.md.
 */
const rules: ReadonlyArray<{ name: string; rule: string; before: string; after: string }> = [
  {
    name: "Hårt mellanslag",
    rule: "Mellan tal och enhet och som tusentalsavgränsare. Ett belopp bryts aldrig.",
    before: "79987 kr",
    after: formatKronor(79_987),
  },
  {
    name: "Minustecken",
    rule: "Lika brett som plus, så att kolumner linjerar. Bindestreck bara i CSV.",
    before: "-1240 kr",
    after: formatSignedKronor(-1240),
  },
  {
    name: "Tankstreck",
    rule: "I intervall, tätt mellan enkla led.",
    before: "3-30 nov",
    after: formatPeriodShort({ start: d(2026, 11, 3), end: d(2026, 11, 30) }, REF_NOW),
  },
  {
    name: "Datum och tid",
    rule: "Dag och förkortad månad med punkt. Året bara när det inte är i år.",
    before: "2026-11-01 17:17",
    after: formatDateTime(d(2026, 11, 1, 17, 17), { now: REF_NOW }),
  },
  {
    name: "Procentenheter",
    rule: "Förändring i en andel skrivs i procentenheter, med en decimal.",
    before: "-0,3 %",
    after: `${MINUS}0,3${NBSP}p.e.`,
  },
  {
    name: "Saknat värde",
    rule: "Ett tankstreck, aldrig 0 eller NaN.",
    before: "NaN %",
    after: formatPercent(NaN),
  },
];

/** Antal regler (för innehållsindexet). */
export const FORMAT_RULE_COUNT = rules.length;

/** Skriver ut tecken och gör de typografiskt viktiga synliga i läget "Tecken". */
function Glyphs({ text, reveal }: { text: string; reveal: boolean }) {
  if (!reveal) return <>{text}</>;
  return (
    <>
      {Array.from(text).map((ch, i) => {
        if (ch === NBSP) {
          return (
            <span key={i} className="text-subtle" title="Hårt mellanslag">
              ·
            </span>
          );
        }
        if (ch === MINUS || ch === EN_DASH) {
          return (
            <span
              key={i}
              className="rounded-xs bg-hover text-fg"
              title={ch === MINUS ? "Minustecken" : "Tankstreck"}
            >
              {ch}
            </span>
          );
        }
        return <Fragment key={i}>{ch}</Fragment>;
      })}
    </>
  );
}

type Mode = "text" | "tecken";

export function FormatSection({ index }: { index: number }) {
  const [mode, setMode] = useState<Mode>("text");
  const reveal = mode === "tecken";

  return (
    <SpecSection
      id="formatering"
      index={index}
      eyebrow="Formatering"
      title="Alla tal formateras på ett ställe."
      aside={`${rules.length} regler, samma utdata i panel, rapport och mejl.`}
      space="tight"
      actions={
        <Segmented<Mode>
          label="Visning"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "text", label: "Text" },
            { value: "tecken", label: "Visa tecken" },
          ]}
        />
      }
    >
      <table className="w-full border-collapse text-left lg:col-span-12">
        <caption className="sr-only">
          Formateringsregler med ett felaktigt och ett korrekt exempel
        </caption>
        <thead>
          <tr className="border-b border-line-strong">
            <th scope="col" className="label py-2 pr-4 font-normal text-subtle">
              Regel
            </th>
            <th
              scope="col"
              className="label hidden py-2 pr-4 text-right font-normal text-subtle sm:table-cell"
            >
              Inte
            </th>
            <th scope="col" className="label py-2 text-right font-normal text-subtle">
              Så
            </th>
          </tr>
        </thead>
        <tbody>
          {rules.map((r) => (
            <tr key={r.name} className="border-b border-line">
              <th scope="row" className="py-3 pr-4 align-baseline font-normal">
                <span className="block text-base text-fg">{r.name}</span>
                <span className="mt-0.5 block max-w-md text-sm text-subtle">{r.rule}</span>
              </th>
              <td className="tnum hidden py-3 pr-4 text-right align-baseline text-md whitespace-nowrap text-subtle line-through decoration-line-control sm:table-cell">
                {r.before}
              </td>
              <td className="tnum py-3 text-right align-baseline text-md whitespace-nowrap text-fg">
                <Glyphs text={r.after} reveal={reveal} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </SpecSection>
  );
}
