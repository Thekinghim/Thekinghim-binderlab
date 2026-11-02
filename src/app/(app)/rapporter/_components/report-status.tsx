import { StatusTag, type Status } from "@/components/ui/status-tag";
import { STATUS_LABEL, type ReportStatus } from "@/server/reports/status";

/** Utkast väntar på granskning (halvfylld), godkänd är information, skickad klar, ersatt ingår inte. */
const STATUS_TAG: Record<ReportStatus, Status> = {
  draft: "warning",
  approved: "neutral",
  sent: "ok",
  superseded: "offline",
};

export function ReportStatusTag({ status }: { status: ReportStatus }) {
  return <StatusTag status={STATUS_TAG[status]}>{STATUS_LABEL[status]}</StatusTag>;
}
