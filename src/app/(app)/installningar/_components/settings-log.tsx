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
    <div className="v2-table-wrap">
      <table className="v2-table">
        <caption className="sr-only">
          Ändringar av inställningar, ägarandelar och konton, senaste först
        </caption>
        <thead>
          <tr>
            <th scope="col">När</th>
            <th scope="col" className="max-sm:hidden">
              Vem
            </th>
            <th scope="col">
              Ändring<span className="hidden sm:inline">, före → efter</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="align-top">
              <td className="w-0 align-top whitespace-nowrap text-v2-mute">
                {formatDateTime(wallClockIn(new Date(e.occurredAt), timeZone), { now: nowLocal })}
                <span className="block text-v2-ink sm:hidden">{e.actor}</span>
              </td>
              <td className="w-0 align-top whitespace-nowrap max-sm:hidden">{e.actor}</td>
              <td className="align-top">
                <span className="font-[550]">{e.subject}</span>
                <span className="text-v2-mute"> · {e.verb.toLowerCase()}</span>
                {e.changes.length > 0 ? (
                  <ul className="mt-1 flex flex-col gap-1">
                    {e.changes.map((c) => (
                      <li
                        key={c.label}
                        className="grid grid-cols-1 gap-x-3 text-v2-sm sm:grid-cols-[minmax(0,1fr)_auto]"
                      >
                        <span className="text-v2-mute">{c.label}</span>
                        <span className="min-w-0 [overflow-wrap:anywhere] tabular-nums sm:text-right">
                          <span className="sr-only">Före </span>
                          <span className="text-v2-mute">{c.before ?? MISSING}</span>
                          <span aria-hidden className="text-v2-faint">
                            {" "}
                            →{" "}
                          </span>
                          <span className="sr-only">, efter </span>
                          <span className="text-v2-ink">{c.after ?? MISSING}</span>
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
    </div>
  );
}
