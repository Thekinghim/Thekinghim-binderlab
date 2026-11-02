/**
 * Larm: regler (misstänkt fel/offline, titel nära slut, misslyckad import, avvikande dag),
 * incidenter med deduplicering och återlarm, samt prenumerationer med tysta timmar.
 * Rena funktioner utan I/O; `now` är den enda tidskällan. Anroparen sparar incidenterna och
 * skickar utskicken.
 */

export {
  ALERT_GROUP,
  dayAnomalyAlerts,
  dedupeCandidates,
  healthAlerts,
  importAlerts,
  lowStockAlerts,
  machineIncidentKey,
  SEVERITY_RANK,
  suppressRelated,
  type DayAnomalyInput,
  type ImportAlertInput,
  type LowStockInput,
} from "./rules";
export { acknowledgeIncident, RECONCILE_DEFAULTS, reconcileAlerts } from "./incidents";
export {
  isQuiet,
  matchesSubscription,
  mergeDeliveries,
  quietEndsAt,
  routeNotifications,
} from "./subscriptions";
export type * from "./types";
