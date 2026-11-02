import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";

import { Icon } from "@/components/ui/icon";
import { SectionHeader } from "@/components/ui/section-header";
import { formatInt, MISSING } from "@/lib/format";
import { requireRoute } from "@/server/data/core";

import { ImportRows } from "../../_components/import-rows";
import { formatWhen, plural } from "../../_lib/display";
import { parseRowFilter } from "../../_lib/schemas";
import { loadImportDetailFor } from "../../_lib/service";
import { currentViewer } from "../../_lib/session";

export const metadata: Metadata = { title: "Import · Datakällor" };

const STATUS_TEXT = {
  succeeded: "Klar",
  running: "Pågår",
  pending: "Väntar",
  failed: "Misslyckades",
} as const;

/** En import: sammanfattning och radlogg för fel, konflikter och nya order. */
export default async function ImportDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const ctx = await requireRoute("datakallor");
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const filter = parseRowFilter(sp.visa);
  const detail = await loadImportDetailFor(await currentViewer(), id, filter);
  if (!detail) notFound();

  const e = detail.entry;
  const when = e.finishedAt ?? e.startedAt ?? e.createdAt;
  const now = new Date(ctx.now);
  const problems = e.rowsConflict + e.rowsError;

  return (
    <div className="mx-auto flex w-full max-w-[1280px] flex-col gap-10 px-4 pt-8 pb-16 md:px-8 md:pt-12">
      <Link
        href="/datakallor#importlogg"
        className="label inline-flex w-fit items-center gap-1.5 text-muted hover:text-fg"
      >
        <Icon name="chevronLeft" size={12} />
        Datakällor
      </Link>
      <SectionHeader
        as="h1"
        size="xl"
        eyebrow={`Import · ${e.dataSourceName}`}
        title={`${plural(e.rowsNew, "ny order", "nya order")} av ${plural(e.rowsTotal, "rad", "rader")}.`}
        aside={`Importerad ${formatWhen(when, ctx.timeZone, now)}${e.createdBy ? ` av ${e.createdBy}` : ""}. ${
          problems === 0
            ? "Inga fel eller konflikter."
            : `${[
                e.rowsConflict > 0 ? plural(e.rowsConflict, "konflikt", "konflikter") : null,
                e.rowsError > 0 ? `${formatInt(e.rowsError)} fel` : null,
              ]
                .filter(Boolean)
                .join(" och ")} att se över.`
        }`}
        meta={[
          { label: "Fil", value: e.fileName ?? MISSING },
          { label: "Av", value: e.createdBy ?? MISSING },
          { label: "Status", value: STATUS_TEXT[e.status] },
          { label: "Rader", value: formatInt(e.rowsTotal) },
          { label: "Dubbletter", value: formatInt(e.rowsDuplicate) },
          { label: "Ej betalda", value: formatInt(e.rowsNotPaid) },
          {
            label: "Källans tid",
            value: detail.sourceTimezoneRecorded
              ? detail.sourceTimezone
              : `${detail.sourceTimezone} (nuvarande)`,
          },
          { label: "Tolkare", value: detail.parserVersion || MISSING },
          {
            label: "Kontrollsumma",
            value: detail.sha256 ? (
              <span title={detail.sha256}>{detail.sha256.slice(0, 12)}…</span>
            ) : (
              MISSING
            ),
          },
        ]}
      />
      <ImportRows detail={detail} filter={filter} timeZone={ctx.timeZone} />
    </div>
  );
}
