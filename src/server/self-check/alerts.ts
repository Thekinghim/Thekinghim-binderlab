/**
 * Daglig kontroll → larm (public.alerts, familjen system, typen self_check):
 *
 *   kontrollen gick inte igenom   larm 'self_check:<kontroll>' (ett per kontroll; samma
 *                                 öppna larm räknas upp nästa dag, inget nytt)
 *   kontrollen gick igenom igen   larmet stängs
 *   (varning eller inget att kontrollera stänger också larmet: bara fel larmar)
 *
 * Ett nytt larm aviseras till ägare och admin som prenumererar (push, e-post enligt
 * deras val under Notiser, med tysta timmar). Från en demo aviseras ingenting: larmet
 * syns bara i appen.
 */

import "server-only";

import type { CheckResult } from "@/analytics/self-check";
import type { Db } from "@/db/client";
import { OPERATOR_ROLES } from "@/server/data/core/types";
import { safely } from "@/server/monitoring/failures";
import { notifySystemAlert } from "@/server/monitoring/notify";
import {
  clip,
  raiseSystemAlert,
  resolveSystemAlert,
  type SystemAlertInput,
} from "@/server/monitoring/system-alerts";

export function selfCheckAlertKey(id: string): string {
  return `self_check:${id}`;
}

export interface AlertOutcome {
  readonly raised: number;
  readonly created: number;
  readonly resolved: number;
  readonly notified: number;
}

function alertInput(orgId: string, r: CheckResult, now: Date): SystemAlertInput {
  const shown = r.findings.filter((f) => f.level === "fail").slice(0, 3);
  const rest = r.findings.filter((f) => f.level === "fail").length - shown.length + r.more;
  const detail = [r.summary, ...shown.map((f) => f.text), rest > 0 ? `Och ${rest} till.` : ""]
    .filter(Boolean)
    .join(" ");
  return {
    organizationId: orgId,
    kind: "self_check",
    key: selfCheckAlertKey(r.id),
    severity: "warning",
    title: clip(`Kontrollen: ${r.title}`, 300),
    detail: clip(detail, 2000),
    rule: "Daglig kontroll varje morgon. Larmar när en kontroll inte går igenom, stängs när den går igenom igen.",
    link: "/installningar/kontroll",
    figures: r.figures
      .filter((f) => f.unit === "count")
      .slice(0, 6)
      .map((f, i) => ({ key: `f${i}`, label: f.label, value: f.value })),
    now,
  };
}

/** Larm för kontrollerna som inte gick igenom, stängning för de andra. Kastar inte. */
export async function syncSelfCheckAlerts(
  db: Db,
  orgId: string,
  results: readonly CheckResult[],
  options: { readonly now: Date; readonly notify: boolean },
): Promise<AlertOutcome> {
  let raised = 0;
  let created = 0;
  let resolved = 0;
  let notified = 0;
  for (const r of results) {
    const key = selfCheckAlertKey(r.id);
    if (r.status !== "fail") {
      resolved += await safely(
        "stänga kontrollarm",
        () => resolveSystemAlert(db, orgId, key, options.now),
        0,
      );
      continue;
    }
    const input = alertInput(orgId, r, options.now);
    const alert = await safely("kontrollarm", () => raiseSystemAlert(db, input), null);
    if (!alert) continue;
    raised += 1;
    if (!alert.created) continue;
    created += 1;
    if (options.notify) {
      notified += await safely(
        "avisering av kontrollarm",
        () => notifySystemAlert(db, alert.id, input, { roles: OPERATOR_ROLES }),
        0,
      );
    }
  }
  return { raised, created, resolved, notified };
}
