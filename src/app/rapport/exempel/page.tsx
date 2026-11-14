import type { Metadata } from "next";
import Link from "next/link";
import { PrintButton } from "@/components/report/print-button";
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
    <div className="bl-desk min-h-dvh">
      <div data-print="hide" className="sticky top-0 z-10 border-b border-line bg-bg">
        <div className="mx-auto flex h-12 max-w-[1280px] items-center justify-between gap-3 px-4 md:px-8">
          <nav aria-label="Sökväg" className="label flex min-w-0 items-center gap-2 text-subtle">
            <Link
              href="/design#utskrift"
              className="shrink-0 rounded-xs text-muted transition-colors duration-fast ease-instrument hover:text-fg"
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
                · {pages} {pages === 1 ? "sida" : "sidor"} · A4 · svartvit
              </span>
            </span>
          </nav>
          <div className="flex items-center gap-3">
            <Link
              href={details ? "/rapport/exempel" : "/rapport/exempel?detaljer=1"}
              className="rounded-xs text-sm text-muted underline-offset-4 transition-colors duration-fast ease-instrument hover:text-fg hover:underline"
            >
              {details ? "Utan detaljer" : "Med detaljer"}
            </Link>
            <PrintButton />
          </div>
        </div>
      </div>
      <main className="px-4 py-6 md:px-8 md:py-12 print:p-0">
        <ExampleReport details={details} />
      </main>
    </div>
  );
}
