"use client";

/**
 * Plan för fler automater: fyra stora siffror (vinst, kostnad, återbetalning, vid målet),
 * tidslinjen månad för månad, arbetstiden och inköpen vid målet och en lista med nästa
 * steg. Allt räknat på servern (growthPlan); här bara visning och förvalsdialogen.
 */

import Link from "next/link";
import { useState } from "react";

import type { GrowthPlan } from "@/analytics/expansion";
import { Button } from "@/components/ui/button";
import { CountUp } from "@/components/ui/count-up";
import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";
import { roundHalfUp } from "@/domain/money";

import { saveGrowthPlan } from "../actions";
import {
  hoursText,
  kr,
  monthLabel,
  oreToInput,
  paybackShort,
  refillWarning,
  tenths,
} from "../_lib/display";
import type { GrowthPlanRecord } from "../_lib/service";
import { FormModal, type FieldSpec } from "./form-kit";

export interface PlanLead {
  readonly id: string;
  readonly name: string;
  readonly stageLabel: string;
  /** Avtal eller möte: redo att starta Ny butik. */
  readonly ready: boolean;
}

/** 'ÅÅÅÅ-MM' → "dec." / "jan. 2027" (kort, för staplarna). */
function shortMonth(month: string, first: boolean): string {
  const [y, m] = month.split("-").map(Number) as [number, number];
  const name = new Date(y, m - 1, 1).toLocaleDateString("sv-SE", { month: "short" });
  return first || m === 1 ? `${name} ${String(y).slice(2)}` : name;
}

function Stat({
  label,
  value,
  unit,
  sub,
  i,
  tone,
  text,
}: {
  label: string;
  value: number | null;
  unit: string;
  /** Färdig text i stället för en siffra som räknar upp. */
  text?: string;
  sub?: string;
  i: number;
  tone?: "signal";
}) {
  return (
    <article
      className="rise lift flex min-w-0 flex-col gap-2 rounded-md border border-line bg-surface p-4 md:p-5"
      style={{ "--i": i } as React.CSSProperties}
    >
      <h3 className="label truncate text-muted">{label}</h3>
      <p className={cn("tnum text-2xl font-medium", tone === "signal" && "text-signal-fg")}>
        {text !== undefined ? (
          text
        ) : value === null ? (
          "–"
        ) : (
          <>
            <CountUp id={label} value={value} format={formatInt} />
            {unit ? `${NBSP}${unit}` : null}
          </>
        )}
      </p>
      {sub ? <p className="text-sm text-muted">{sub}</p> : null}
    </article>
  );
}

const PLAN_FIELDS: FieldSpec[] = [
  { name: "targetMachines", label: "Mål", type: "integer", suffix: "automater", required: true },
  { name: "machinesPerMonth", label: "Nya per månad", type: "integer", suffix: "st" },
  { name: "machinePriceOre", label: "Automat inkl. installation", type: "decimal", suffix: "kr" },
  { name: "startStockOre", label: "Startlager", type: "decimal", suffix: "kr" },
  {
    name: "refillMinutesPerMachineWeek",
    label: "Påfyllning per automat och vecka",
    type: "integer",
    suffix: "min",
    hint: "Med resa. T.ex. 45.",
  },
  { name: "people", label: "Personer", type: "integer", suffix: "st", required: true },
  {
    name: "hoursPerPersonWeek",
    label: "Tid var",
    type: "integer",
    suffix: "h/vecka",
    required: true,
  },
];

function PlanSettings({
  saved,
  plan,
  open,
  setOpen,
}: {
  saved: GrowthPlanRecord;
  plan: GrowthPlan;
  open: boolean;
  setOpen: (open: boolean) => void;
}) {
  const opt = (v: number | null) => (v === null ? "" : String(v));
  const fields = PLAN_FIELDS.map((f) => {
    const placeholder =
      f.name === "machinesPerMonth"
        ? String(plan.perMonth)
        : f.name === "machinePriceOre"
          ? plan.machinePriceSource === "data" && plan.machinePriceOre !== null
            ? oreToInput(plan.machinePriceOre)
            : undefined
          : f.name === "startStockOre"
            ? plan.startStockSource === "data" && plan.startStockOre !== null
              ? oreToInput(plan.startStockOre)
              : undefined
            : f.name === "refillMinutesPerMachineWeek"
              ? String(plan.refillMinutesPerMachineWeek)
              : undefined;
    return { ...f, placeholder };
  });
  return (
    <>
      <Button type="button" size="sm" variant="secondary" onClick={() => setOpen(true)}>
        Ändra plan
      </Button>
      <FormModal
        open={open}
        onClose={() => setOpen(false)}
        title="Ändra plan"
        description="Tomt fält = förval."
        fields={fields}
        initial={{
          targetMachines: String(saved.targetMachines),
          machinesPerMonth: opt(saved.machinesPerMonth),
          machinePriceOre: saved.machinePriceOre === null ? "" : oreToInput(saved.machinePriceOre),
          startStockOre: saved.startStockOre === null ? "" : oreToInput(saved.startStockOre),
          refillMinutesPerMachineWeek: opt(saved.refillMinutesPerMachineWeek),
          people: String(saved.people),
          hoursPerPersonWeek: String(saved.hoursPerPersonWeek),
        }}
        action={saveGrowthPlan}
        success="Planen är sparad"
      />
    </>
  );
}

export function PlanView({
  plan,
  saved,
  canEdit,
  leads,
  openLeads,
  pipelineHref,
  refillMeasurement,
}: {
  plan: GrowthPlan;
  saved: GrowthPlanRecord;
  canEdit: boolean;
  leads: readonly PlanLead[];
  openLeads: number;
  pipelineHref: string;
  /** Påfyllningstiden på Effekt (minuter per månad), för varningen när den är orimlig. */
  refillMeasurement?: { readonly month: string; readonly minutesPerMonth: number } | null;
}) {
  const [editing, setEditing] = useState(false);
  const p = plan.profitPerMonthOre;
  const krN = (ore: number | null) => (ore === null ? null : roundHalfUp(ore, 100));
  const maxMachines = Math.max(plan.target, plan.machinesNow, 1);
  const missingLeads = Math.max(0, plan.toAdd - openLeads);
  const ready = leads.filter((l) => l.ready);

  const steps: { key: string; text: string; href?: string; cta?: string; signal?: boolean }[] = [];
  for (const l of ready.slice(0, 3)) {
    steps.push({
      key: `lead-${l.id}`,
      text: `${l.name}: ${l.stageLabel.toLowerCase()}.`,
      href: `/butiker/ny?plats=${encodeURIComponent(l.id)}`,
      cta: "Lägg till ny butik",
    });
  }
  if (missingLeads > 0) {
    steps.push({
      key: "leads",
      text: `Hitta ${formatInt(missingLeads)} ${missingLeads === 1 ? "plats" : "platser"} till.`,
      href: pipelineHref,
      cta: "Nya platser",
    });
  }
  if (plan.helpFrom !== null && plan.helpFrom <= plan.machinesNow + plan.perMonth * 3) {
    steps.push({
      key: "help",
      text: `Ta in hjälp innan automat ${formatInt(plan.helpFrom)}.`,
      signal: true,
    });
  }
  if (plan.capitalPerMachineOre === null) {
    steps.push({ key: "price", text: "Ange vad en automat kostar." });
  }
  // Ett för högt värde står en gång, i kortet Antagande (med var det rättas), inte här igen.
  const refillWarn = refillWarning({
    ignored: plan.refillIgnored,
    usedMinutes: plan.refillMinutesPerMachineWeek,
    measurement: refillMeasurement ?? null,
  });
  if (!plan.refillIgnored && plan.refillSource === "default") {
    steps.push({
      key: "refill",
      text: "Mät påfyllningstiden en månad.",
      href: "/effekt",
      cta: "Effekt",
    });
  }

  return (
    <div className="flex flex-col gap-10">
      <section aria-label="Per ny automat" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 className="text-md font-medium text-fg">Per ny automat</h2>
          {canEdit ? (
            <PlanSettings saved={saved} plan={plan} open={editing} setOpen={setEditing} />
          ) : null}
        </div>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-4">
          <Stat
            i={1}
            label="Vinst per månad"
            value={krN(p?.median ?? null)}
            unit="kr"
            sub={
              p
                ? plan.basis.machineIds.length > 1
                  ? `${kr(p.low)}–${kr(p.high)} · ${formatInt(plan.basis.machineIds.length)} automater`
                  : "1 automat"
                : "Ingen försäljning än"
            }
          />
          <Stat
            i={2}
            label="Kostar"
            value={krN(plan.capitalPerMachineOre)}
            unit="kr"
            sub={
              plan.machinePriceOre === null
                ? "Pris saknas"
                : `Automat ${kr(plan.machinePriceOre)} + lager ${kr(plan.startStockOre ?? 0)}`
            }
          />
          <Stat
            i={3}
            label="Betalar sig på"
            value={null}
            unit=""
            text={paybackShort(plan.paybackTenths.median)}
            sub={
              plan.paybackTenths.fastest !== null
                ? plan.paybackTenths.slowest === null
                  ? `Snabbast ${paybackShort(plan.paybackTenths.fastest)}`
                  : `${tenths(plan.paybackTenths.fastest)}–${paybackShort(plan.paybackTenths.slowest)}`
                : undefined
            }
          />
          <Stat
            i={4}
            label={`Vinst/mån vid ${formatInt(plan.atTarget.machines)}`}
            value={krN(plan.atTarget.profitPerMonthOre)}
            unit="kr"
            sub={
              plan.atTarget.capitalOre !== null && plan.toAdd > 0
                ? `Kapital ${kr(plan.atTarget.capitalOre)}`
                : undefined
            }
          />
        </div>
      </section>

      {plan.timeline.length > 0 ? (
        <section
          aria-labelledby="tidslinje-h"
          className="rise flex flex-col gap-4"
          style={{ "--i": 5 } as React.CSSProperties}
        >
          <h2 id="tidslinje-h" className="text-md font-medium text-fg">
            Tidslinje
          </h2>
          <div className="overflow-x-auto rounded-md border border-line bg-surface p-4 md:p-5">
            <ol
              className="flex h-40 min-w-max items-end gap-1.5 sm:min-w-0"
              aria-label="Automater per månad"
            >
              <li className="flex h-full w-11 flex-col items-center justify-end gap-1 sm:w-auto sm:flex-1">
                <span className="tnum text-xs text-muted">{formatInt(plan.machinesNow)}</span>
                <span
                  className="grow-y w-full rounded-t-xs bg-line-strong"
                  style={{ height: `${(plan.machinesNow / maxMachines) * 100}%`, minHeight: 2 }}
                  aria-hidden
                />
                <span className="text-xs text-subtle">Nu</span>
              </li>
              {plan.timeline.map((t, i) => (
                <li
                  key={t.month}
                  className="flex h-full w-11 flex-col items-center justify-end gap-1 sm:w-auto sm:flex-1"
                  title={`${monthLabel(t.month)}: ${formatInt(t.machines)} automater, ${hoursText(t.minutesPerPersonWeek)}/vecka var`}
                >
                  <span className="tnum text-xs text-muted">{formatInt(t.machines)}</span>
                  <span
                    className={cn(
                      "grow-y w-full rounded-t-xs",
                      t.needsHelp ? "bg-signal" : "bg-fg",
                    )}
                    style={
                      {
                        height: `${(t.machines / maxMachines) * 100}%`,
                        "--i": i + 1,
                      } as React.CSSProperties
                    }
                    aria-hidden
                  />
                  <span className="text-xs whitespace-nowrap text-subtle">
                    {shortMonth(t.month, i === 0)}
                  </span>
                </li>
              ))}
            </ol>
            {plan.helpMonth ? (
              <p className="mt-3 flex items-center gap-2 text-sm text-muted">
                <span aria-hidden className="inline-block size-2.5 rounded-xs bg-signal" />
                Hjälp behövs
              </p>
            ) : null}
          </div>
          <ul className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <Fact
              label="Pengar"
              text={
                plan.capitalPerMachineOre === null
                  ? "Ange automatpriset."
                  : plan.peakFundingOre > 0
                    ? `Mest ute: ${kr(plan.peakFundingOre)} (${monthLabel(plan.peakFundingMonth!)}).`
                    : "Vinsten räcker hela vägen."
              }
              sub={
                plan.cashPositiveMonth
                  ? `Plus igen ${monthLabel(plan.cashPositiveMonth)}.`
                  : undefined
              }
            />
            <Fact
              label="Utan lån"
              text={
                plan.selfFundedTargetMonth
                  ? `${formatInt(plan.target)} automater ${monthLabel(plan.selfFundedTargetMonth)}.`
                  : "Går inte att räkna än."
              }
              sub="Köp när vinsten räcker."
            />
            <Fact
              label="Arbete"
              text={`Vid ${formatInt(plan.atTarget.machines)}: ${hoursText(plan.atTarget.minutesPerPersonWeek)}/vecka var.`}
              sub={
                plan.helpFrom === null
                  ? `Ni hinner (${formatInt(plan.people)} × ${formatInt(plan.hoursPerPersonWeek)}${NBSP}h).`
                  : `Hjälp från automat ${formatInt(plan.helpFrom)}${plan.helpMonth ? ` (${monthLabel(plan.helpMonth)})` : ""}. ${formatInt(plan.atTarget.peopleNeeded)} personer behövs.`
              }
              signal={plan.helpFrom !== null}
            />
          </ul>
        </section>
      ) : null}

      <ul aria-label="Inköp och påfyllning" className="grid grid-cols-1 gap-3 md:grid-cols-2">
        <Fact
          label={`Inköp vid ${formatInt(plan.atTarget.machines)}`}
          text={
            plan.atTarget.packsPerMonth === null
              ? "Ingen försäljning än."
              : `${formatInt(plan.atTarget.packsPerMonth)} pack, ${kr(plan.atTarget.purchasePerMonthOre ?? 0)} per månad.`
          }
          sub={
            plan.packsPerMonth === null
              ? undefined
              : `${formatInt(plan.packsPerMonth)} pack per automat.`
          }
        />
        <li className="lift flex list-none flex-col gap-1.5 rounded-md border border-line bg-surface p-4">
          <span className="label text-muted">Antagande</span>
          <span className="flex flex-wrap items-baseline justify-between gap-2">
            <span className="text-base font-medium text-fg">
              {formatInt(plan.refillMinutesPerMachineWeek)}
              {NBSP}min per automat och vecka
            </span>
            {canEdit ? (
              <button
                type="button"
                onClick={() => setEditing(true)}
                className="rounded-xs text-sm text-fg underline underline-offset-4 hover:text-muted max-md:tap"
              >
                Ändra
              </button>
            ) : null}
          </span>
          {refillWarn ? (
            <span className="text-sm text-signal-fg">
              {refillWarn.text}{" "}
              {refillWarn.href ? (
                <Link href={refillWarn.href} className="font-medium underline underline-offset-4">
                  {refillWarn.cta}
                  {NBSP}→
                </Link>
              ) : null}
            </span>
          ) : (
            <span className="text-sm text-muted">
              {plan.refillSource === "data"
                ? "Från er mätning."
                : plan.refillSource === "saved"
                  ? "Ert värde."
                  : "Förval."}
            </span>
          )}
        </li>
      </ul>

      {steps.length > 0 ? (
        <section aria-labelledby="nasta-h" className="flex flex-col gap-3">
          <h2 id="nasta-h" className="text-md font-medium text-fg">
            Nästa steg
          </h2>
          <ol className="flex flex-col divide-y divide-line rounded-md border border-line bg-surface">
            {steps.map((s, i) => (
              <li
                key={s.key}
                className="rise flex flex-wrap items-center justify-between gap-3 px-4 py-3"
                style={{ "--i": i } as React.CSSProperties}
              >
                <span className={cn("text-base", s.signal ? "text-signal-fg" : "text-fg")}>
                  {s.text}
                </span>
                {s.href && s.cta ? (
                  <Link
                    href={s.href}
                    className="inline-flex h-9 items-center rounded-sm border border-line-strong bg-surface px-3.5 text-sm font-medium text-fg transition-colors duration-fast ease-instrument hover:border-line-control hover:bg-hover max-md:min-h-11"
                  >
                    {s.cta}
                  </Link>
                ) : null}
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

function Fact({
  label,
  text,
  sub,
  signal,
}: {
  label: string;
  text: string;
  sub?: string;
  signal?: boolean;
}) {
  return (
    <li className="lift flex list-none flex-col gap-1.5 rounded-md border border-line bg-surface p-4">
      <span className="label text-muted">{label}</span>
      <span className="text-base font-medium text-fg">{text}</span>
      {sub ? (
        <span className={cn("text-sm", signal ? "text-signal-fg" : "text-muted")}>{sub}</span>
      ) : null}
    </li>
  );
}
