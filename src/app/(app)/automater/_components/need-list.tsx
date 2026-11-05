import Link from "next/link";
import type { CSSProperties } from "react";

import { StatusTag } from "@/components/ui/status-tag";
import { cn } from "@/lib/cn";

import type { MachineNeed } from "../_lib/model";

/** Listan överst på Automater: en rad per automat som behöver något, med en knapp. */
export function NeedList({ needs }: { needs: readonly MachineNeed[] }) {
  if (needs.length === 0) return null;
  return (
    <ul aria-label="Att göra" className="flex flex-col divide-y divide-line border-y border-line">
      {needs.map((n, i) => (
        <li
          key={n.id}
          className="rise flex items-center gap-4 py-3"
          style={{ "--i": Math.min(i + 1, 12) } as CSSProperties}
        >
          <span className="flex min-w-0 flex-1 flex-col gap-1 sm:flex-row sm:items-center sm:gap-4">
            <StatusTag status={n.status} className="w-fit shrink-0">
              {n.label}
            </StatusTag>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-md font-medium text-fg">{n.place}</span>
              {n.reason ? <span className="truncate text-sm text-muted">{n.reason}</span> : null}
            </span>
          </span>
          <Link
            href={n.action.href}
            className={cn(
              "inline-flex min-h-10 items-center rounded-sm border px-4 text-md font-medium transition-colors max-md:min-h-11",
              n.status === "critical"
                ? "border-inverse bg-inverse text-on-inverse hover:bg-inverse-hover"
                : "border-line-strong text-fg hover:bg-hover",
            )}
          >
            {n.action.label}
          </Link>
        </li>
      ))}
    </ul>
  );
}
