"use client";

import { Segmented } from "@/components/ui/segmented";
import { Select } from "@/components/ui/field";
import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";
import { StatusGlyph } from "@/components/ui/status-tag";
import { cn } from "@/lib/cn";
import { formatInt, NBSP } from "@/lib/format";

import { codeText, packs } from "../_lib/display";
import { packListAside } from "../_lib/headline";
import type { LagerMachine, PackList as PackListData, PackListLine } from "../_lib/types";

/**
 * Påfyllningslistan för en automat inför ett besök i dag: vad som ska med och hur
 * många, ur besöksplanen (försäljningstakten och centrallagret). En rad öppnar
 * registreringen med antalet ifyllt.
 */
export function PackList({
  machines,
  lists,
  machineId,
  onMachine,
  today,
  canRegister,
  onSelect,
}: {
  index?: number;
  machines: LagerMachine[];
  lists: PackListData[];
  machineId: string;
  onMachine: (id: string) => void;
  today: string;
  canRegister: boolean;
  onSelect: (machine: LagerMachine, line: PackListLine) => void;
}) {
  const machine = machines.find((m) => m.id === machineId) ?? machines[0];
  const list = lists.find((l) => l.machineId === machine?.id);
  if (!machine || !list) return null;

  const title =
    list.totalPacks === 0
      ? list.missing.length > 0
        ? `Inget att ta med till ${codeText(machine.code)}: vårt lager saknar det som behövs.`
        : `Inget behöver med till ${codeText(machine.code)} i dag.`
      : `Ta med ${packs(list.totalPacks)} till ${codeText(machine.code)}.`;
  const aside = packListAside(list, today);

  return (
    <div className="flex flex-col gap-6">
      <SectionHeader
        id="pafyllningslista"
        eyebrow="Påfyllningslista · besök i dag"
        title={title}
        aside={aside}
      />
      {machines.length > 1 ? (
        machines.length <= 5 ? (
          <Segmented
            label="Automat"
            options={machines.map((m) => ({ value: m.id, label: m.code }))}
            value={machine.id}
            onChange={onMachine}
            className="h-auto! w-full sm:w-fit [&>button]:min-h-11 [&>button]:flex-1 sm:[&>button]:min-w-24"
          />
        ) : (
          <Select
            label="Automat"
            value={machine.id}
            onChange={(e) => onMachine(e.target.value)}
            options={machines.map((m) => ({ value: m.id, label: `${m.code} ${m.name}` }))}
            wrapperClassName="max-w-sm"
          />
        )
      ) : null}

      {list.lines.length === 0 && list.missing.length === 0 ? (
        <StateMessage
          kind="empty"
          compact
          message={`${machine.code} räcker utan påfyllning i dag. Inget säljer slut före nästa planerade besök.`}
        />
      ) : (
        <div className="flex flex-col">
          {list.lines.length > 0 ? (
            <>
              <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-end gap-x-4 border-b border-line-strong pb-2">
                <span className="label text-subtle">Titel</span>
                <span className="label w-20 text-right text-subtle">Nu → mål</span>
                <span className="label w-16 text-right text-subtle">Ta med</span>
              </div>
              <ul aria-label={`Påfyllningslista för ${machine.code}`}>
                {list.lines.map((l) => (
                  <li key={l.titleId} className="border-b border-line">
                    <Line
                      line={l}
                      machineCode={machine.code}
                      canRegister={canRegister}
                      onSelect={() => onSelect(machine, l)}
                    />
                  </li>
                ))}
              </ul>
              <p className="flex items-baseline justify-between gap-4 pt-3">
                <span className="label text-subtle">Totalt</span>
                <span className="tnum text-xl font-medium">{packs(list.totalPacks)}</span>
              </p>
            </>
          ) : null}
          {list.shortBy > 0 ? (
            <div className="mt-4 flex items-start gap-2 text-sm text-fg">
              <span className="mt-1.5 inline-flex">
                <StatusGlyph status="warning" />
              </span>
              <p>
                {`Vårt lager saknar ${packs(list.shortBy)} för att fylla till målet`}
                {list.missing.length > 0
                  ? `: ${list.missing.map((m) => `${formatInt(m.shortBy)}${NBSP}×${NBSP}${m.titleName} (${formatInt(m.onHand)} kvar, finns inte i vårt lager)`).join(", ")}`
                  : ""}
                {list.missing.length > 0 && list.lines.some((l) => l.shortBy > 0)
                  ? ", resten på raderna ovan."
                  : "."}
              </p>
            </div>
          ) : null}
          {list.reasons.length > 0 ? (
            <ul className="mt-6 flex flex-col gap-1 text-sm text-muted">
              {list.reasons.slice(0, 4).map((r) => (
                <li key={r}>{r.endsWith(".") ? r : `${r}.`}</li>
              ))}
            </ul>
          ) : null}
        </div>
      )}
    </div>
  );
}

function Line({
  line,
  machineCode,
  canRegister,
  onSelect,
}: {
  line: PackListLine;
  machineCode: string;
  canRegister: boolean;
  onSelect: () => void;
}) {
  const cls =
    "grid min-h-14 w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 py-2 text-left";
  const body = (
    <>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-base text-fg">{line.titleName}</span>
        {line.shortBy > 0 ? (
          <span className="meta text-subtle">
            {formatInt(line.shortBy)}
            {NBSP}saknas i vårt lager
          </span>
        ) : null}
      </span>
      <span className="tnum w-20 text-right text-sm text-muted">
        {formatInt(line.onHand)} → {formatInt(line.target)}
      </span>
      <span className="tnum w-16 text-right text-xl font-medium">{formatInt(line.quantity)}</span>
    </>
  );
  if (!canRegister) return <div className={cls}>{body}</div>;
  return (
    <button
      type="button"
      className={cn(
        cls,
        "-mx-2 px-2 transition-colors duration-fast ease-instrument hover:bg-hover focus-visible:-outline-offset-2",
      )}
      style={{ width: "calc(100% + 16px)" }}
      aria-label={`${line.titleName}: ta med ${packs(line.quantity)} till ${machineCode}, ${formatInt(line.onHand)} i automaten, mål ${formatInt(line.target)}. Registrera påfyllning.`}
      onClick={onSelect}
    >
      {body}
    </button>
  );
}
