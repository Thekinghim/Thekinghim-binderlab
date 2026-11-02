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
    <div className="-mx-4 overflow-x-auto px-4 md:mx-0 md:px-0">
      <table className="w-full min-w-[600px] border-collapse text-base">
        <caption className="sr-only">
          Ändringar av inställningar, ägarandelar och konton, senaste först
        </caption>
        <thead>
          <tr className="border-b border-line-strong">
            {["När", "Vem", "Ändring", "Före", "Efter"].map((h, i) => (
              <th
                key={h}
                scope="col"
                className={`label h-9 px-3 font-normal text-subtle ${i === 0 ? "pl-0" : ""} ${i >= 3 ? "text-right" : "text-left"} ${i === 4 ? "pr-0" : ""}`}
              >
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {entries.map((e) => (
            <tr key={e.id} className="border-b border-line align-top">
              <td className="meta tnum py-2.5 pr-3 whitespace-nowrap text-muted">
                {formatDateTime(wallClockIn(new Date(e.occurredAt), timeZone), { now: nowLocal })}
              </td>
              <td className="px-3 py-2.5 text-fg">{e.actor}</td>
              <td className="px-3 py-2.5">
                <span className="text-fg">{e.subject}</span>
                <span className="text-subtle"> · {e.verb.toLowerCase()}</span>
                {e.changes.length > 0 ? (
                  <ul className="mt-1 flex flex-col gap-0.5">
                    {e.changes.map((c) => (
                      <li key={c.label} className="text-sm text-subtle">
                        {c.label}
                      </li>
                    ))}
                  </ul>
                ) : null}
              </td>
              <td className="px-3 py-2.5 text-right">
                <ul className="mt-6 flex flex-col gap-0.5">
                  {e.changes.map((c) => (
                    <li key={c.label} className="tnum text-sm whitespace-nowrap text-muted">
                      {c.before ?? MISSING}
                    </li>
                  ))}
                </ul>
              </td>
              <td className="py-2.5 pr-0 pl-3 text-right">
                <ul className="mt-6 flex flex-col gap-0.5">
                  {e.changes.map((c) => (
                    <li key={c.label} className="tnum text-sm whitespace-nowrap text-fg">
                      {c.after ?? MISSING}
                    </li>
                  ))}
                </ul>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
