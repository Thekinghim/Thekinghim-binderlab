import type { Metadata } from "next";
import Link from "next/link";
import { ReportChrome } from "../_components/report-chrome";
import { V2PrintButton } from "../_components/v2-print-button";
import { reportMeta } from "./data";
import { EXAMPLE_DETAIL_PAGE_COUNT, EXAMPLE_PAGE_COUNT, ExampleReport } from "./example-report";

export const metadata: Metadata = {
  title: reportMeta.title,
  description: `Exempelrapport till ${reportMeta.recipient}. ${EXAMPLE_PAGE_COUNT} sida A4.`,
};

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

/**
 * Exempelrapporten. Standard är den korta rapporten som butiken får (en sida). Med
 * ?detaljer=1 visas rapporten med "Visa detaljer i rapporten" påslaget (tre sidor).
 */
export default async function ExampleReportPage({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const details = (Array.isArray(sp.detaljer) ? sp.detaljer[0] : sp.detaljer) === "1";
  const pages = details ? EXAMPLE_DETAIL_PAGE_COUNT : EXAMPLE_PAGE_COUNT;
  return (
    <ReportChrome
      back={{ href: "/design#utskrift", label: "Designsystem" }}
      crumb={
        <>
          Exempelrapport
          <small>
            {pages} {pages === 1 ? "sida" : "sidor"} · A4 · svartvit
          </small>
        </>
      }
      actions={
        <>
          <Link
            href={details ? "/rapport/exempel" : "/rapport/exempel?detaljer=1"}
            className="v2-btn quiet touch"
          >
            {details ? "Utan detaljer" : "Med detaljer"}
          </Link>
          <V2PrintButton />
        </>
      }
    >
      <ExampleReport details={details} />
    </ReportChrome>
  );
}
