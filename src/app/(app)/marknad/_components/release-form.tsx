"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

import { createRelease, updateRelease } from "../actions";
import type { Option } from "../_lib/types";

export interface ReleaseFormValues {
  readonly id?: string;
  readonly name: string;
  readonly series: string;
  readonly releaseDate: string;
  readonly titleId: string;
  readonly supplierId: string;
  readonly scalePercent: string;
  readonly horizonDays: string;
  readonly boxSize: string;
  readonly minOrderQty: string;
  readonly note: string;
  /** Förslaget är fastställt: släppdag, storlek och förpackning är låsta. */
  readonly locked?: boolean;
}

const EMPTY: ReleaseFormValues = {
  name: "",
  series: "",
  releaseDate: "",
  titleId: "",
  supplierId: "",
  scalePercent: "100",
  horizonDays: "28",
  boxSize: "1",
  minOrderQty: "0",
  note: "",
};

/** Knapp och dialog för att lägga in eller ändra ett släpp. */
export function ReleaseFormButton({
  titles,
  suppliers,
  supplierItems,
  initial,
  label,
  variant = "secondary",
}: {
  titles: readonly Option[];
  suppliers: readonly Option[];
  /** "leverantör:titel" → förpackning och minsta beställning, för förifyllning. */
  supplierItems: Readonly<Record<string, { packSize: number; minOrderQty: number }>>;
  initial?: ReleaseFormValues;
  label: string;
  variant?: "primary" | "secondary" | "ghost";
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [values, setValues] = useState<ReleaseFormValues>(initial ?? EMPTY);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const editing = Boolean(initial?.id);
  const locked = Boolean(initial?.locked);

  function set<K extends keyof ReleaseFormValues>(key: K, value: ReleaseFormValues[K]) {
    setValues((v) => {
      const next = { ...v, [key]: value };
      if ((key === "supplierId" || key === "titleId") && next.supplierId && next.titleId) {
        const item = supplierItems[`${next.supplierId}:${next.titleId}`];
        if (item && !locked) {
          return { ...next, boxSize: String(item.packSize), minOrderQty: String(item.minOrderQty) };
        }
      }
      return next;
    });
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const payload = {
        ...(editing ? { id: initial!.id } : {}),
        name: values.name,
        series: values.series,
        releaseDate: values.releaseDate,
        titleId: values.titleId,
        supplierId: values.supplierId,
        scalePercent: values.scalePercent,
        horizonDays: values.horizonDays,
        boxSize: values.boxSize,
        minOrderQty: values.minOrderQty,
        note: values.note,
      };
      const result = editing ? await updateRelease(payload) : await createRelease(payload);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      if (!editing) setValues(EMPTY);
      toast({
        title: editing ? "Släppet sparat" : "Släppet inlagt",
        meta: values.name,
        tone: "ok",
      });
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size="sm"
        iconLeft={editing ? undefined : "plus"}
        onClick={() => {
          setValues(initial ?? EMPTY);
          setError(null);
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        eyebrow={editing ? "Ändra släpp" : "Nytt släpp"}
        title={editing ? values.name || "Släpp" : "Lägg in ett kortsläpp"}
        description={
          locked
            ? "Förslaget är fastställt. Lås upp det för att ändra släppdag, storlek eller förpackning."
            : "Förslaget på inköp och fördelning räknas från tidigare släpp i samma serie."
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <Input
            label="Namn"
            value={values.name}
            onChange={(e) => set("name", e.target.value)}
            required
            maxLength={200}
            autoComplete="off"
          />
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <Input
              label="Släppdag"
              type="date"
              value={values.releaseDate}
              onChange={(e) => set("releaseDate", e.target.value)}
              required
              disabled={locked}
            />
            <Input
              label="Serie"
              value={values.series}
              onChange={(e) => set("series", e.target.value)}
              maxLength={200}
              hint="Släpp i samma serie jämförs först."
            />
          </div>
          <Select
            label="Titel i orderna"
            value={values.titleId}
            onChange={(e) => set("titleId", e.target.value)}
            options={[{ value: "", label: "Ingen titel ännu" }, ...titles]}
            hint="Koppla när titeln finns i orderna, så att utfallet kan mätas."
          />
          <Select
            label="Leverantör"
            value={values.supplierId}
            onChange={(e) => set("supplierId", e.target.value)}
            options={[{ value: "", label: "Ingen vald" }, ...suppliers]}
          />
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Storlek mot vanligt släpp"
              inputMode="decimal"
              suffix="%"
              value={values.scalePercent}
              onChange={(e) => set("scalePercent", e.target.value)}
              disabled={locked}
              hint="100 = som tidigare släpp."
            />
            <Input
              label="Horisont"
              type="number"
              min={7}
              max={91}
              suffix="d"
              value={values.horizonDays}
              onChange={(e) => set("horizonDays", e.target.value)}
              disabled={locked}
            />
            <Input
              label="Pack per låda"
              type="number"
              min={1}
              value={values.boxSize}
              onChange={(e) => set("boxSize", e.target.value)}
              disabled={locked}
            />
            <Input
              label="Minsta beställning"
              type="number"
              min={0}
              suffix="pack"
              value={values.minOrderQty}
              onChange={(e) => set("minOrderQty", e.target.value)}
              disabled={locked}
            />
          </div>
          <Input
            label="Anteckning"
            value={values.note}
            onChange={(e) => set("note", e.target.value)}
            maxLength={2000}
            autoComplete="off"
          />
          {error ? (
            <p role="alert" className="text-sm text-signal-fg">
              {error}
            </p>
          ) : null}
          <div className="flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end">
            <Button type="button" onClick={() => setOpen(false)}>
              Avbryt
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              {editing ? "Spara" : "Lägg in släppet"}
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
