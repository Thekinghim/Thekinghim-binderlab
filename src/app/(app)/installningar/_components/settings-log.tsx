import { wallClockIn } from "@/components/shell/period-state";
import { MISSING, formatDateTime } from "@/lib/format";

import type { SettingsLogEntry } from "../_lib/model";

/** Ändringsloggen för inställningar, ägarandelar och konton: vem, när, före och efter. */
export function SettingsLog({
  entries,
  timeZone,
  now,
}: {
  entries: readonly SettingsLogEntry[];
  timeZone: string;
  now: string;
}) {
  const nowLocal = wallClockIn(new Date(now), timeZone);
  return (
    <table className="w-full border-collapse text-base">
      <caption className="sr-only">
        Ändringar av inställningar, ägarandelar och konton, senaste först
      </caption>
      <thead>
        <tr className="border-b border-line-strong">
          <th scope="col" className="label h-9 pr-3 text-left font-normal text-subtle">
            När
          </th>
          <th
            scope="col"
            className="label hidden h-9 px-3 text-left font-normal text-subtle sm:table-cell"
          >
            Vem
          </th>
          <th scope="col" className="label h-9 pl-3 text-left font-normal text-subtle">
            Ändring<span className="hidden sm:inline">, före → efter</span>
          </th>
        </tr>
      </thead>
      <tbody>
        {entries.map((e) => (
          <tr key={e.id} className="border-b border-line align-top">
            <td className="meta tnum w-0 py-2.5 pr-3 whitespace-nowrap text-muted">
              {formatDateTime(wallClockIn(new Date(e.occurredAt), timeZone), { now: nowLocal })}
              <span className="block text-fg sm:hidden">{e.actor}</span>
            </td>
            <td className="hidden w-0 px-3 py-2.5 whitespace-nowrap text-fg sm:table-cell">
              {e.actor}
            </td>
            <td className="py-2.5 pl-3">
              <span className="text-fg">{e.subject}</span>
              <span className="text-subtle"> · {e.verb.toLowerCase()}</span>
              {e.changes.length > 0 ? (
                <ul className="mt-1 flex flex-col gap-1">
                  {e.changes.map((c) => (
                    <li
                      key={c.label}
                      className="grid grid-cols-1 gap-x-3 text-sm sm:grid-cols-[minmax(0,1fr)_auto]"
                    >
                      <span className="text-subtle">{c.label}</span>
                      <span className="tnum min-w-0 [overflow-wrap:anywhere] sm:text-right">
                        <span className="sr-only">Före </span>
                        <span className="text-muted">{c.before ?? MISSING}</span>
                        <span aria-hidden className="text-faint">
                          {" "}
                          →{" "}
                        </span>
                        <span className="sr-only">, efter </span>
                        <span className="text-fg">{c.after ?? MISSING}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              ) : null}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
