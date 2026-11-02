import { wallClockIn } from "@/components/shell/period-state";
import { MISSING, formatDateTime, formatKronor } from "@/lib/format";

import { formatDayShort, kr, type PriceLogEntry } from "../_lib/model";

function money(ore: number | null): string {
  return ore === null ? "Saknade pris" : formatKronor(kr(ore));
}

function beforeText(e: PriceLogEntry): string {
  return e.beforeOre === null && e.kind !== "Nytt pris" ? MISSING : money(e.beforeOre);
}

/** Ändringsloggen för en titels inköpspriser: vem, när, före och efter. */
export function PriceLog({
  entries,
  timeZone,
  now,
  today,
  titleName,
}: {
  entries: readonly PriceLogEntry[];
  timeZone: string;
  now: string;
  today: string;
  titleName: string;
}) {
  const nowLocal = wallClockIn(new Date(now), timeZone);
  return (
    <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
      <table className="w-full border-collapse text-base sm:min-w-[560px]">
        <caption className="sr-only">
          Ändringar av inköpspriset för {titleName}, senaste först
        </caption>
        <thead>
          <tr className="border-b border-line-strong">
            <th scope="col" className="label h-9 px-3 pl-0 text-left font-normal text-subtle">
              När
            </th>
            <th
              scope="col"
              className="label hidden h-9 px-3 text-left font-normal text-subtle sm:table-cell"
            >
              Vem
            </th>
            <th scope="col" className="label h-9 px-3 text-left font-normal text-subtle">
              Ändring
            </th>
            <th
              scope="col"
              className="label hidden h-9 px-3 text-right font-normal text-subtle sm:table-cell"
            >
              Före
            </th>
            <th
              scope="col"
              className="label hidden h-9 px-3 pr-0 text-right font-normal text-subtle sm:table-cell"
            >
              Efter
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="border-b border-line align-top">
              <td className="meta tnum py-2.5 pr-3 whitespace-nowrap text-muted">
                {formatDateTime(wallClockIn(new Date(e.occurredAt), timeZone), { now: nowLocal })}
                <span className="block text-fg sm:hidden">{e.actor}</span>
              </td>
              <td className="hidden px-3 py-2.5 text-fg sm:table-cell">{e.actor}</td>
              <td className="py-2.5 pr-0 pl-3 sm:pr-3">
                <span className="text-fg">{e.kind}</span>
                <span className="text-subtle">
                  {" "}
                  från {formatDayShort(e.validFrom, today)}
                  {e.movedFrom ? ` (tidigare ${formatDayShort(e.movedFrom, today)})` : ""}
                </span>
                <span className="tnum mt-0.5 block text-sm sm:hidden">
                  <span className="sr-only">Före </span>
                  <span className="text-muted">{beforeText(e)}</span>
                  <span aria-hidden className="text-faint">
                    {" "}
                    →{" "}
                  </span>
                  <span className="sr-only">, efter </span>
                  <span className="text-fg">{money(e.afterOre)}</span>
                </span>
                {e.note ? <span className="block text-sm text-subtle">{e.note}</span> : null}
              </td>
              <td className="tnum hidden px-3 py-2.5 text-right whitespace-nowrap text-muted sm:table-cell">
                {beforeText(e)}
              </td>
              <td className="tnum hidden py-2.5 pr-0 pl-3 text-right whitespace-nowrap text-fg sm:table-cell">
                {money(e.afterOre)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
