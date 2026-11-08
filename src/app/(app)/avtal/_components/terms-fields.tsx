"use client";

import { useId, useState } from "react";

import { Input } from "@/components/ui/field";
import { Segmented } from "@/components/ui/segmented";
import { cn } from "@/lib/cn";
import { CONTRACT_PRESETS } from "@/reports/contract-pdf";

import { SPECIAL_TERMS_MAX } from "../../butiker/_lib/validation";
import { PRESET_ORDER, presetDraft, type TermsDraft } from "../_lib/terms";
import { VmbBeforeSplitCheckbox } from "./vmb-before-split";

/**
 * Kontraktets villkor i ett steg: tre snabbval överst, sedan andel, av vad, hyra och vid
 * förlust. Under "Fler val": VMB före delning och Särskilda villkor (står i PDF:en).
 * Samma fält i Skapa kontrakt och Ny butik.
 */
export function TermsFields({
  value,
  onChange,
  error,
}: {
  value: TermsDraft;
  onChange: (next: TermsDraft) => void;
  /** Fel från kontrollen (checkTerms), på rätt fält. */
  error?: { message: string; field: "share" | "rent" | "special" };
}) {
  const id = useId();
  const [more, setMore] = useState(value.vmb || value.special !== "");
  const set = (patch: Partial<TermsDraft>) => onChange({ ...value, ...patch });
  const split = value.base === "profit_after_costs" && value.share.trim() !== "";

  return (
    <div className="flex flex-col gap-5">
      <div
        role="radiogroup"
        aria-label="Snabbval"
        className="grid grid-cols-1 gap-2 sm:grid-cols-3"
      >
        {PRESET_ORDER.map((p) => {
          const on = value.preset === p;
          return (
            <button
              key={p}
              type="button"
              role="radio"
              aria-checked={on}
              onClick={() => onChange(presetDraft(p, value))}
              className={cn(
                "min-h-11 rounded-md border px-3 py-2 text-base font-medium transition-[border-color,background-color,transform] duration-fast ease-instrument active:scale-[0.98]",
                on ? "border-fg bg-hover text-fg" : "border-line-control text-muted hover:bg-hover",
              )}
            >
              {CONTRACT_PRESETS[p].label}
            </button>
          );
        })}
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <Input
          label="Butikens andel"
          inputMode="decimal"
          suffix="%"
          value={value.share}
          placeholder="Ingen"
          onChange={(e) => set({ share: e.target.value })}
          error={error?.field === "share" ? error.message : undefined}
        />
        <Input
          label="Fast hyra"
          inputMode="decimal"
          suffix="kr/mån"
          value={value.rent}
          placeholder="Ingen"
          onChange={(e) => set({ rent: e.target.value })}
          error={error?.field === "rent" ? error.message : undefined}
        />
      </div>

      {value.share.trim() !== "" ? (
        <div className="fade-in flex flex-col gap-1.5">
          <span className="label text-muted">Av vad</span>
          <Segmented
            label="Av vad"
            value={value.base}
            onChange={(base) => set({ base })}
            options={[
              // Korta namn: båda ska synas på en iPhone SE utan att rutan skrollar i sidled.
              { value: "profit_after_costs", label: "Vinsten" },
              { value: "net_excl_vat", label: "Omsättning ex. moms" },
            ]}
          />
        </div>
      ) : null}

      {split ? (
        <div className="fade-in flex flex-col gap-1.5">
          <span className="label text-muted">Vid förlust</span>
          <Segmented
            label="Vid förlust"
            value={value.loss}
            onChange={(loss) => set({ loss })}
            options={[
              { value: "zero", label: "Butiken får 0" },
              { value: "proportional", label: "Delar förlusten" },
            ]}
          />
        </div>
      ) : null}

      <div className="flex flex-col gap-4">
        <button
          type="button"
          aria-expanded={more}
          aria-controls={`${id}-mer`}
          onClick={() => setMore(!more)}
          className="label inline-flex w-fit items-center gap-1.5 rounded-xs text-subtle hover:text-fg max-md:tap"
        >
          <span
            aria-hidden
            className={cn("inline-block transition-transform duration-fast", more && "rotate-90")}
          >
            ›
          </span>
          Fler val
        </button>
        {more ? (
          <div id={`${id}-mer`} className="fade-in flex flex-col gap-4">
            {split ? (
              <VmbBeforeSplitCheckbox
                id={`${id}-vmb`}
                checked={value.vmb}
                onChange={(vmb) => set({ vmb })}
              />
            ) : null}
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${id}-sv`} className="label text-muted">
                Särskilda villkor
              </label>
              <textarea
                id={`${id}-sv`}
                rows={3}
                maxLength={SPECIAL_TERMS_MAX}
                value={value.special}
                onChange={(e) => onChange({ ...value, special: e.target.value })}
                placeholder="Står i kontraktet."
                aria-invalid={error?.field === "special" ? true : undefined}
                className={cn(
                  "w-full min-w-0 rounded-sm border bg-bg px-3 py-2 text-base text-fg placeholder:text-subtle",
                  error?.field === "special" ? "border-signal" : "border-line-control",
                )}
              />
              {error?.field === "special" ? (
                <p className="text-xs text-signal-fg">{error.message}</p>
              ) : null}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
