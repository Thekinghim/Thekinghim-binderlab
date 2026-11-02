"use client";

import { useRouter } from "next/navigation";
import { useMemo, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";

import { createPurchaseOrder } from "../actions";
import type { SupplierView } from "../_lib/model";
import { kr, oreToField, parseCount, parseKronor } from "../_lib/units";

export interface OrderDraft {
  readonly supplierId: string;
  /** Föreslaget antal per titel (från inköpsförslaget). */
  readonly quantities: Readonly<Record<string, number>>;
  readonly expectedOn: string | null;
}

interface LineState {
  qty: string;
  price: string;
}

/**
 * Ny inköpsorder: leverantör, antal och pris per artikel, väntad leverans. Förifylld från
 * inköpsförslaget. "Beställ" sparar som beställd i dag, "Spara utkast" som utkast.
 * Monteras när dialogen öppnas, så att fälten alltid börjar från förslaget.
 */
export function CreateOrderDialog({
  open,
  onClose,
  suppliers,
  draft,
  today,
}: {
  open: boolean;
  onClose: () => void;
  suppliers: readonly SupplierView[];
  draft: OrderDraft | null;
  today: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const active = useMemo(() => suppliers.filter((s) => !s.archived), [suppliers]);
  const linesFor = (id: string): Record<string, LineState> => {
    const next: Record<string, LineState> = {};
    for (const it of active.find((x) => x.id === id)?.items ?? []) {
      const q = draft && draft.supplierId === id ? (draft.quantities[it.titleId] ?? 0) : 0;
      next[it.titleId] = { qty: q > 0 ? String(q) : "", price: oreToField(it.unitCostOre) };
    }
    return next;
  };
  const [supplierId, setSupplierId] = useState<string>(draft?.supplierId ?? active[0]?.id ?? "");
  const [expectedOn, setExpectedOn] = useState<string>(draft?.expectedOn ?? "");
  const [lines, setLines] = useState<Record<string, LineState>>(() => linesFor(supplierId));
  const [error, setError] = useState<string | null>(null);
  const supplier = active.find((s) => s.id === supplierId) ?? null;
  const changeSupplier = (id: string) => {
    setSupplierId(id);
    setLines(linesFor(id));
    setError(null);
  };

  const parsed = (supplier?.items ?? []).map((it) => {
    const st = lines[it.titleId] ?? { qty: "", price: oreToField(it.unitCostOre) };
    const qty = st.qty.trim() === "" ? 0 : parseCount(st.qty);
    const price = parseKronor(st.price);
    // Samma regler som servern: minst minsta order och hela boxar.
    const qtyError =
      qty === null
        ? "Hela pack"
        : qty > 0 && qty < it.minOrderQty
          ? `Minst ${it.minOrderQty}`
          : qty > 0 && qty % it.packSize !== 0
            ? `Hela boxar (${it.packSize})`
            : undefined;
    return { item: it, qty, price, st, qtyError };
  });
  const chosen = parsed.filter((p) => p.qty !== null && p.qty > 0);
  const invalid = parsed.some((p) => p.qtyError !== undefined || p.price === null);
  const totalOre = chosen.reduce((s, p) => s + (p.qty ?? 0) * (p.price ?? 0), 0);
  const totalPacks = chosen.reduce((s, p) => s + (p.qty ?? 0), 0);

  const submit = (status: "draft" | "ordered") => {
    if (!supplier) return setError("Välj en leverantör.");
    if (invalid) {
      return setError(
        "Rätta raderna: antal i hela boxar och minst minsta order, pris i kronor (t.ex. 45,50).",
      );
    }
    if (chosen.length === 0) return setError("Ange antal på minst en rad.");
    setError(null);
    start(async () => {
      const res = await createPurchaseOrder({
        supplierId: supplier.id,
        status,
        expectedOn: expectedOn || null,
        lines: chosen.map((p) => ({
          titleId: p.item.titleId,
          quantity: p.qty,
          unitCostOre: p.price,
        })),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      toast({
        title: status === "ordered" ? "Inköpsorder beställd" : "Utkast sparat",
        description: `${supplier.name}: ${totalPacks} pack för ${kr(totalOre)}.`,
      });
      onClose();
      router.refresh();
    });
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Ny inköpsorder"
      eyebrow="Inköp"
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={pending}>
            Avbryt
          </Button>
          <Button variant="secondary" onClick={() => submit("draft")} loading={pending}>
            Spara utkast
          </Button>
          <Button variant="primary" onClick={() => submit("ordered")} loading={pending}>
            Beställ
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Select
            label="Leverantör"
            value={supplierId}
            onChange={(e) => changeSupplier(e.target.value)}
            options={active.map((s) => ({ value: s.id, label: s.name }))}
          />
          <Input
            label="Väntad leverans"
            type="date"
            min={today}
            value={expectedOn}
            onChange={(e) => setExpectedOn(e.target.value)}
            hint={
              supplier?.defaultLeadTimeDays != null
                ? `Standard ${supplier.defaultLeadTimeDays} dagars ledtid.`
                : undefined
            }
          />
        </div>

        {supplier && supplier.items.length === 0 ? (
          <p className="text-sm text-muted">
            {supplier.name} har inga artiklar. Lägg till vilka titlar leverantören säljer under
            Leverantörer.
          </p>
        ) : (
          <table className="w-full text-sm">
            <caption className="sr-only">Rader i inköpsordern</caption>
            <thead>
              <tr className="border-b border-line-strong">
                <th scope="col" className="label py-2 text-left font-normal text-subtle">
                  Titel
                </th>
                <th scope="col" className="label w-24 py-2 text-right font-normal text-subtle">
                  Antal
                </th>
                <th scope="col" className="label w-28 py-2 pl-2 text-right font-normal text-subtle">
                  Pris/pack
                </th>
              </tr>
            </thead>
            <tbody>
              {parsed.map((p) => (
                <tr key={p.item.titleId} className="border-b border-line">
                  <th scope="row" className="py-2 pr-2 text-left font-normal">
                    <span className="flex flex-col">
                      <span className="text-fg">{p.item.title}</span>
                      <span className="text-xs text-subtle">
                        Box {p.item.packSize} · minst {p.item.minOrderQty}
                      </span>
                    </span>
                  </th>
                  <td className="py-2">
                    <Input
                      label={`Antal ${p.item.title}`}
                      wrapperClassName="[&>label]:sr-only"
                      inputMode="numeric"
                      value={p.st.qty}
                      placeholder="0"
                      error={p.qtyError}
                      onChange={(e) =>
                        setLines((cur) => ({
                          ...cur,
                          [p.item.titleId]: { ...p.st, qty: e.target.value },
                        }))
                      }
                      className="text-right"
                    />
                  </td>
                  <td className="py-2 pl-2">
                    <Input
                      label={`Pris per pack ${p.item.title}`}
                      wrapperClassName="[&>label]:sr-only"
                      inputMode="decimal"
                      value={p.st.price}
                      suffix="kr"
                      error={p.price === null ? "Ogiltigt" : undefined}
                      onChange={(e) =>
                        setLines((cur) => ({
                          ...cur,
                          [p.item.titleId]: { ...p.st, price: e.target.value },
                        }))
                      }
                      className="text-right"
                    />
                  </td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr>
                <th scope="row" className="label pt-3 text-left font-normal text-subtle">
                  Summa
                </th>
                <td className="tnum pt-3 text-right text-fg">{totalPacks} pack</td>
                <td className="tnum pt-3 pl-2 text-right text-fg">{kr(totalOre)}</td>
              </tr>
            </tfoot>
          </table>
        )}
        {error ? (
          <p role="alert" className="text-sm text-signal-fg">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
