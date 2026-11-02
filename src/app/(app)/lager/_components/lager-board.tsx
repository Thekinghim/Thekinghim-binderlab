"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useMemo, useState } from "react";

import { SectionHeader } from "@/components/ui/section-header";
import { StateMessage } from "@/components/ui/state-message";

import { formatInt } from "@/lib/format";

import { formatIsoDate, packs, plural, tenthsText } from "../_lib/display";
import { WAREHOUSE_LOW_DAYS, type LagerView } from "../_lib/types";
import { PackList } from "./pack-list";
import { RegisterDialog, type RegisterTarget } from "./register-dialog";
import { StockMatrix } from "./stock-matrix";
import { WarehouseList } from "./warehouse-list";

/**
 * "1 titel räcker inte till veckans besök, 2 till räcker kortare än 7 dagar vid alla
 * automaters takt." `lowOnly` är titlar som räcker till veckan men är Låg på dagar.
 */
function warehouseAside(short: number, lowOnly: number): string {
  const days = `kortare än ${formatInt(WAREHOUSE_LOW_DAYS)} dagar vid alla automaters takt`;
  if (short > 0 && lowOnly > 0) {
    return `${plural(short, "titel", "titlar")} räcker inte till veckans besök, ${formatInt(lowOnly)} till räcker ${days}.`;
  }
  if (short > 0)
    return `${plural(short, "titel räcker", "titlar räcker")} inte till veckans besök.`;
  if (lowOnly > 0) {
    return `Räcker till veckans besök. ${plural(lowOnly, "titel räcker", "titlar räcker")} ${days}.`;
  }
  return "Räcker till veckans besök.";
}

type Selection =
  { kind: "machine"; machineId: string; titleId: string } | { kind: "warehouse"; titleId: string };

/**
 * Lagrets interaktiva del: matrisen, påfyllningslistan och centrallagret, med en
 * gemensam registreringsdialog. Dialogen läser alltid cellen ur den senaste vyn, så
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
    if (selection.kind === "warehouse") {
      return {
        kind: "warehouse",
        title,
        row: view.warehouse.find((w) => w.titleId === selection.titleId) ?? null,
      };
    }
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
  const packFirst = view.packListFirst && view.machines.length > 0;
  const matrixIndex = packFirst ? 2 : 1;
  const packIndex = packFirst ? 1 : 2;
  const cellsTotal = counts.critical + counts.low + counts.ok;
  const warehouseTotal = view.warehouse.reduce((s, w) => s + Math.max(0, w.onHand), 0);
  const warehouseShort = view.warehouse.filter((w) => w.shortBy > 0);
  const warehouseLow = view.warehouse.filter((w) => w.status !== "ok");

  const packSection =
    view.machines.length > 0 ? (
      <section aria-labelledby="pafyllningslista">
        <PackList
          machines={view.machines}
          lists={view.packLists}
          machineId={packMachine}
          onMachine={setPackMachine}
          today={view.today}
          index={packIndex}
          canRegister={view.canRegister}
          onSelect={(m, line) =>
            setSelection({ kind: "machine", machineId: m.id, titleId: line.titleId })
          }
        />
      </section>
    ) : null;

  return (
    <>
      {packFirst ? packSection : null}

      <section aria-labelledby="matris" className="flex flex-col gap-6 md:gap-10">
        <SectionHeader
          id="matris"
          index={matrixIndex}
          eyebrow={`Lager per automat · ${salesWindow.days} d`}
          title={`${plural(cellsTotal, "plats", "platser")} i ${plural(view.machines.length, "automat", "automater")}.`}
          aside={`En plats är en titel i en automat. Dagar kvar vid takten ${formatIsoDate(salesWindow.start, view.today)} – ${formatIsoDate(salesWindow.end, view.today)}, låg under ${tenthsText(view.lowThresholdTenths)} dagar.`}
        />
        {view.machines.length === 0 || view.titles.length === 0 ? (
          <StateMessage
            kind="empty"
            message={
              view.machines.length === 0
                ? "Ingen automat i drift i urvalet."
                : "Inget lager registrerat i automaterna."
            }
          />
        ) : (
          <StockMatrix
            machines={view.machines}
            titles={view.titles}
            cells={view.cells}
            windowDays={salesWindow.days}
            canRegister={view.canRegister}
            onSelect={(m, t) => setSelection({ kind: "machine", machineId: m.id, titleId: t.id })}
          />
        )}
      </section>

      {packFirst ? null : packSection}

      {view.hasWarehouse ? (
        <section aria-labelledby="centrallager" className="flex flex-col gap-6 md:gap-10">
          <SectionHeader
            id="centrallager"
            index={3}
            eyebrow="Centrallager"
            title={`${packs(warehouseTotal)} i centrallagret.`}
            aside={warehouseAside(
              warehouseShort.length,
              warehouseLow.length - warehouseShort.length,
            )}
          />
          {view.warehouse.length === 0 ? (
            <StateMessage kind="empty" message="Centrallagret är tomt och inget behövs i veckan." />
          ) : (
            <WarehouseList
              rows={view.warehouse}
              titles={allTitles}
              timeZone={view.timeZone}
              now={view.now}
              canRegister={view.canRegister}
              onSelect={(t) => setSelection({ kind: "warehouse", titleId: t.id })}
            />
          )}
        </section>
      ) : null}

      <RegisterDialog
        target={target}
        warehouseOnHand={target ? (warehouseOnHand.get(target.title.id) ?? 0) : 0}
        hasWarehouse={view.hasWarehouse}
        windowDays={salesWindow.days}
        onClose={close}
      />
    </>
  );
}
