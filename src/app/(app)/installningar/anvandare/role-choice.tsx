"use client";

import { useId } from "react";

import type { MemberRole } from "@/db/schema";
import { cn } from "@/lib/cn";

import { ROLE_LABEL, ROLE_SUMMARY } from "./model";

/**
 * Rollval som radioknappar med en mening om vad rollen ser. Native radio i en
 * fieldset: piltangenter flyttar mellan alternativen, Tab går vidare.
 */
export function RoleChoice({
  roles,
  value,
  onChange,
  current,
  legend = "Roll",
}: {
  roles: readonly MemberRole[];
  value: MemberRole;
  onChange: (role: MemberRole) => void;
  /** Personens nuvarande roll (markeras). */
  current?: MemberRole;
  legend?: string;
}) {
  const name = useId();
  return (
    <fieldset className="flex min-w-0 flex-col gap-1.5">
      <legend className="label mb-1.5 text-muted">{legend}</legend>
      <div className="flex flex-col rounded-sm border border-line-control">
        {roles.map((role) => {
          const checked = role === value;
          return (
            <label
              key={role}
              className={cn(
                "flex cursor-pointer items-start gap-3 border-t border-line px-3 py-2.5 transition-colors first:border-t-0",
                checked ? "bg-hover" : "hover:bg-hover",
              )}
            >
              <input
                type="radio"
                name={name}
                value={role}
                checked={checked}
                onChange={() => onChange(role)}
                className="mt-0.5 size-4 shrink-0 accent-[var(--bl-fg)]"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-2 text-base text-fg">
                  {ROLE_LABEL[role]}
                  {current === role ? <span className="label text-subtle">Nuvarande</span> : null}
                </span>
                <span className="text-sm text-muted">{ROLE_SUMMARY[role]}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
