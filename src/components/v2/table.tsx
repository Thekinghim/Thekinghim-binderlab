import Link from "next/link";
import type { ReactNode } from "react";

import { cn } from "@/lib/cn";

export type TableColumn<T> = {
  key: string;
  header: ReactNode;
  cell: (row: T) => ReactNode;
  /** Tal står högerställda med tabulära siffror. */
  align?: "left" | "right";
  /** Dölj kolumnen under 900 px (telefon). Den viktigaste kolumnen döljs aldrig. */
  hideOnPhone?: boolean;
  /** Fast bredd, t.ex. "96px" eller "20%". */
  width?: string;
};

/**
 * Tabell i V2 (prototypens tabeller på Pengar och Automater): rubrikrad 12 px grå på #F7F7F7,
 * rader 13 px med 1 px #EBEBEB emellan, tal högerställda och tabulära. Står i ett Card utan
 * CardBody (tabellen går kant i kant). Rullar i sidled på telefon i stället för att trycka ihop
 * kolumnerna; dölj hellre mindre viktiga kolumner med hideOnPhone.
 *
 *   <Card title="Avtal" count={rows.length}>
 *     <Table caption="Avtal per butik" rows={rows} rowKey={(r) => r.id} columns={[
 *       { key: "butik", header: "Butik", cell: (r) => r.name },
 *       { key: "andel", header: "Andel", align: "right", cell: (r) => fmtPct(r.share) },
 *     ]} empty="Inga avtal än." />
 *   </Card>
 *
 * För sortering, kolumnval och CSV-export: den gamla DataTable (src/components/ui/data-table),
 * som i V2-skalet redan får V2:s typsnitt och färger. Klasserna (.v2-table) går att använda
 * direkt på en egen <table>.
 */
export function Table<T>({
  columns,
  rows,
  rowKey,
  caption,
  empty,
  footer,
  className,
  onRowHref,
}: {
  columns: ReadonlyArray<TableColumn<T>>;
  rows: ReadonlyArray<T>;
  rowKey: (row: T) => string;
  /** Tabellens namn för skärmläsare (visas inte). */
  caption: string;
  /** Text när det inte finns några rader. */
  empty?: ReactNode;
  /** En summarad (tfoot), samma kolumner. */
  footer?: Partial<Record<string, ReactNode>>;
  className?: string;
  /** Hela raden länkar hit (första cellen får länken, raden får hover). */
  onRowHref?: (row: T) => string | undefined;
}) {
  const cls = (c: TableColumn<T>) =>
    cn(c.align === "right" && "num", c.hideOnPhone && "ph-hide") || undefined;
  return (
    <div className={cn("v2-table-wrap", className)}>
      <table className="v2-table">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            {columns.map((c) => (
              <th key={c.key} scope="col" className={cls(c)} style={{ width: c.width }}>
                {c.header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={columns.length} className="none">
                {empty ?? "Inget att visa."}
              </td>
            </tr>
          ) : (
            rows.map((r) => {
              const href = onRowHref?.(r);
              return (
                <tr key={rowKey(r)} className={href ? "lnk" : undefined}>
                  {columns.map((c, i) => (
                    <td key={c.key} className={cls(c)}>
                      {href && i === 0 ? <Link href={href}>{c.cell(r)}</Link> : c.cell(r)}
                    </td>
                  ))}
                </tr>
              );
            })
          )}
        </tbody>
        {footer ? (
          <tfoot>
            <tr>
              {columns.map((c) => (
                <td key={c.key} className={cls(c)}>
                  {footer[c.key] ?? null}
                </td>
              ))}
            </tr>
          </tfoot>
        ) : null}
      </table>
    </div>
  );
}
