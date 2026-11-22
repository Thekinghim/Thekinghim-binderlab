"use client";

import { useId } from "react";

import type { MemberRole } from "@/db/schema";
import { Badge } from "@/components/v2/badge";
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
      <legend className="mb-1.5 text-v2-sm font-[550] text-v2-ink">{legend}</legend>
      <div className="flex flex-col overflow-hidden rounded-v2 border border-v2-line">
        {roles.map((role) => {
          const checked = role === value;
          return (
            <label
              key={role}
              className={cn(
                "flex cursor-pointer items-start gap-3 border-t border-v2-line2 px-3 py-2.5 transition-colors first:border-t-0",
                checked ? "bg-v2-hover" : "hover:bg-v2-hover",
              )}
            >
              <input
                type="radio"
                name={name}
                value={role}
                checked={checked}
                onChange={() => onChange(role)}
                className="mt-0.5 size-4 shrink-0 accent-[var(--v2-ink)]"
              />
              <span className="flex min-w-0 flex-col gap-0.5">
                <span className="flex items-center gap-2 text-v2-md font-[550] text-v2-ink">
                  {ROLE_LABEL[role]}
                  {current === role ? <Badge>Nuvarande</Badge> : null}
                </span>
                <span className="text-v2-sm text-v2-mute">{ROLE_SUMMARY[role]}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}
