import {
  FLEET_STATUS_TONE,
  fleetStatusLabel,
  type FleetStatus,
  type FleetStatusTone,
} from "@/analytics/fleet-status";
import { cn } from "@/lib/cn";

import { Badge } from "./badge";

/** Prick + text (automatens läge). Aldrig bara färg: texten står alltid där. */
export function StatusDot({
  tone,
  label,
  className,
}: {
  tone: FleetStatusTone;
  label: string;
  className?: string;
}) {
  return (
    <span className={cn("v2-status", className)}>
      <span className={cn("v2-dot", tone !== "neutral" && tone)} aria-hidden="true" />
      {label}
    </span>
  );
}

/**
 * Automatens läge som i prototypen: larm (Offline, Tom) och Fyll på i dag som märke med
 * prick, Startklar som blått märke, lugna lägen (I drift, Tom om N d, Ström av) som prick + text.
 */
export function FleetStatusBadge({
  status,
  daysLeft,
}: {
  status: FleetStatus;
  daysLeft?: number | null;
}) {
  const tone = FLEET_STATUS_TONE[status];
  const label = fleetStatusLabel(status, daysLeft);
  if (tone === "critical" || tone === "warning" || tone === "info") {
    return (
      <Badge tone={tone} dot>
        {label}
      </Badge>
    );
  }
  return <StatusDot tone={tone} label={label} />;
}
