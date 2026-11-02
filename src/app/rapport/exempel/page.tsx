import type { Metadata } from "next";
import Link from "next/link";
import { PrintButton } from "@/components/report/print-button";
import { reportMeta } from "./data";
import { EXAMPLE_PAGE_COUNT, ExampleReport } from "./example-report";

export const metadata: Metadata = {
  title: reportMeta.title,
  description: `Exempelrapport till ${reportMeta.recipient}. ${EXAMPLE_PAGE_COUNT} sidor A4.`,
};

export default function ExampleReportPage() {
  return (
    <div className="bl-desk min-h-dvh">
      <div data-print="hide" className="sticky top-0 z-10 border-b border-line bg-bg">
        <div className="mx-auto flex h-12 max-w-[1280px] items-center justify-between gap-3 px-4 md:px-8">
          <nav aria-label="Sökväg" className="label flex min-w-0 items-center gap-2 text-subtle">
            <Link
              href="/design#utskrift"
              className="shrink-0 rounded-xs text-muted transition-colors duration-[120ms] ease-instrument hover:text-fg"
            >
              Designsystem
            </Link>
            <span aria-hidden className="text-faint">
              /
            </span>
            <span className="truncate">
              Exempelrapport
              <span className="hidden sm:inline">
                {" "}
                · {EXAMPLE_PAGE_COUNT} sidor · A4 · svartvit
              </span>
            </span>
          </nav>
          <PrintButton />
        </div>
      </div>
      <main className="px-4 py-6 md:px-8 md:py-12 print:p-0">
        <ExampleReport />
      </main>
    </div>
  );
}
