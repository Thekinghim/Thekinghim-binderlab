import type { Metadata } from "next";
import { notFound } from "next/navigation";

import { Icon } from "@/components/ui/icon";
import { Badge } from "@/components/v2/badge";
import { ButtonLink } from "@/components/v2/button";
import { Card, CardBody } from "@/components/v2/card";
import { KeyValues } from "@/components/v2/key-values";
import { V2Page } from "@/components/v2/shell/page";
import { SubNav } from "@/components/v2/sub-nav";
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

const STATUS_TONE = {
  succeeded: "success",
  running: "info",
  pending: "neutral",
  failed: "critical",
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

  const aside = `Importerad ${formatWhen(when, ctx.timeZone, now)}${e.createdBy ? ` av ${e.createdBy}` : ""}. ${
    problems === 0
      ? "Inga fel eller konflikter."
      : `${[
          e.rowsConflict > 0 ? plural(e.rowsConflict, "konflikt", "konflikter") : null,
          e.rowsError > 0 ? `${formatInt(e.rowsError)} fel` : null,
        ]
          .filter(Boolean)
          .join(" och ")} att se över.`
  }`;

  return (
    <V2Page
      title={`Import · ${e.dataSourceName}`}
      sub={
        <>
          <b>
            {plural(e.rowsNew, "ny order", "nya order")} av {plural(e.rowsTotal, "rad", "rader")}.
          </b>{" "}
          {aside}
        </>
      }
    >
      <SubNav />
      <div className="v2-stack">
        <div>
          <ButtonLink href="/datakallor#importlogg" size="sm" variant="plain" touch>
            <Icon name="chevronLeft" size={12} />
            Datakällor
          </ButtonLink>
        </div>
        <div className="v2-cols">
          <Card title="Radlogg">
            <CardBody>
              <ImportRows detail={detail} filter={filter} timeZone={ctx.timeZone} />
            </CardBody>
          </Card>
          <Card title="Importen">
            <CardBody>
              <KeyValues
                items={[
                  {
                    label: "Fil",
                    value: (
                      <span className="[overflow-wrap:anywhere]">{e.fileName ?? MISSING}</span>
                    ),
                  },
                  { label: "Av", value: e.createdBy ?? MISSING },
                  {
                    label: "Status",
                    value: <Badge tone={STATUS_TONE[e.status]}>{STATUS_TEXT[e.status]}</Badge>,
                  },
                  { label: "Rader", value: formatInt(e.rowsTotal) },
                  { label: "Dubbletter", value: formatInt(e.rowsDuplicate) },
                  { label: "Ej betalda", value: formatInt(e.rowsNotPaid) },
                ]}
              />
              {/* Felsökningsuppgifter (tidszon, tolkarens version, kontrollsumma): fällda. */}
              <details className="mt-3 text-v2-sm">
                <summary className="cursor-pointer text-v2-mute">Tekniskt</summary>
                <KeyValues
                  items={[
                    {
                      label: "Tidszon i filen",
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
              </details>
            </CardBody>
          </Card>
        </div>
      </div>
    </V2Page>
  );
}
