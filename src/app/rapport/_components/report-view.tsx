/**
 * Rätt rapport för ögonblicksbildens typ. Används av utskriftsrouten (/rapport/[id]),
 * förhandsvisningen på sidan Rapporter och testerna.
 */

import type { ReportLayout } from "@/components/report/report-document";
import type { ReportSnapshot } from "@/server/reports/snapshot";

import { AccountantReportDocument } from "./accountant-report";
import { PartnerReportDocument } from "./partner-report";
import type { HeadingLevel } from "./shared";
import { StoreReportDocument } from "./store-report";

export function ReportView({
  snapshot,
  layout,
  level,
  recipient,
}: {
  snapshot: ReportSnapshot;
  layout?: ReportLayout;
  level?: HeadingLevel;
  recipient?: string;
}) {
  switch (snapshot.type) {
    case "butik":
      return (
        <StoreReportDocument
          snapshot={snapshot}
          layout={layout}
          level={level}
          recipient={recipient}
        />
      );
    case "bokforing":
      return (
        <AccountantReportDocument
          snapshot={snapshot}
          layout={layout}
          level={level}
          recipient={recipient}
        />
      );
    case "delagare":
      return (
        <PartnerReportDocument
          snapshot={snapshot}
          layout={layout}
          level={level}
          recipient={recipient}
        />
      );
  }
}
