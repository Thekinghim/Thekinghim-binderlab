import { StateMessage } from "@/components/ui/state-message";
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
      <StateMessage
        kind="empty"
        message={`Ingen påfyllning eller inventering registrerad under perioden ${periodText}.`}
      />
    );
  }
  return (
    <div className="flex flex-col">
      <div className={cn(GRID, "hidden border-b border-line-strong pb-2 md:grid")}>
        <span className="label text-subtle">När</span>
        <span className="label text-subtle">Händelse</span>
        <span className="label text-subtle">Titel</span>
        <span className="label text-subtle">Plats</span>
        <span className="label text-right text-subtle">Antal</span>
        <span className="label text-subtle">Vem</span>
      </div>
      <ol aria-label="Lagerhistorik">
        {entries.map((e) => {
          const who = e.isSelf ? "Du" : (e.performer ?? "Okänd");
          const place = e.machineCode ? codeText(e.machineCode) : "Centrallager";
          const what = HISTORY_LABEL[e.kind];
          return (
            <li key={e.id} className={cn(GRID, "border-b border-line py-3 md:min-h-12 md:py-2")}>
              <span className="meta text-subtle md:order-none">
                {formatWhen(e.occurredAt, timeZone, now)}
              </span>
              <span className="tnum text-right text-base font-medium md:order-5 md:text-right">
                {historyQuantity(e.kind, e.quantity)}
              </span>
              <span className="text-base text-fg md:order-2">{what}</span>
              <span className="text-right text-sm text-muted md:order-6 md:text-left">{who}</span>
              <span className="col-span-2 min-w-0 truncate text-sm text-muted md:order-3 md:col-span-1">
                {e.titleName}
                <span className="md:hidden"> · {place}</span>
                {e.fromWarehouse ? <span> · från centrallagret</span> : null}
              </span>
              <span className="hidden text-sm text-muted md:order-4 md:block">{place}</span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}
