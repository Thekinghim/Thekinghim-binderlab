"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { Segmented } from "@/components/ui/segmented";
import { StatusTag } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";
import { formatInt, MINUS, NBSP } from "@/lib/format";

import { registerCount, registerRefill } from "../actions";
import { daysLeftLong, packs, STATUS_LABEL, STATUS_TONE } from "../_lib/display";
import type { RegisterResult } from "../_lib/register";
import type { LagerMachine, LagerTitle, StockCell, WarehouseRow } from "../_lib/types";

export type RegisterTarget =
  | { kind: "machine"; machine: LagerMachine; title: LagerTitle; cell: StockCell }
  | { kind: "warehouse"; title: LagerTitle; row: WarehouseRow | null };

type Mode = "refill" | "count";

const MODES = [
  { value: "refill", label: "Påfyllning" },
  { value: "count", label: "Inventering" },
] as const;

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
  onClose,
}: {
  target: RegisterTarget | null;
  /** Centrallagrets saldo för titeln (för "Ta från centrallagret"). */
  warehouseOnHand: number;
  hasWarehouse: boolean;
  windowDays: number;
  onClose: () => void;
}) {
  const formId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const resultRef = useRef<HTMLParagraphElement>(null);
  const toast = useToast();
  const [mode, setMode] = useState<Mode>("refill");
  const [value, setValue] = useState("");
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
      setMode(isMachine ? "refill" : "count");
      setValue(isMachine && target.cell.suggested > 0 ? String(target.cell.suggested) : "");
      setFromWarehouse(hasWarehouse && warehouseOnHand > 0);
      setError(undefined);
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
    return <Modal open={false} onClose={onClose} title="Lager" />;
  }

  const isMachine = target.kind === "machine";
  const onHand = isMachine ? target.cell.onHand : (target.row?.onHand ?? 0);
  const place = isMachine ? target.machine.code : "Centrallager";
  const n = parseCount(value);
  const useWarehouse = isMachine && mode === "refill" && hasWarehouse && fromWarehouse;

  let preview: string | null = null;
  if (n !== null) {
    preview =
      mode === "refill"
        ? `Nytt saldo ${formatInt(onHand)} + ${formatInt(n)} = ${packs(onHand + n)}.`
        : n === onHand
          ? `Stämmer med systemet (${packs(onHand)}).`
          : `Systemet visar ${packs(onHand)}. Skillnad ${signed(n - onHand)}.`;
  }

  function validate(): string | undefined {
    if (n === null) return mode === "refill" ? "Ange antal pack." : "Ange räknat antal.";
    if (mode === "refill" && n < 1) return "Ange antal pack, minst 1.";
    if (n > 10_000) return `Högst ${formatInt(10_000)} pack.`;
    if (useWarehouse && n > warehouseOnHand) {
      return `Centrallagret har ${packs(warehouseOnHand)}. Ta bort bocken för att fylla på från annat håll, eller inventera centrallagret.`;
    }
    return undefined;
  }

  function submit() {
    if (!target) return;
    const problem = validate();
    setError(problem);
    if (problem || n === null) {
      inputRef.current?.focus();
      return;
    }
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
        title: currentMode === "refill" ? "Påfyllning registrerad" : "Inventering registrerad",
        description: `${target.title.name} i ${place}: ${packs(res.data.onHand)}.`,
        tone: "ok",
      });
    });
  }

  const title = `${target.title.name} i ${place}`;

  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      eyebrow={isMachine ? `${target.machine.code} / ${target.machine.name}` : "Centrallager"}
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
              {mode === "refill" ? "Registrera påfyllning" : "Registrera inventering"}
            </Button>
          </>
        )
      }
    >
      {result ? (
        <div className="flex flex-col gap-3" aria-live="polite">
          <p className="label text-subtle">
            {result.mode === "refill" ? "Påfyllning registrerad" : "Inventering registrerad"}
          </p>
          <p
            ref={resultRef}
            tabIndex={-1}
            className="tnum flex items-baseline gap-2 text-3xl font-medium focus:outline-none"
          >
            {formatInt(result.onHand)}
            <span className="text-md text-muted">pack i {place}</span>
          </p>
          <p className="text-base text-muted">
            {result.mode === "refill"
              ? `Var ${packs(result.previous)}, ${signed(result.onHand - result.previous)}.`
              : result.onHand === result.previous
                ? "Saldot stämde med systemet."
                : `Systemet visade ${packs(result.previous)}, ${signed(result.onHand - result.previous)}.`}
            {result.warehouseOnHand !== null
              ? ` Centrallagret har nu ${packs(result.warehouseOnHand)}.`
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
            <dt className="label text-subtle">I {isMachine ? "automaten" : "centrallagret"}</dt>
            <dt className="label text-subtle">Status</dt>
            <dd className="tnum text-xl font-medium">{packs(onHand)}</dd>
            <dd className="flex items-center">
              {isMachine ? (
                <StatusTag status={STATUS_TONE[target.cell.status]}>
                  {STATUS_LABEL[target.cell.status]}
                </StatusTag>
              ) : target.row ? (
                <StatusTag status={STATUS_TONE[target.row.status]}>
                  {STATUS_LABEL[target.row.status]}
                </StatusTag>
              ) : (
                <StatusTag status="ok">{STATUS_LABEL.ok}</StatusTag>
              )}
            </dd>
            {isMachine ? (
              <dd className="col-span-2 text-sm text-muted">
                {capitalize(daysLeftLong(target.cell, windowDays))}
                {target.cell.suggested > 0
                  ? `. Påfyllningslistan: ${packs(target.cell.suggested)}.`
                  : "."}
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
                setValue(
                  m === "refill" && target.cell.suggested > 0 ? String(target.cell.suggested) : "",
                );
              }}
              className="min-h-11 w-full [&>button]:flex-1"
            />
          ) : null}

          <Input
            ref={inputRef}
            label={mode === "refill" ? "Antal påfyllda pack" : "Räknat antal i " + place}
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
                Ta från centrallagret{" "}
                <span className="tnum text-muted">({packs(warehouseOnHand)} där)</span>
              </span>
            </label>
          ) : null}

          {mode === "count" ? (
            <p className="flex items-start gap-2 text-sm text-muted">
              <Icon name="info" size={14} className="mt-0.5 shrink-0" />
              <span>
                Räknat antal ersätter saldot. Försäljning efter räkningen dras som vanligt.
              </span>
            </p>
          ) : null}
        </form>
      )}
    </Modal>
  );
}
