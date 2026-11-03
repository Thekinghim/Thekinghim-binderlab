"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select, formError } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

import { createQuote } from "../actions";
import type { Option } from "../_lib/types";

const NEW_SUPPLIER = "__ny__";

/** Knapp och dialog för att registrera ett inköpspris från en leverantör. */
export function QuoteFormButton({
  titles,
  suppliers,
  today,
  defaultTitleId,
}: {
  titles: readonly Option[];
  suppliers: readonly Option[];
  today: string;
  defaultTitleId?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const initial = {
    supplierId: suppliers[0]?.value ?? NEW_SUPPLIER,
    newSupplierName: "",
    titleId: defaultTitleId ?? titles[0]?.value ?? "",
    quotedOn: today,
    validUntil: "",
    unitCost: "",
    quantity: "1",
    kind: "quote",
    note: "",
  };
  const [v, setV] = useState(initial);
  const set = (key: keyof typeof initial, value: string) => setV((s) => ({ ...s, [key]: value }));

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await createQuote({
        ...v,
        supplierId: v.supplierId === NEW_SUPPLIER ? "" : v.supplierId,
        newSupplierName: v.supplierId === NEW_SUPPLIER ? v.newSupplierName : "",
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      toast({ title: "Inköpspriset registrerat", meta: `${v.unitCost} kr`, tone: "ok" });
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        iconLeft="plus"
        onClick={() => {
          setV(initial);
          setError(null);
          setOpen(true);
        }}
        disabled={titles.length === 0}
      >
        Registrera pris
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        eyebrow="Leverantörspris"
        title="Registrera inköpspris"
        description="Offert, prislista eller inköp."
      >
        <form
          className="flex flex-col gap-4"
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            const invalid = formError(e.currentTarget);
            if (invalid) return setError(invalid);
            submit();
          }}
        >
          <Select
            label="Titel"
            value={v.titleId}
            onChange={(e) => set("titleId", e.target.value)}
            options={[...titles]}
          />
          <Select
            label="Leverantör"
            value={v.supplierId}
            onChange={(e) => set("supplierId", e.target.value)}
            options={[...suppliers, { value: NEW_SUPPLIER, label: "Ny leverantör …" }]}
          />
          {v.supplierId === NEW_SUPPLIER ? (
            <Input
              label="Leverantörens namn"
              value={v.newSupplierName}
              onChange={(e) => set("newSupplierName", e.target.value)}
              required
              maxLength={200}
              autoComplete="off"
            />
          ) : null}
          <div className="grid grid-cols-2 gap-4">
            <Input
              label="Pris per pack"
              inputMode="decimal"
              suffix="kr"
              value={v.unitCost}
              onChange={(e) => set("unitCost", e.target.value)}
              required
              placeholder="0,00"
            />
            <Input
              label="Antal pack"
              type="number"
              min={1}
              value={v.quantity}
              onChange={(e) => set("quantity", e.target.value)}
            />
            <Input
              label="Datum"
              type="date"
              value={v.quotedOn}
              onChange={(e) => set("quotedOn", e.target.value)}
              required
            />
            <Input
              label="Giltig till"
              type="date"
              value={v.validUntil}
              onChange={(e) => set("validUntil", e.target.value)}
            />
          </div>
          <Select
            label="Typ"
            value={v.kind}
            onChange={(e) => set("kind", e.target.value)}
            options={[
              { value: "quote", label: "Offert eller prislista" },
              { value: "purchase", label: "Inköp" },
            ]}
          />
          <Input
            label="Anteckning"
            value={v.note}
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
              Registrera
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
