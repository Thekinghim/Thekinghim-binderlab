"use client";

import { useState } from "react";

/** Rubriken på avtalets val, samma i Skapa avtal, avtalsformuläret och butiksrapporten. */
export const VMB_BEFORE_SPLIT_LABEL = "Dra av VMB-moms före delning";

/**
 * Avtalets val "Dra av VMB-moms före delning" (store_agreements.vmb_before_split), standard
 * av. På:
 * butikens andel räknas på vinsten efter VMB-moms. Av: på vinsten före VMB-moms.
 */
export function VmbBeforeSplitCheckbox({
  id,
  checked,
  onChange,
  name,
}: {
  id: string;
  checked?: boolean;
  onChange?: (checked: boolean) => void;
  /** Formulärfält (okontrollerat läge med `defaultChecked`). */
  name?: string;
}) {
  const controlled = onChange !== undefined;
  // Okontrollerat läge: förklaringen följer rutan.
  const [local, setLocal] = useState(checked ?? false);
  const on = controlled ? (checked ?? false) : local;
  return (
    <div className="flex items-start gap-3">
      <input
        id={id}
        type="checkbox"
        name={name}
        {...(controlled
          ? { checked: checked ?? false, onChange: (e) => onChange(e.target.checked) }
          : { defaultChecked: checked ?? false, onChange: (e) => setLocal(e.target.checked) })}
        aria-describedby={`${id}-hint`}
        className="mt-0.5 size-4 shrink-0 accent-current"
      />
      <div className="flex flex-col gap-0.5">
        <label htmlFor={id} className="text-base text-fg">
          {VMB_BEFORE_SPLIT_LABEL}
        </label>
        <p id={`${id}-hint`} className="text-sm text-muted">
          {on ? "Andelen räknas efter VMB-moms." : "Andelen räknas före VMB-moms."}
        </p>
      </div>
    </div>
  );
}

/**
 * Samma val bakom en stängd "Fler val" (sällan ändrat). Öppen från början när valet är på,
 * så att ett avvikande avtal syns. Fältet skickas med formuläret även när rutan är stängd.
 */
export function VmbBeforeSplitMore({
  id,
  checked,
  name,
}: {
  id: string;
  checked?: boolean;
  name: string;
}) {
  return (
    <details open={checked ? true : undefined} className="group">
      <summary className="label inline-flex w-fit cursor-pointer list-none items-center gap-1.5 rounded-xs text-subtle hover:text-fg max-md:tap [&::-webkit-details-marker]:hidden">
        <span
          aria-hidden
          className="inline-block transition-transform duration-fast group-open:rotate-90"
        >
          ›
        </span>
        Fler val
      </summary>
      <div className="fade-in mt-3">
        <VmbBeforeSplitCheckbox id={id} name={name} checked={checked} />
      </div>
    </details>
  );
}
