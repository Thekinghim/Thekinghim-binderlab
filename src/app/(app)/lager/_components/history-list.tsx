import { Empty } from "@/components/v2/empty";
import { cn } from "@/lib/cn";

import { codeText, formatWhen, HISTORY_LABEL, historyQuantity } from "../_lib/display";
import type { HistoryEntry } from "../_lib/types";

const GRID =
  "grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 md:grid-cols-[128px_120px_minmax(0,1fr)_96px_80px_minmax(0,160px)] md:items-center";

/**
 * Historiken: vem, när och hur mycket. Påfyllning, inventering, uttag och övriga
 * lagerhändelser utom försäljning, senast först.
 */
export function HistoryList({
  entries,
  timeZone,
  now,
  periodText,
}: {
  entries: HistoryEntry[];
  timeZone: string;
  now: string;
  periodText: string;
}) {
  if (entries.length === 0) {
    return (
      <Empty title="Ingen historik.">
        {`Ingen påfyllning eller inventering registrerad under perioden ${periodText}.`}
      </Empty>
    );
  }
  return (
    <div className="flex flex-col">
      <div
        className={cn(
          GRID,
          "hidden border-b border-v2-line2 bg-v2-hover px-[18px] py-2 text-v2-xs font-[550] text-v2-mute md:grid",
        )}
      >
        <span>När</span>
        <span>Händelse</span>
        <span>Titel</span>
        <span>Plats</span>
        <span className="text-right">Antal</span>
        <span>Vem</span>
      </div>
      <ol aria-label="Lagerhistorik">
        {entries.map((e) => {
          const who = e.isSelf ? "Du" : (e.performer ?? "Okänd");
          const place = e.machineCode ? codeText(e.machineCode) : "Vårt lager";
          const what = HISTORY_LABEL[e.kind];
          return (
            <li
              key={e.id}
              className={cn(
                GRID,
                "border-b border-v2-line2 px-[18px] py-3 last:border-b-0 max-md:px-4 md:min-h-11 md:py-2",
              )}
            >
              <span className="tnum text-v2-xs text-v2-mute md:order-none">
                {formatWhen(e.occurredAt, timeZone, now)}
              </span>
              <span className="tnum text-right text-v2-md font-[550] md:order-5 md:text-right">
                {historyQuantity(e.kind, e.quantity)}
              </span>
              <span className="text-v2-sm text-v2-ink md:order-2">{what}</span>
              <span className="text-right text-v2-sm text-v2-mute md:order-6 md:text-left">
                {who}
              </span>
              <span className="col-span-2 min-w-0 text-v2-sm [overflow-wrap:anywhere] text-v2-mute md:order-3 md:col-span-1 md:truncate">
                {e.titleName}
                <span className="md:hidden"> · {place}</span>
                {e.fromWarehouse ? <span> · från vårt lager</span> : null}
              </span>
              <span className="hidden text-v2-sm text-v2-mute md:order-4 md:block">{place}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
