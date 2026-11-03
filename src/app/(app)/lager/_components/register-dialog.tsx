"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Segmented } from "@/components/ui/segmented";
import { StatusTag } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";
import { formatInt, MINUS, NBSP } from "@/lib/format";

import { registerCount, registerRefill, registerWaste, setSlotAlert } from "../actions";
import { daysLeftLong, packs, STATUS_LABEL, statusTone } from "../_lib/display";
import type { RegisterResult } from "../_lib/register";
import type { LagerMachine, LagerTitle, StockCell, WarehouseRow } from "../_lib/types";
import { Sheet } from "./sheet";

export type RegisterTarget =
  | { kind: "machine"; machine: LagerMachine; title: LagerTitle; cell: StockCell }
  | { kind: "warehouse"; title: LagerTitle; row: WarehouseRow | null };

type Mode = "refill" | "count" | "waste";

const MODES = [
  { value: "refill", label: "Påfyllning" },
  { value: "count", label: "Inventering" },
  { value: "waste", label: "Svinn" },
] as const;

const DONE: Record<Mode, string> = {
  refill: "Påfyllning registrerad",
  count: "Inventering registrerad",
  waste: "Svinn registrerat",
};

/** Heltal ur fältet, eller null om det inte är ett heltal ≥ 0. */
function parseCount(raw: string): number | null {
  const t = raw.replace(/[\s  ]/g, "");
  if (!/^\d{1,6}$/.test(t)) return null;
  return Number(t);
}

function capitalize(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function signed(n: number): string {
  if (n === 0) return `±0${NBSP}pack`;
  return `${n > 0 ? "+" : MINUS}${formatInt(Math.abs(n))}${NBSP}pack`;
}

/**
 * Registrera påfyllning eller inventering för en cell (titel i automat) eller för
 * centrallagret (bara inventering). Stora tryckytor och sifferfält; bekräftelsen visar
 * det nya saldot som databasen räknat fram.
 */
export function RegisterDialog({
  target,
  warehouseOnHand,
  hasWarehouse,
  windowDays,
  canSetAlert,
  onClose,
}: {
  target: RegisterTarget | null;
  /** Centrallagrets saldo för titeln (för "Ta från centrallagret"). */
  warehouseOnHand: number;
  hasWarehouse: boolean;
  windowDays: number;
  /** Ägare och admin: fältet "Larma vid". Andra roller ser bara värdet. */
  canSetAlert: boolean;
  onClose: () => void;
}) {
  const formId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const toast = useToast();
  const [mode, setMode] = useState<Mode>("refill");
  const [value, setValue] = useState("");
  const [note, setNote] = useState("");
  const [noteError, setNoteError] = useState<string | undefined>();
  const [alertValue, setAlertValue] = useState("");
  const [alertError, setAlertError] = useState<string | undefined>();
  const [alertPending, startAlert] = useTransition();
  const [fromWarehouse, setFromWarehouse] = useState(true);
  const [error, setError] = useState<string | undefined>();
  const [result, setResult] = useState<(RegisterResult & { mode: Mode }) | null>(null);
  const [pending, startTransition] = useTransition();

  const targetKey =
    target === null
      ? null
      : target.kind === "machine"
        ? `m:${target.machine.id}:${target.title.id}`
        : `w:${target.title.id}`;

  // Ny cell: börja om (justering under rendering, inte i en effekt). Påfyllning föreslår
  // antalet ur påfyllningslistan.
  const [shownKey, setShownKey] = useState<string | null>(null);
  if (targetKey !== shownKey) {
    setShownKey(targetKey);
    if (target) {
      const isMachine = target.kind === "machine";
      // Okänt saldo: börja med inventering (det som gör saldot känt).
      setMode(isMachine && target.cell.known ? "refill" : "count");
      setValue(isMachine && target.cell.suggested > 0 ? String(target.cell.suggested) : "");
      setFromWarehouse(hasWarehouse && warehouseOnHand > 0);
      setError(undefined);
      setNote("");
      setNoteError(undefined);
      setAlertValue(isMachine && target.cell.alertAt !== null ? String(target.cell.alertAt) : "");
      setAlertError(undefined);
      setResult(null);
    }
  }

  // Fokus i sifferfältet när arket öppnats.
  useEffect(() => {
    if (targetKey === null) return;
    const id = window.setTimeout(() => inputRef.current?.select(), 60);
    return () => window.clearTimeout(id);
  }, [targetKey]);

  useEffect(() => {
    if (result) resultRef.current?.focus();
  }, [result]);

  if (!target) {
    return <Sheet open={false} onClose={onClose} title="Lager" />;
  }

  const isMachine = target.kind === "machine";
  const onHand = isMachine ? target.cell.onHand : (target.row?.onHand ?? 0);
  const place = isMachine ? target.machine.code : "Vårt lager";
  const n = parseCount(value);
  const useWarehouse = isMachine && mode === "refill" && hasWarehouse && fromWarehouse;
  // Svinn kräver ett räknat saldo (påfyllning eller inventering).
  const wasteBlocked = mode === "waste" && (!isMachine || target.cell.lastRestockedAt === null);
  const after =
    n === null ? null : mode === "refill" ? onHand + n : mode === "waste" ? onHand - n : n;

  // "Nuvarande saldo → Saldo efter", bara för ett giltigt värde (aldrig bredvid ett fel).
  const preview =
    after !== null && validate() === undefined
      ? `Saldo ${formatInt(onHand)} → ${packs(after)}${mode === "count" && after !== onHand ? ` (${signed(after - onHand)})` : ""}.`
      : null;

  function validate(): string | undefined {
    if (wasteBlocked) return "Inventera först.";
    if (n === null) return mode === "count" ? "Ange räknat antal." : "Ange antal pack.";
    if (mode !== "count" && n < 1) return "Ange antal pack, minst 1.";
    if (mode === "waste" && n > onHand) return `Saldot är ${packs(onHand)}.`;
    if (n > 10_000) return `Högst ${formatInt(10_000)} pack.`;
    if (useWarehouse && n > warehouseOnHand) {
      return `Vårt lager har ${packs(warehouseOnHand)}. Ta bort bocken för att fylla på från annat håll, eller inventera vårt lager.`;
    }
    return undefined;
  }

  function submit() {
    if (!target) return;
    const problem = validate();
    const noteProblem = mode === "waste" && note.trim() === "" ? "Skriv orsaken." : undefined;
    setError(problem);
    setNoteError(noteProblem);
    if (problem || n === null) {
      inputRef.current?.focus();
      return;
    }
    if (noteProblem) return;
    const currentMode = mode;
    startTransition(async () => {
      const res =
        currentMode === "refill" && target.kind === "machine"
          ? await registerRefill({
              machineId: target.machine.id,
              titleId: target.title.id,
              quantity: n,
              fromWarehouse: useWarehouse,
            })
          : currentMode === "waste" && target.kind === "machine"
            ? await registerWaste({
                machineId: target.machine.id,
                titleId: target.title.id,
                quantity: n,
                note: note.trim(),
              })
            : await registerCount(
                target.kind === "machine"
                  ? {
                      location: "machine",
                      machineId: target.machine.id,
                      titleId: target.title.id,
                      counted: n,
                    }
                  : { location: "warehouse", titleId: target.title.id, counted: n },
              );
      if (!res.ok) {
        setError(res.error);
        inputRef.current?.focus();
        return;
      }
      setResult({ ...res.data, mode: currentMode });
      toast({
        title: DONE[currentMode],
        description: `${target.title.name} i ${place}: ${packs(res.data.onHand)}.`,
        tone: "ok",
      });
    });
  }

  function saveAlert() {
    if (!target || target.kind !== "machine") return;
    const raw = alertValue.trim();
    const units = raw === "" ? null : parseCount(raw);
    if (raw !== "" && (units === null || units > 10_000)) {
      setAlertError("Ange ett antal, 0 eller mer.");
      return;
    }
    if (units === target.cell.alertAt) return;
    const { machine, title: t } = target;
    startAlert(async () => {
      const res = await setSlotAlert({ machineId: machine.id, titleId: t.id, alertAtUnits: units });
      if (!res.ok) {
        setAlertError(res.error);
        return;
      }
      toast({
        title: res.alertAtUnits === null ? "Larm av" : `Larmar vid ${packs(res.alertAtUnits)}`,
        description: `${t.name} i ${machine.code}.`,
        tone: "ok",
      });
    });
  }

  const title = `${target.title.name} i ${place}`;

  return (
    <Sheet
      open
      onClose={onClose}
      eyebrow={isMachine ? `${target.machine.code} / ${target.machine.name}` : "Vårt lager"}
      title={title}
      footer={
        result ? (
          <Button variant="primary" className="min-h-11" onClick={onClose}>
            Klar
          </Button>
        ) : (
          <>
            <Button className="min-h-11" onClick={onClose}>
              Avbryt
            </Button>
            <Button
              variant="primary"
              className="min-h-11"
              type="submit"
              form={formId}
              loading={pending}
            >
              {mode === "refill"
                ? "Registrera påfyllning"
                : mode === "waste"
                  ? "Registrera svinn"
                  : "Registrera inventering"}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="flex flex-col gap-3" aria-live="polite">
          <p className="label text-subtle">{DONE[result.mode]}</p>
          <p
            ref={resultRef}
            tabIndex={-1}
            className="tnum flex items-baseline gap-2 text-3xl font-medium focus:outline-none"
          >
            {formatInt(result.onHand)}
            <span className="text-md text-muted">pack i {place}</span>
          </p>
          <p className="text-base text-muted">
            {result.mode !== "count"
              ? `Var ${packs(result.previous)}, ${signed(result.onHand - result.previous)}.`
              : result.onHand === result.previous
                ? "Saldot stämde med systemet."
                : `Systemet visade ${packs(result.previous)}, ${signed(result.onHand - result.previous)}.`}
            {result.warehouseOnHand !== null
              ? ` ${result.placeName ?? "Vårt lager"} har nu ${packs(result.warehouseOnHand)}.`
              : ""}
          </p>
        </div>
      ) : (
        <form
          id={formId}
          noValidate
          className="flex flex-col gap-5"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <dl className="grid grid-cols-2 gap-x-4 gap-y-1">
            <dt className="label text-subtle">I {isMachine ? "automaten" : "vårt lager"}</dt>
            <dt className="label text-subtle">Status</dt>
            <dd className="tnum text-xl font-medium">
              {isMachine && !target.cell.known ? "Saldo okänt" : packs(onHand)}
            </dd>
            <dd className="flex items-center">
              {isMachine && !target.cell.known ? null : isMachine ? (
                <StatusTag status={statusTone(target.cell.status, target.cell.onHand)}>
                  {STATUS_LABEL[target.cell.status]}
                </StatusTag>
              ) : target.row ? (
                <StatusTag status={statusTone(target.row.status, target.row.onHand)}>
                  {STATUS_LABEL[target.row.status]}
                </StatusTag>
              ) : (
                <StatusTag status="ok">{STATUS_LABEL.ok}</StatusTag>
              )}
            </dd>
            {isMachine && target.cell.known ? (
              <dd className="col-span-2 text-sm text-muted">
                {capitalize(daysLeftLong(target.cell, windowDays))}
                {target.cell.suggested > 0
                  ? `. Påfyllningslistan: ${packs(target.cell.suggested)}.`
                  : "."}
                {!canSetAlert && target.cell.alertAt !== null
                  ? ` Larma vid ${packs(target.cell.alertAt)}.`
                  : ""}
              </dd>
            ) : null}
          </dl>

          {isMachine ? (
            <Segmented
              label="Registrera"
              options={MODES}
              value={mode}
              onChange={(m) => {
                setMode(m);
                setError(undefined);
                setNoteError(undefined);
                setValue(
                  m === "refill" && target.cell.suggested > 0 ? String(target.cell.suggested) : "",
                );
              }}
              className="h-auto! w-full [&>button]:min-h-11 [&>button]:flex-1"
            />
          ) : null}

          <Input
            ref={inputRef}
            label={
              mode === "refill"
                ? "Antal påfyllda pack"
                : mode === "waste"
                  ? "Antal pack svinn"
                  : "Räknat antal i " + place
            }
            disabled={wasteBlocked}
            hint={wasteBlocked ? "Inventera först." : undefined}
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            enterKeyHint="done"
            suffix="pack"
            value={value}
            error={error}
            onChange={(e) => {
              setValue(e.target.value);
              if (error) setError(undefined);
            }}
            className="tnum min-h-12 text-right text-xl!"
          />

          {mode === "waste" ? (
            <Input
              label="Orsak"
              autoComplete="off"
              maxLength={500}
              value={note}
              error={noteError}
              disabled={wasteBlocked}
              onChange={(e) => {
                setNote(e.target.value);
                if (noteError) setNoteError(undefined);
              }}
              className="min-h-11"
            />
          ) : null}

          {preview ? (
            <p className="tnum -mt-2 text-base text-fg" aria-live="polite">
              {preview}
            </p>
          ) : null}

          {isMachine && mode === "refill" && hasWarehouse ? (
            <label className="flex min-h-11 cursor-pointer items-center gap-3 text-base">
              <input
                type="checkbox"
                className="size-5 accent-current"
                checked={fromWarehouse}
                onChange={(e) => {
                  setFromWarehouse(e.target.checked);
                  if (error) setError(undefined);
                }}
              />
              <span>
                Ta från vårt lager{" "}
                <span className="tnum text-muted">({packs(warehouseOnHand)} där)</span>
              </span>
            </label>
          ) : null}

          {mode === "count" ? (
            <p className="flex items-start gap-2 text-sm text-muted">
              <Icon name="info" size={14} className="mt-0.5 shrink-0" />
              <span>Räknat antal blir nytt saldo.</span>
            </p>
          ) : null}
        </form>
      )}
      {!result && isMachine && canSetAlert ? (
        <form
          noValidate
          className="mt-5 border-t border-line pt-4"
          onSubmit={(e) => {
            e.preventDefault();
            saveAlert();
          }}
        >
          <Input
            label="Larma vid"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            enterKeyHint="done"
            placeholder="Av"
            suffix="pack"
            value={alertValue}
            error={alertError}
            disabled={alertPending}
            onChange={(e) => {
              setAlertValue(e.target.value);
              if (alertError) setAlertError(undefined);
            }}
            className="tnum min-h-11 text-right"
          />
        </form>
      ) : null}
    </Sheet>
  );
}
