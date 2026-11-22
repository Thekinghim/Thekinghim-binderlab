"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { ButtonLink } from "@/components/v2/button";
import { Empty } from "@/components/v2/empty";

import { plural, tenthsText } from "../_lib/display";
import type { LagerView } from "../_lib/types";
import { PackList } from "./pack-list";
import { RegisterDialog, type RegisterTarget } from "./register-dialog";
import { StockMatrix } from "./stock-matrix";

/** "Obsidian Flames och Paradox Rift har gått ur sortimentet och visas inte." */
function retiredText(names: readonly string[]): string {
  const list =
    names.length > 3
      ? plural(names.length, "titel", "titlar")
      : names.length <= 1
        ? (names[0] ?? "")
        : `${names.slice(0, -1).join(", ")} och ${names[names.length - 1]}`;
  return `${list} har gått ur sortimentet, finns inte kvar i någon automat och visas inte.`;
}

type Selection = { kind: "machine"; machineId: string; titleId: string };

/**
 * Lagret i automaterna: matrisen och påfyllningslistan, med en gemensam
 * registreringsdialog. Vårt eget lager (centrallagret) ligger under Prognos & inköp.
 * Dialogen läser alltid cellen ur den senaste vyn, så
 * att saldot är aktuellt när sidan räknats om efter en registrering.
 */
export function LagerBoard({
  view,
  focus,
}: {
  view: LagerView;
  /** Öppna dialogen för den här cellen direkt (länk från Att göra: ?automat= &titel=). */
  focus: { machineId: string; titleId: string } | null;
}) {
  const pathname = usePathname();
  const searchParams = useSearchParams();

  const initial = useMemo<Selection | null>(() => {
    if (!focus || !view.canRegister) return null;
    const i = view.titles.findIndex((t) => t.id === focus.titleId);
    const j = view.machines.findIndex((m) => m.id === focus.machineId);
    return i >= 0 && j >= 0 ? { kind: "machine", ...focus } : null;
    // eslint-disable-next-line react-hooks/exhaustive-deps -- bara vid första visningen
  }, []);
  const [selection, setSelection] = useState<Selection | null>(initial);
  const [packMachine, setPackMachine] = useState<string>(
    focus?.machineId && view.machines.some((m) => m.id === focus.machineId)
      ? focus.machineId
      : (view.packLists.find((p) => p.totalPacks > 0)?.machineId ?? view.machines[0]?.id ?? ""),
  );

  const titleById = useMemo(() => new Map(view.titles.map((t) => [t.id, t])), [view.titles]);
  const allTitles = useMemo(() => {
    const map = new Map(titleById);
    for (const h of view.history) {
      if (!map.has(h.titleId)) map.set(h.titleId, { id: h.titleId, name: h.titleName });
    }
    return map;
  }, [titleById, view.history]);
  const warehouseOnHand = useMemo(
    () => new Map(view.warehouse.map((w) => [w.titleId, w.onHand])),
    [view.warehouse],
  );

  const target: RegisterTarget | null = useMemo(() => {
    if (!selection) return null;
    const title = allTitles.get(selection.titleId);
    if (!title) return null;
    const i = view.titles.findIndex((t) => t.id === selection.titleId);
    const j = view.machines.findIndex((m) => m.id === selection.machineId);
    const machine = view.machines[j];
    const cell = view.cells[i]?.[j];
    if (!machine || !cell) return null;
    return { kind: "machine", machine, title, cell };
  }, [selection, allTitles, view]);

  const close = useCallback(() => {
    setSelection(null);
    // Länken från Att göra öppnade dialogen: ta bort ?titel så att den inte öppnas igen.
    // history.replaceState (Next synkar useSearchParams) i stället för en ny navigering.
    if (searchParams.has("titel")) {
      const next = new URLSearchParams(searchParams.toString());
      next.delete("titel");
      const qs = next.toString();
      window.history.replaceState(null, "", qs ? `${pathname}?${qs}` : pathname);
    }
  }, [pathname, searchParams]);

  const { counts, window: salesWindow } = view;
  const hasMachines = view.machines.length > 0;
  const packFirst = view.packListFirst && hasMachines;
  const cellsTotal = counts.critical + counts.low + counts.ok + view.unknownCount;

  const packSection =
    view.machines.length > 0 ? (
      <PackList
        machines={view.machines}
        lists={view.packLists}
        machineId={packMachine}
        onMachine={setPackMachine}
        today={view.today}
        canRegister={view.canRegister}
        onSelect={(m, line) =>
          setSelection({ kind: "machine", machineId: m.id, titleId: line.titleId })
        }
      />
    ) : null;

  return (
    <>
      {packFirst ? packSection : null}

      <section aria-labelledby="matris" className="v2-card">
        <div className="v2-card-hd">
          <h2 id="matris" className="min-w-0">
            {hasMachines
              ? `${plural(cellsTotal, "plats", "platser")} i ${plural(view.machines.length, "automat", "automater")}`
              : "Ingen automat i urvalet"}
          </h2>
          {hasMachines ? (
            <span className="text-v2-xs text-v2-mute max-[900px]:hidden">
              {`Dagar kvar (${salesWindow.days} d). Snart slut under ${tenthsText(view.lowThresholdTenths)} d.`}
            </span>
          ) : null}
        </div>
        {view.machines.length === 0 || view.titles.length === 0 ? (
          <Empty
            title={
              view.machines.length === 0
                ? "Ingen automat i drift i urvalet."
                : "Inget lager registrerat i automaterna."
            }
            action={
              view.machines.length === 0 ? (
                <ButtonLink href="/automater" variant="act" touch>
                  Placera automat
                </ButtonLink>
              ) : undefined
            }
          />
        ) : (
          <StockMatrix
            machines={view.machines}
            titles={view.titles}
            cells={view.cells}
            windowDays={salesWindow.days}
            timeZone={view.timeZone}
            now={view.now}
            canRegister={view.canRegister}
            onSelect={(m, t) => setSelection({ kind: "machine", machineId: m.id, titleId: t.id })}
          />
        )}
        {hasMachines && view.retiredTitles.length > 0 ? (
          <p className="ops-p border-t border-v2-line2 px-[18px] py-3 max-[900px]:px-4">
            {retiredText(view.retiredTitles.map((t) => t.name))}
          </p>
        ) : null}
      </section>

      {packFirst ? null : packSection}

      <RegisterDialog
        target={target}
        warehouseOnHand={target ? (warehouseOnHand.get(target.title.id) ?? 0) : 0}
        hasWarehouse={view.hasWarehouse}
        windowDays={salesWindow.days}
        canSetAlert={view.canSetAlert}
        onClose={close}
      />
    </>
  );
}
