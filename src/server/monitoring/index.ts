/**
 * Felövervakning: driftfel → Sentry (när SENTRY_DSN finns) och larm i public.alerts.
 * Se docs/operations.md, avsnittet "Felövervakning och larm".
 */

export {
  recordDraftsOutcome,
  recordJobOutcome,
  recordReportSend,
  type DraftsOutcomeInput,
  type JobOutcomeInput,
  type MonitoringDeps,
  type MonitoringOutcome,
  type ReportSendInput,
} from "./failures";
export {
  recordImportFailure,
  type ImportFailureInput,
  type ImportFailureOutcome,
} from "./import-failure";
export { captureToSentry, sentryEnabled, type FailureCapture, type FailureEvent } from "./sentry";
export {
  raiseSystemAlert,
  resolveSystemAlert,
  type SystemAlertInput,
  type SystemAlertKind,
} from "./system-alerts";
