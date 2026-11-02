"use client";

import { useMemo, useState, useTransition, type ReactNode } from "react";

import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Select } from "@/components/ui/field";
import { Panel, PanelSection } from "@/components/ui/frame";
import { KpiStrip, type KpiItem } from "@/components/ui/kpi-strip";
import { Segmented } from "@/components/ui/segmented";
import { StatusGlyph, StatusTag, type Status } from "@/components/ui/status-tag";
import { formatInt, formatKronor, MISSING } from "@/lib/format";

import { updateDataSource } from "../actions";
import { SOURCE_TIMEZONES } from "../_lib/constants";
import { formatBytes, formatWhenWithYear, plural, ROW_STATUS_LABELS } from "../_lib/display";
import type { ImportWarning, PreviewResult, PreviewRow, RowStatus } from "../_lib/types";
import { MappingEditor, type MappingDraft } from "./mapping-editor";

const ROW_TONE: Record<RowStatus, Status> = {
  new: "ok",
  duplicate: "neutral",
  conflict: "warning",
  error: "critical",
  not_paid: "offline",
};

const WARNING_TONE: Partial<Record<ImportWarning["code"], Status>> = {
  errors: "critical",
  conflicts: "warning",
  duplicate_file: "warning",
  unknown_machines: "warning",
  late_in_closed_period: "warning",
};

type RowFilter = "all" | "problems" | "new" | "duplicate";

/**
 * Förhandsvisningen (eller resultatet efter import): sammanfattning, kontroll av
 * källans tidszon, varningar, okända automater och titlar, mappning och de tolkade
 * raderna med tider i svensk tid.
 */
export function PreviewView({
  result,
  timeZone,
  onConfirm,
  onCancel,
  onRemap,
  onRepreview,
  footer,
}: {
  result: PreviewResult;
  timeZone: string;
  onConfirm?: () => void;
  onCancel?: () => void;
  onRemap?: (draft: MappingDraft) => void;
  onRepreview?: () => void;
  footer?: ReactNode;
}) {
  const s = result.summary;
  const committed = !result.dryRun;
  const items: KpiItem[] = [
    {
      id: "new",
      label: committed ? "Nya order" : "Nya",
      value: s.new,
      format: formatInt,
      primary: true,
    },
    { id: "dup", label: "Dubbletter", value: s.duplicate, format: formatInt },
    {
      id: "conflict",
      label: "Konflikter",
      value: s.conflict,
      format: formatInt,
      alert: s.conflict > 0,
      alertText: s.conflict > 0 ? "Avviker från sparad order" : undefined,
    },
    {
      id: "error",
      label: "Fel",
      value: s.error,
      format: formatInt,
      alert: s.error > 0,
      alertText: s.error > 0 ? "Hoppas över" : undefined,
    },
    { id: "notPaid", label: "Ej betalda", value: s.notPaid, format: formatInt },
  ];

  return (
    <Panel className="flex flex-col gap-8" aria-label={committed ? "Importen" : "Förhandsvisning"}>
      <div className="flex flex-col gap-2">
        <p className="label text-subtle">
          {committed ? "Importerad" : "Förhandsvisning · inget är sparat ännu"}
        </p>
        <h3 className="text-lg font-medium text-balance">
          <span className="text-fg">{headlineOf(result)}</span>{" "}
          <span className="text-subtle">{asideOf(result)}</span>
        </h3>
        <p className="meta tnum truncate text-muted">
          {result.file.name} · {formatBytes(result.file.bytes)} · {plural(s.total, "rad", "rader")}{" "}
          · {result.dataSource.name}
        </p>
      </div>

      <KpiStrip items={items} label={`Rader i filen · ${formatInt(s.total)}`} motion="none" />

      {!committed && result.firstRow ? (
        <TimezoneCheck result={result} timeZone={timeZone} onChanged={onRepreview} />
      ) : null}

      {result.warnings.length > 0 ? <Warnings warnings={result.warnings} /> : null}

      {result.unknownMachines.length > 0 || result.newTitles.length > 0 ? (
        <div className="grid gap-6 md:grid-cols-2">
          {result.unknownMachines.length > 0 ? (
            <NameList
              label={`Okända automater · ${formatInt(result.unknownMachines.length)}`}
              note={
                committed
                  ? "Ligger i kön nedan. Orderna får automaten när du kopplar namnet."
                  : "Hamnar i kön för okända automater. Orderna sparas och får automaten när du kopplar namnet."
              }
              items={result.unknownMachines.map((m) => ({
                key: m.externalId,
                name: m.name ?? m.externalId,
                rows: m.rows,
              }))}
            />
          ) : null}
          {result.newTitles.length > 0 ? (
            <NameList
              label={`Nya titlar · ${formatInt(result.newTitles.length)}`}
              note="Skapas som nya titlar. Lägg in inköpspris under Inköpspriser, annars saknas marginalen."
              items={result.newTitles.map((t) => ({ key: t.name, name: t.name, rows: t.rows }))}
            />
          ) : null}
        </div>
      ) : null}

      {!committed && result.mapping && onRemap ? (
        <MappingEditor
          key={result.file.sha256 + JSON.stringify(result.mapping.columns)}
          mapping={result.mapping}
          onApply={onRemap}
        />
      ) : null}

      <RowsTable result={result} timeZone={timeZone} />

      {!committed && onConfirm ? (
        <div className="flex flex-col gap-3 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="text-sm text-muted">
            {s.new > 0
              ? `${plural(s.new, "ny order", "nya order")} sparas. Dubbletter och konflikter ändrar inget.`
              : `Inget nytt att importera: ${plural(s.duplicate, "order", "order")} finns redan. Importen kan ändå sparas i loggen.`}
          </p>
          <div className="flex flex-col-reverse gap-2 sm:flex-row">
            {onCancel ? <Button onClick={onCancel}>Avbryt</Button> : null}
            <Button variant={s.new > 0 ? "primary" : "secondary"} onClick={onConfirm}>
              {s.new > 0
                ? `Importera ${plural(s.new, "order", "order")}`
                : "Spara i loggen (0 nya)"}
            </Button>
          </div>
        </div>
      ) : null}
      {footer ? <div className="border-t border-line pt-5">{footer}</div> : null}
    </Panel>
  );
}

function headlineOf(r: PreviewResult): string {
  const s = r.summary;
  if (!r.dryRun) return `${plural(s.new, "ny order", "nya order")} importerade.`;
  if (s.new === 0 && s.duplicate > 0) return "Inget nytt i filen.";
  return `${plural(s.new, "ny order", "nya order")} att importera.`;
}

function asideOf(r: PreviewResult): string {
  const s = r.summary;
  const parts: string[] = [];
  if (s.duplicate > 0) parts.push(`${formatInt(s.duplicate)} finns redan`);
  if (s.conflict > 0) parts.push(plural(s.conflict, "konflikt", "konflikter"));
  if (s.error > 0) parts.push(`${formatInt(s.error)} fel`);
  if (s.notPaid > 0) parts.push(`${formatInt(s.notPaid)} ej betalda`);
  return parts.length > 0 ? `${parts.join(", ")}.` : "Inga dubbletter eller fel.";
}

/** Kontroll av källans tidszon: första betalda raden i källans tid och i svensk tid. */
function TimezoneCheck({
  result,
  timeZone,
  onChanged,
}: {
  result: PreviewResult;
  timeZone: string;
  onChanged?: () => void;
}) {
  const first = result.firstRow;
  const [zone, setZone] = useState(result.dataSource.sourceTimezone);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  if (!first) return null;
  const swedish = formatWhenWithYear(first.utc, timeZone);
  const options: Array<{ value: string; label: string }> = SOURCE_TIMEZONES.map((z) => ({
    value: z.value,
    label: z.label,
  }));
  if (!options.some((o) => o.value === result.dataSource.sourceTimezone)) {
    options.unshift({
      value: result.dataSource.sourceTimezone,
      label: result.dataSource.sourceTimezone,
    });
  }

  const change = () =>
    startTransition(async () => {
      setError(null);
      const r = await updateDataSource({ id: result.dataSource.id, sourceTimezone: zone });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      onChanged?.();
    });

  return (
    <PanelSection label="Kontrollera tidszonen mot Awish">
      <div className="grid gap-6 md:grid-cols-12">
        <dl className="grid grid-cols-1 gap-3 sm:grid-cols-3 md:col-span-7">
          <div className="flex flex-col gap-1">
            <dt className="label text-subtle">
              Order {first.externalId} · rad {formatInt(first.rowNumber)}
            </dt>
            <dd className="tnum text-base text-fg">{first.sourceLocal}</dd>
            <dd className="text-xs text-subtle">Payment Time i filen</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="label text-subtle">Tolkas som</dt>
            <dd className="text-base text-fg">{first.sourceTimezone}</dd>
            <dd className="text-xs text-subtle">Källans tidszon</dd>
          </div>
          <div className="flex flex-col gap-1">
            <dt className="label text-subtle">Svensk tid</dt>
            <dd className="tnum text-base font-medium text-fg">{swedish}</dd>
            <dd className="text-xs text-subtle">Affärsdag {first.businessDate}</dd>
          </div>
        </dl>
        <div className="flex flex-col gap-3 md:col-span-5">
          <p className="text-sm text-muted">
            Öppna order {first.externalId} i Awish och kontrollera att den betalades{" "}
            <span className="text-fg">{swedish}</span> svensk tid. Stämmer det inte är källans
            tidszon fel; skillnaden i timmar är felet. Byt tidszon innan du importerar.
          </p>
          <form
            className="flex flex-col gap-2 sm:flex-row sm:items-end"
            onSubmit={(e) => {
              e.preventDefault();
              change();
            }}
          >
            <Select
              label="Källans tidszon"
              value={zone}
              options={options}
              onChange={(e) => setZone(e.target.value)}
              wrapperClassName="min-w-0 flex-1"
            />
            <Button
              type="submit"
              loading={pending}
              disabled={zone === result.dataSource.sourceTimezone}
            >
              Byt och förhandsvisa
            </Button>
          </form>
          {error ? (
            <p role="alert" className="text-xs text-signal-fg">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </PanelSection>
  );
}

function Warnings({ warnings }: { warnings: readonly ImportWarning[] }) {
  return (
    <ul className="flex flex-col gap-2" aria-label="Att kontrollera">
      {warnings.map((w) => (
        <li key={w.code} className="flex items-start gap-3 text-sm">
          <span className="mt-1.5 inline-flex w-2 shrink-0 justify-center text-fg">
            <StatusGlyph status={WARNING_TONE[w.code] ?? "neutral"} />
          </span>
          <span className="text-fg">
            {w.message}
            {w.rows && w.rows.length > 0 ? (
              <span className="tnum text-subtle">
                {" "}
                Rad {w.rows.slice(0, 8).map(formatInt).join(", ")}
                {w.rows.length > 8 ? " …" : ""}.
              </span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function NameList({
  label,
  note,
  items,
}: {
  label: string;
  note: string;
  items: ReadonlyArray<{ key: string; name: string; rows: number }>;
}) {
  const shown = items.slice(0, 12);
  return (
    <div className="flex min-w-0 flex-col gap-3">
      <p className="label text-muted">{label}</p>
      <p className="text-sm text-muted">{note}</p>
      <ul className="flex flex-col">
        {shown.map((i) => (
          <li
            key={i.key}
            className="flex items-baseline justify-between gap-4 border-t border-line py-1.5 text-sm last:border-b"
          >
            <span className="min-w-0 truncate text-fg">{i.name}</span>
            <span className="tnum shrink-0 text-muted">{plural(i.rows, "rad", "rader")}</span>
          </li>
        ))}
      </ul>
      {items.length > shown.length ? (
        <p className="text-xs text-subtle">och {formatInt(items.length - shown.length)} till</p>
      ) : null}
    </div>
  );
}

function RowsTable({ result, timeZone }: { result: PreviewResult; timeZone: string }) {
  const problems = result.rows.filter(
    (r) => r.status === "error" || r.status === "conflict",
  ).length;
  const [filter, setFilter] = useState<RowFilter>(problems > 0 ? "problems" : "all");
  const rows = useMemo(
    () =>
      result.rows.filter((r) =>
        filter === "all"
          ? true
          : filter === "problems"
            ? r.status === "error" || r.status === "conflict"
            : r.status === filter,
      ),
    [result.rows, filter],
  );

  const columns: Column<PreviewRow>[] = [
    {
      key: "row",
      header: "Rad",
      numeric: true,
      sortValue: (r) => r.rowNumber,
      render: (r) => formatInt(r.rowNumber),
      width: 72,
    },
    {
      key: "status",
      header: "Status",
      sortValue: (r) => r.status,
      render: (r) => (
        <StatusTag status={ROW_TONE[r.status]}>{ROW_STATUS_LABELS[r.status]}</StatusTag>
      ),
      csv: (r) => ROW_STATUS_LABELS[r.status],
      width: 120,
    },
    {
      key: "order",
      header: "Order",
      sortValue: (r) => r.externalId ?? "",
      render: (r) => <span className="tnum">{r.externalId ?? MISSING}</span>,
      width: 110,
    },
    {
      key: "message",
      header: "Meddelande",
      sortValue: (r) => r.message ?? "",
      render: (r) => (
        <span className="block max-w-[48ch] min-w-[32ch] text-sm whitespace-normal text-muted">
          {[r.message, ...r.notes].filter(Boolean).join(" ") || MISSING}
        </span>
      ),
    },
    {
      key: "paidAt",
      header: "Betald (svensk tid)",
      sortValue: (r) => r.orderedAt ?? "",
      render: (r) => (
        <span className="tnum whitespace-nowrap">
          {r.orderedAt ? formatWhenWithYear(r.orderedAt, timeZone) : MISSING}
        </span>
      ),
      csv: (r) => (r.orderedAt ? formatWhenWithYear(r.orderedAt, timeZone) : ""),
      width: 170,
    },
    {
      key: "title",
      header: "Titel",
      sortValue: (r) => r.rawTitle ?? "",
      render: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{r.rawTitle ?? MISSING}</span>
          {r.rawTitle && !r.titleKnown && r.status !== "error" ? (
            <span className="label shrink-0 text-subtle">Ny</span>
          ) : null}
        </span>
      ),
    },
    {
      key: "machine",
      header: "Automat",
      sortValue: (r) => r.machineName ?? "",
      render: (r) => (
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{r.machineName ?? MISSING}</span>
          {r.machineName && !r.machineMapped && r.status !== "error" ? (
            <span className="label shrink-0 text-subtle">Okänd</span>
          ) : null}
        </span>
      ),
      hideOnMobile: true,
    },
    {
      key: "amount",
      header: "Belopp",
      numeric: true,
      sortValue: (r) => r.amountOre ?? Number.NaN,
      render: (r) => (r.amountOre === null ? MISSING : formatKronor(r.amountOre / 100)),
      width: 110,
    },
  ];

  const counts = {
    problems,
    new: result.rows.filter((r) => r.status === "new").length,
    duplicate: result.rows.filter((r) => r.status === "duplicate").length,
  };

  return (
    <div className="flex min-w-0 flex-col gap-3">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="label text-muted">
          Tolkade rader · {formatInt(result.rows.length)} visas
          {result.rowsHidden > 0 ? ` av ${formatInt(result.rows.length + result.rowsHidden)}` : ""}
        </p>
        <Segmented<RowFilter>
          label="Visa rader"
          size="sm"
          value={filter}
          onChange={setFilter}
          options={[
            { value: "all", label: "Alla" },
            { value: "problems", label: `Fel och konflikter ${formatInt(counts.problems)}` },
            { value: "new", label: `Nya ${formatInt(counts.new)}` },
            { value: "duplicate", label: `Dubbletter ${formatInt(counts.duplicate)}` },
          ]}
        />
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(r) => String(r.rowNumber)}
        caption="Tolkade rader"
        defaultSort={{ key: "row", dir: "asc" }}
        isFlagged={(r) => r.status === "error" || r.status === "conflict"}
        dense
        maxHeight={rows.length > 12 ? 480 : undefined}
      />
      {result.rowsHidden > 0 ? (
        <p className="text-xs text-subtle">
          Urval: de första 100 raderna och alla rader med fel eller konflikt. Alla rader med fel och
          konflikter finns i importloggen efter importen.
        </p>
      ) : null}
      <p className="text-xs text-subtle">
        Tider i svensk tid ({timeZone}), tolkade från källans tid.
      </p>
    </div>
  );
}
