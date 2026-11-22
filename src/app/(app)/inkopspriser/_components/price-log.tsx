import { wallClockIn } from "@/components/shell/period-state";
import { MISSING, formatDateTime, formatKronor } from "@/lib/format";

import { formatDayShort, kr, type PriceLogEntry } from "../_lib/model";

function money(ore: number | null): string {
  return ore === null ? "Saknade pris" : formatKronor(kr(ore));
}

/** Pris mot kund: inget pris är ett streck (det är valfritt, inget som saknas). */
function customerMoney(ore: number | null): string {
  return ore === null ? MISSING : formatKronor(kr(ore));
}

function beforeText(e: PriceLogEntry): string {
  if (e.kind === "Pris mot kund") return customerMoney(e.beforeOre);
  return e.beforeOre === null && e.kind !== "Nytt pris" ? MISSING : money(e.beforeOre);
}

function afterText(e: PriceLogEntry): string {
  return e.kind === "Pris mot kund" ? customerMoney(e.afterOre) : money(e.afterOre);
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
    <div className="-mx-[18px] overflow-x-auto">
      <table className="v2-table sm:min-w-[560px]">
        <caption className="sr-only">
          Ändringar av inköpspriset för {titleName}, senaste först
        </caption>
        <thead>
          <tr>
            <th scope="col">När</th>
            <th scope="col" className="hidden sm:table-cell">
              Vem
            </th>
            <th scope="col">Ändring</th>
            <th scope="col" className="num hidden sm:table-cell">
              Före
            </th>
            <th scope="col" className="num hidden sm:table-cell">
              Efter
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="align-top">
              <td className="tnum whitespace-nowrap text-v2-mute">
                {formatDateTime(wallClockIn(new Date(e.occurredAt), timeZone), { now: nowLocal })}
                <span className="block text-fg sm:hidden">{e.actor}</span>
              </td>
              <td className="hidden sm:table-cell">{e.actor}</td>
              <td>
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
                  <span className="text-fg">{afterText(e)}</span>
                </span>
                {e.customer && e.kind !== "Pris mot kund" ? (
                  <span className="tnum block text-sm text-subtle">
                    Pris mot kund {customerMoney(e.customer.beforeOre)}
                    <span aria-hidden> → </span>
                    <span className="sr-only"> till </span>
                    {customerMoney(e.customer.afterOre)}
                  </span>
                ) : null}
                {e.note ? <span className="block text-sm text-subtle">{e.note}</span> : null}
              </td>
              <td className="num hidden whitespace-nowrap text-v2-mute sm:table-cell">
                {beforeText(e)}
              </td>
              <td className="num hidden whitespace-nowrap sm:table-cell">{afterText(e)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
