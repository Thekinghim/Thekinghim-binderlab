"use client";

import { ChannelTags } from "@/components/ui/channel-tags";
import { Select } from "@/components/ui/field";
import { Empty, emptyPacks } from "@/components/v2/empty";
import { Notice } from "@/components/v2/notice";
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
    // Telefon: påfyllningslistan (det man gör) först.
    <section aria-labelledby="pafyllningslista" className="v2-card max-[900px]:-order-1">
      <div className="v2-card-hd">
        <h2 id="pafyllningslista" className="min-w-0">
          {title}
        </h2>
        <span className="shrink-0 text-v2-xs text-v2-mute">Besök i dag</span>
      </div>
      <div className="flex flex-col gap-3 px-[18px] pt-3 pb-1 max-[900px]:px-4">
        {aside ? <p className="ops-p">{aside}</p> : null}
        {machines.length > 1 ? (
          machines.length <= 5 ? (
            <div role="group" aria-label="Automat" className="ops-seg full">
              {machines.map((m) => (
                <button
                  key={m.id}
                  type="button"
                  aria-pressed={m.id === machine.id}
                  onClick={() => onMachine(m.id)}
                >
                  {m.code}
                </button>
              ))}
            </div>
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
      </div>

      {list.lines.length === 0 && list.missing.length === 0 ? (
        <Empty packs={emptyPacks([])} done title={`${machine.code} räcker utan påfyllning i dag`}>
          Inget säljer slut före nästa planerade besök.
        </Empty>
      ) : (
        <div className="flex flex-col pt-2">
          {list.lines.length > 0 ? (
            <>
              <div className="grid grid-cols-[minmax(0,1fr)_auto_auto] items-end gap-x-4 border-y border-v2-line2 bg-v2-hover px-[18px] py-2 text-v2-xs font-[550] text-v2-mute max-[900px]:px-4">
                <span>Titel</span>
                <span className="w-20 text-right">Har → ska ha</span>
                <span className="w-16 text-right">Ta med</span>
              </div>
              <ul aria-label={`Påfyllningslista för ${machine.code}`}>
                {list.lines.map((l) => (
                  <li key={l.titleId} className="border-b border-v2-line2">
                    <Line
                      line={l}
                      machineCode={machine.code}
                      canRegister={canRegister}
                      onSelect={() => onSelect(machine, l)}
                    />
                  </li>
                ))}
              </ul>
              <p className="flex items-baseline justify-between gap-4 px-[18px] py-3 max-[900px]:px-4">
                <span className="text-v2-sm font-[550] text-v2-mute">Totalt</span>
                <span className="tnum text-v2-xl font-[650]">{packs(list.totalPacks)}</span>
              </p>
            </>
          ) : null}
          {list.shortBy > 0 ? (
            <div className="px-3 pb-3">
              <Notice tone="warning">
                {`Vårt lager saknar ${packs(list.shortBy)} för att fylla till målet`}
                {list.missing.length > 0
                  ? `: ${list.missing.map((m) => `${formatInt(m.shortBy)}${NBSP}×${NBSP}${m.titleName} (${formatInt(m.onHand)} kvar, finns inte i vårt lager)`).join(", ")}`
                  : ""}
                {list.missing.length > 0 && list.lines.some((l) => l.shortBy > 0)
                  ? ", resten på raderna ovan."
                  : "."}
              </Notice>
            </div>
          ) : null}
          {list.reasons.length > 0 ? (
            <details className="ops-more border-t border-v2-line2 px-[18px] py-1.5 max-[900px]:px-4">
              <summary>Varför</summary>
              <ul className="mt-1 mb-2 flex flex-col gap-1 text-v2-sm text-v2-mute">
                {list.reasons.slice(0, 4).map((r) => (
                  <li key={r}>{r.endsWith(".") ? r : `${r}.`}</li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
      )}
    </section>
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
    "grid min-h-14 w-full grid-cols-[minmax(0,1fr)_auto_auto] items-center gap-x-4 px-[18px] py-2 text-left max-[900px]:px-4";
  const body = (
    <>
      <span className="flex min-w-0 flex-col">
        <span className="truncate text-v2-md text-v2-ink">{line.titleName}</span>
        {line.capacity != null && line.channels && line.channels.length > 0 ? (
          <ChannelTags channels={line.channels} className="mt-0.5" />
        ) : null}
        {line.shortBy > 0 ? (
          <span className="text-v2-xs text-v2-crit-text">
            {formatInt(line.shortBy)}
            {NBSP}saknas i vårt lager
          </span>
        ) : null}
      </span>
      <span className="tnum w-20 text-right text-v2-sm text-v2-mute">
        {formatInt(line.onHand)} → {formatInt(line.target)}
      </span>
      <span className="tnum w-16 text-right text-v2-xl font-[650]">{formatInt(line.quantity)}</span>
    </>
  );
  if (!canRegister) return <div className={cls}>{body}</div>;
  return (
    <button
      type="button"
      className={cn(
        cls,
        "transition-colors duration-150 hover:bg-v2-hover focus-visible:-outline-offset-2",
      )}
      aria-label={`${line.titleName}: ta med ${packs(line.quantity)} till ${machineCode}, ${formatInt(line.onHand)} i automaten, mål ${formatInt(line.target)}. Registrera påfyllning.`}
      onClick={onSelect}
    >
      {body}
    </button>
  );
}
