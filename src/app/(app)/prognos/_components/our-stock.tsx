"use client";

import { useMemo, useState } from "react";

import { Select } from "@/components/ui/field";
import { StateMessage } from "@/components/ui/state-message";

import { RegisterDialog, type RegisterTarget } from "../../lager/_components/register-dialog";
import { WarehouseList } from "../../lager/_components/warehouse-list";
import type { LagerTitle, WarehouseRow } from "../../lager/_lib/types";

/**
 * Vårt lager (alla egna lager tillsammans) under Prognos & inköp: antal per titel, hur länge det räcker
 * och veckans behov. Tryck på en rad för att inventera; "Inventera annan titel" för en
 * titel som inte står i listan än.
 */
export function OurStock({
  rows,
  titles,
  timeZone,
  now,
  windowDays,
  canRegister,
}: {
  rows: WarehouseRow[];
  titles: LagerTitle[];
  timeZone: string;
  now: string;
  windowDays: number;
  canRegister: boolean;
}) {
  const [titleId, setTitleId] = useState<string | null>(null);
  const titleMap = useMemo(() => new Map(titles.map((t) => [t.id, t])), [titles]);
  const listed = useMemo(() => new Set(rows.map((r) => r.titleId)), [rows]);
  const others = useMemo(() => titles.filter((t) => !listed.has(t.id)), [titles, listed]);

  const target: RegisterTarget | null = useMemo(() => {
    const title = titleId ? titleMap.get(titleId) : undefined;
    if (!title) return null;
    return { kind: "warehouse", title, row: rows.find((r) => r.titleId === title.id) ?? null };
  }, [titleId, titleMap, rows]);

  return (
    <div className="flex flex-col gap-4">
      {rows.length === 0 ? (
        <StateMessage kind="empty" message="Inget i vårt lager än." />
      ) : (
        <WarehouseList
          rows={rows}
          titles={titleMap}
          timeZone={timeZone}
          now={now}
          canRegister={canRegister}
          onSelect={(t) => setTitleId(t.id)}
        />
      )}
      {canRegister && others.length > 0 ? (
        <Select
          label="Inventera annan titel"
          wrapperClassName="max-w-sm"
          value=""
          onChange={(e) => {
            if (e.target.value) setTitleId(e.target.value);
          }}
          options={[
            { value: "", label: "Välj titel …" },
            ...others.map((t) => ({ value: t.id, label: t.name })),
          ]}
        />
      ) : null}
      <RegisterDialog
        target={target}
        warehouseOnHand={target?.kind === "warehouse" ? (target.row?.onHand ?? 0) : 0}
        hasWarehouse
        windowDays={windowDays}
        canSetAlert={false}
        onClose={() => setTitleId(null)}
      />
    </div>
  );
}
