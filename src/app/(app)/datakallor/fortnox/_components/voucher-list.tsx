/**
 * Verifikat som en lista: datum, text, summa och raderna (konto, debet, kredit). Används i
 * torrkörningen (det som skulle skickas) och i listan över det som är skickat. Ryms på
 * 375 px utan sidledes rullning: raderna är tre smala kolumner med texten under.
 */

import { cn } from "@/lib/cn";
import { formatDate, formatKronor } from "@/lib/format";
import type { ReactNode } from "react";

export interface VoucherView {
  readonly key: string;
  readonly date: string;
  readonly description: string;
  readonly rows: readonly { account: string; amountOre: number; text: string }[];
  /** T.ex. "A 12" eller "Väntar". */
  readonly tag?: string;
  readonly tagTone?: "ok" | "warn" | "info";
  /** Text under rubriken (orsak till stopp m.m.). */
  readonly note?: string | null;
  readonly action?: ReactNode;
}

const kr = (ore: number) => formatKronor(ore / 100, { decimals: 2 });
const day = (iso: string) => formatDate(new Date(`${iso}T12:00:00Z`), { year: "always" });

const TONE = {
  ok: "border-line text-fg",
  warn: "border-signal-line text-signal-fg",
  info: "border-line text-muted",
} as const;

export function VoucherList({
  vouchers,
  empty,
  label,
}: {
  vouchers: readonly VoucherView[];
  empty: string;
  label: string;
}) {
  if (vouchers.length === 0) return <p className="text-sm text-muted">{empty}</p>;
  return (
    <ul aria-label={label} className="flex flex-col divide-y divide-line border-y border-line">
      {vouchers.map((v) => {
        const total = v.rows.reduce((n, r) => n + (r.amountOre > 0 ? r.amountOre : 0), 0);
        return (
          <li key={v.key} data-voucher={v.key} className="flex flex-col gap-2 py-3">
            <details className="group min-w-0">
              <summary className="flex min-h-11 cursor-pointer list-none flex-wrap items-center gap-x-3 gap-y-1">
                <span className="meta tnum shrink-0 text-subtle">{day(v.date)}</span>
                <span className="min-w-0 flex-1 basis-40 text-base break-words text-fg">
                  {v.description}
                </span>
                {v.rows.length > 0 ? (
                  <span className="tnum shrink-0 text-fg">{kr(total)}</span>
                ) : null}
                {v.tag ? (
                  <span
                    className={cn(
                      "meta tnum shrink-0 rounded-sm border px-1.5 py-0.5",
                      TONE[v.tagTone ?? "info"],
                    )}
                  >
                    {v.tag}
                  </span>
                ) : null}
              </summary>
              {v.rows.length > 0 ? (
                <table className="mt-2 w-full table-fixed text-sm">
                  <thead>
                    <tr className="label text-left text-subtle">
                      <th scope="col" className="w-14 py-1 font-normal">
                        Konto
                      </th>
                      <th scope="col" className="py-1 text-right font-normal">
                        Debet
                      </th>
                      <th scope="col" className="py-1 text-right font-normal">
                        Kredit
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {v.rows.map((r, i) => (
                      <tr key={i} className="border-t border-line align-top">
                        <td className="tnum py-1.5 text-fg">{r.account}</td>
                        <td className="tnum py-1.5 text-right text-fg">
                          {r.amountOre > 0 ? kr(r.amountOre) : ""}
                          <span className="block text-xs break-words text-subtle">
                            {r.amountOre > 0 ? r.text : ""}
                          </span>
                        </td>
                        <td className="tnum py-1.5 text-right text-fg">
                          {r.amountOre < 0 ? kr(-r.amountOre) : ""}
                          <span className="block text-xs break-words text-subtle">
                            {r.amountOre < 0 ? r.text : ""}
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : null}
            </details>
            {v.note ? <p className="text-sm break-words text-muted">{v.note}</p> : null}
            {v.action ? <div>{v.action}</div> : null}
          </li>
        );
      })}
    </ul>
  );
}
