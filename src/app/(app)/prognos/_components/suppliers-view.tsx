"use client";

import { useRouter } from "next/navigation";
import { useCallback, useMemo, useRef, useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { DataTable, type Column } from "@/components/ui/data-table";
import { Input, Select } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { StateMessage } from "@/components/ui/state-message";
import { StatusTag } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";
import { formatInt, MISSING } from "@/lib/format";

import {
  archiveSupplier,
  createSupplier,
  deleteSupplierItem,
  saveSupplierItem,
  updateSupplier,
} from "../actions";
import type { SupplierView, SuppliersModel } from "../_lib/model";
import { krExact, oreToField, parseCount, parseKronor } from "../_lib/units";

/** Leverantörens läge: aktiv eller arkiverad. */
function SupplierStatus({ archived }: { archived: boolean }) {
  return archived ? (
    <StatusTag status="offline">Arkiverad</StatusTag>
  ) : (
    <StatusTag status="ok">Aktiv</StatusTag>
  );
}

/** Felet för ett ogiltigt ledtidsfält: negativt eller inte hela dagar. */
function leadError(raw: string): string {
  return /^\s*[-−]/.test(raw)
    ? "Ledtiden kan inte vara negativ."
    : "Ledtiden anges i hela dagar, t.ex. 7.";
}

type Item = SupplierView["items"][number];
type ItemRow = Item & { supplierName: string; archived: boolean };

type Dialog =
  | { kind: "supplier"; supplier: SupplierView | null }
  | { kind: "item"; item: Item | null; supplierId: string | null }
  | { kind: "delete-item"; item: ItemRow }
  | null;

/** Leverantörer och deras artiklar (vilka titlar, boxstorlek, minsta order, ledtid, pris). */
export function SuppliersView({
  model,
  titles,
  canEdit,
}: {
  model: SuppliersModel;
  titles: readonly { id: string; name: string }[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [dialog, setDialog] = useState<Dialog>(null);
  // Dialogerna monteras bara när de är öppna: fokus lämnas tillbaka till knappen som
  // öppnade dialogen när den stängs (annars hamnar fokus på body).
  const returnTo = useRef<HTMLElement | null>(null);
  const openDialog = useCallback((d: Dialog) => {
    returnTo.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDialog(d);
  }, []);
  const closeDialog = useCallback(() => {
    setDialog(null);
    const el = returnTo.current;
    window.requestAnimationFrame(() => {
      if (el?.isConnected) el.focus();
    });
  }, []);
  const [pending, start] = useTransition();

  const items: ItemRow[] = useMemo(
    () =>
      model.suppliers.flatMap((s) =>
        s.items.map((i) => ({ ...i, supplierName: s.name, archived: s.archived })),
      ),
    [model.suppliers],
  );

  const toggleArchive = (s: SupplierView) =>
    start(async () => {
      const res = await archiveSupplier({ id: s.id, archived: !s.archived });
      if (!res.ok) {
        toast({ title: "Kunde inte spara", description: res.error, tone: "critical" });
        return;
      }
      toast({
        title: s.archived ? "Leverantören är aktiv igen" : "Leverantören är arkiverad",
        meta: s.name,
      });
      router.refresh();
    });

  const supplierColumns = useMemo<Column<SupplierView>[]>(
    () => [
      {
        key: "name",
        header: "Leverantör",
        sortValue: (r) => r.name,
        render: (r) => (
          <span className="flex min-w-0 flex-col">
            <span className="text-fg">{r.name}</span>
            <span className="text-xs text-subtle">
              {[r.contactName, r.email, r.phone].filter(Boolean).join(" · ") || "Ingen kontakt"}
            </span>
            {/* Under md står läget här; kolumnen Läge är dold (design.md §5.1). */}
            <span className="mt-1 md:hidden">
              <SupplierStatus archived={r.archived} />
            </span>
          </span>
        ),
        csv: (r) => r.name,
      },
      {
        key: "status",
        header: "Läge",
        hideable: false,
        hideOnMobile: true,
        render: (r) => <SupplierStatus archived={r.archived} />,
        csv: (r) => (r.archived ? "Arkiverad" : "Aktiv"),
      },
      {
        key: "lead",
        header: "Ledtid",
        numeric: true,
        sortValue: (r) => r.defaultLeadTimeDays ?? -1,
        render: (r) => (r.defaultLeadTimeDays === null ? MISSING : `${r.defaultLeadTimeDays} d`),
        csv: (r) => r.defaultLeadTimeDays,
      },
      {
        key: "items",
        header: "Artiklar",
        numeric: true,
        hideOnMobile: true,
        sortValue: (r) => r.items.length,
        render: (r) => formatInt(r.items.length),
      },
      {
        key: "open",
        header: "Öppna order",
        numeric: true,
        hideOnMobile: true,
        sortValue: (r) => r.openOrders,
        render: (r) => formatInt(r.openOrders),
      },
      ...(canEdit
        ? [
            {
              key: "actions",
              header: "Åtgärd",
              hideable: false,
              render: (r: SupplierView) => (
                <span className="flex flex-wrap justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openDialog({ kind: "supplier", supplier: r })}
                    aria-label={`Ändra ${r.name}`}
                  >
                    Ändra
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    disabled={pending}
                    onClick={() => toggleArchive(r)}
                    aria-label={`${r.archived ? "Återställ" : "Arkivera"} ${r.name}`}
                  >
                    {r.archived ? "Återställ" : "Arkivera"}
                  </Button>
                </span>
              ),
            } satisfies Column<SupplierView>,
          ]
        : []),
    ],
    // toggleArchive är stabil nog: den läser bara rad och start.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canEdit, pending, openDialog],
  );

  const itemColumns = useMemo<Column<ItemRow>[]>(
    () => [
      {
        key: "title",
        header: "Titel",
        sortValue: (r) => r.title,
        render: (r) => (
          <span className="flex min-w-0 flex-col">
            <span className="text-fg">{r.title}</span>
            <span className="text-xs text-subtle">
              {r.supplierName}
              {r.archived ? " (arkiverad)" : ""}
            </span>
          </span>
        ),
        csv: (r) => `${r.title} – ${r.supplierName}`,
      },
      {
        key: "price",
        header: "Pris/pack",
        numeric: true,
        sortValue: (r) => r.unitCostOre,
        render: (r) => krExact(r.unitCostOre),
        csv: (r) => r.unitCostOre / 100,
      },
      {
        key: "box",
        header: "Box",
        numeric: true,
        sortValue: (r) => r.packSize,
        render: (r) => formatInt(r.packSize),
      },
      {
        key: "min",
        header: "Minsta order",
        numeric: true,
        hideOnMobile: true,
        sortValue: (r) => r.minOrderQty,
        render: (r) => formatInt(r.minOrderQty),
      },
      {
        key: "lead",
        header: "Ledtid",
        numeric: true,
        hideOnMobile: true,
        sortValue: (r) => r.leadTimeDays ?? -1,
        render: (r) =>
          r.leadTimeDays === null ? (
            <span className="text-subtle">Leverantörens</span>
          ) : (
            `${r.leadTimeDays} d`
          ),
        csv: (r) => r.leadTimeDays,
      },
      ...(canEdit
        ? [
            {
              key: "actions",
              header: "Åtgärd",
              hideable: false,
              render: (r: ItemRow) => (
                <span className="flex flex-wrap justify-end gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openDialog({ kind: "item", item: r, supplierId: r.supplierId })}
                    aria-label={`Ändra ${r.title} hos ${r.supplierName}`}
                  >
                    Ändra
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => openDialog({ kind: "delete-item", item: r })}
                    aria-label={`Ta bort ${r.title} hos ${r.supplierName}`}
                  >
                    Ta bort
                  </Button>
                </span>
              ),
            } satisfies Column<ItemRow>,
          ]
        : []),
    ],
    [canEdit, openDialog],
  );

  const active = model.suppliers.filter((s) => !s.archived);

  return (
    <div className="flex flex-col gap-12">
      <section aria-label="Leverantörer" className="flex flex-col gap-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <p className="label text-subtle">Leverantörer · {model.suppliers.length}</p>
          {canEdit ? (
            <Button
              variant="secondary"
              size="sm"
              iconLeft="plus"
              onClick={() => openDialog({ kind: "supplier", supplier: null })}
            >
              Ny leverantör
            </Button>
          ) : null}
        </div>
        {model.suppliers.length === 0 ? (
          <StateMessage
            kind="empty"
            message="Ingen leverantör är upplagd."
            detail="Med leverantör, ledtid, boxstorlek och pris kan inköpen föreslås ur prognosen."
            action={
              canEdit
                ? {
                    label: "Lägg till leverantör",
                    onClick: () => openDialog({ kind: "supplier", supplier: null }),
                  }
                : undefined
            }
          />
        ) : (
          <DataTable
            surface="bg"
            columns={supplierColumns}
            rows={model.suppliers}
            rowKey={(r) => r.id}
            caption="Leverantörer"
            defaultSort={{ key: "name", dir: "asc" }}
            dense
          />
        )}
      </section>

      {model.suppliers.length > 0 ? (
        <section aria-label="Artiklar" className="flex flex-col gap-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="label text-subtle">Artiklar · {items.length}</p>
            {canEdit && active.length > 0 ? (
              <Button
                variant="secondary"
                size="sm"
                iconLeft="plus"
                onClick={() =>
                  openDialog({ kind: "item", item: null, supplierId: active[0]?.id ?? null })
                }
              >
                Ny artikel
              </Button>
            ) : null}
          </div>
          {items.length === 0 ? (
            <StateMessage
              kind="empty"
              message="Ingen leverantör har artiklar ännu, så inget kan föreslås."
              compact
            />
          ) : (
            <DataTable
              surface="bg"
              columns={itemColumns}
              rows={items}
              rowKey={(r) => r.id}
              caption="Artiklar per leverantör"
              defaultSort={{ key: "title", dir: "asc" }}
              dense
            />
          )}
        </section>
      ) : null}

      {dialog?.kind === "supplier" ? (
        <SupplierDialog supplier={dialog.supplier} onClose={closeDialog} />
      ) : null}
      {dialog?.kind === "item" ? (
        <ItemDialog
          item={dialog.item}
          supplierId={dialog.supplierId}
          suppliers={active.length > 0 ? active : model.suppliers}
          titles={titles}
          onClose={closeDialog}
        />
      ) : null}
      {dialog?.kind === "delete-item" ? (
        <DeleteItemDialog item={dialog.item} onClose={closeDialog} />
      ) : null}
    </div>
  );
}

function FormError({ message }: { message: string | null }) {
  return message ? (
    <p role="alert" className="text-sm text-signal-fg">
      {message}
    </p>
  ) : null;
}

function FormButtons({
  onClose,
  pending,
  label,
}: {
  onClose: () => void;
  pending: boolean;
  label: string;
}) {
  return (
    <div className="flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end">
      <Button type="button" onClick={onClose} disabled={pending}>
        Avbryt
      </Button>
      <Button type="submit" variant="primary" loading={pending}>
        {label}
      </Button>
    </div>
  );
}

function SupplierDialog({
  supplier,
  onClose,
}: {
  supplier: SupplierView | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [name, setName] = useState(supplier?.name ?? "");
  const [contactName, setContactName] = useState(supplier?.contactName ?? "");
  const [email, setEmail] = useState(supplier?.email ?? "");
  const [phone, setPhone] = useState(supplier?.phone ?? "");
  const [lead, setLead] = useState(
    supplier?.defaultLeadTimeDays != null ? String(supplier.defaultLeadTimeDays) : "",
  );
  const leadValue = lead.trim() === "" ? null : parseCount(lead);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return setError("Ange leverantörens namn.");
    if (lead.trim() !== "" && leadValue === null) return setError(leadError(lead));
    setError(null);
    start(async () => {
      const input = {
        name,
        contactName: contactName || null,
        email: email || null,
        phone: phone || null,
        defaultLeadTimeDays: leadValue,
      };
      const res = supplier
        ? await updateSupplier({ id: supplier.id, ...input })
        : await createSupplier(input);
      if (!res.ok) return setError(res.error);
      toast({
        title: supplier ? "Leverantören är sparad" : "Leverantören är tillagd",
        meta: name.trim(),
      });
      onClose();
      router.refresh();
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Leverantör"
      title={supplier ? `Ändra ${supplier.name}` : "Ny leverantör"}
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        <Input
          label="Namn"
          value={name}
          onChange={(e) => setName(e.target.value)}
          required
          autoFocus
        />
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Input
            label="Kontaktperson"
            value={contactName}
            onChange={(e) => setContactName(e.target.value)}
          />
          <Input
            label="Ledtid"
            inputMode="numeric"
            suffix="dagar"
            value={lead}
            onChange={(e) => setLead(e.target.value)}
            error={lead.trim() !== "" && leadValue === null ? "Hela dagar" : undefined}
            hint="Från beställning till leverans."
          />
          <Input
            label="E-post"
            type="email"
            inputMode="email"
            spellCheck={false}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
          />
          <Input
            label="Telefon"
            type="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
        </div>
        <FormError message={error} />
        <FormButtons onClose={onClose} pending={pending} label={supplier ? "Spara" : "Lägg till"} />
      </form>
    </Modal>
  );
}

function ItemDialog({
  item,
  supplierId,
  suppliers,
  titles,
  onClose,
}: {
  item: Item | null;
  supplierId: string | null;
  suppliers: readonly SupplierView[];
  titles: readonly { id: string; name: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [supplier, setSupplier] = useState(
    item?.supplierId ?? supplierId ?? suppliers[0]?.id ?? "",
  );
  const taken = new Set(
    suppliers
      .find((s) => s.id === supplier)
      ?.items.filter((i) => i.id !== item?.id)
      .map((i) => i.titleId) ?? [],
  );
  const titleOptions = titles.filter((t) => !taken.has(t.id) || t.id === item?.titleId);
  const [titleId, setTitleId] = useState(item?.titleId ?? titleOptions[0]?.id ?? "");
  const [price, setPrice] = useState(item ? oreToField(item.unitCostOre) : "");
  const [packSize, setPackSize] = useState(String(item?.packSize ?? 1));
  const [minQty, setMinQty] = useState(String(item?.minOrderQty ?? 1));
  const [lead, setLead] = useState(item?.leadTimeDays != null ? String(item.leadTimeDays) : "");

  const priceOre = parseKronor(price);
  const pack = parseCount(packSize);
  const min = parseCount(minQty);
  const leadValue = lead.trim() === "" ? null : parseCount(lead);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!supplier || !titleId) return setError("Välj leverantör och titel.");
    if (priceOre === null) return setError("Ange priset i kronor, t.ex. 45,50.");
    if (!pack || pack < 1 || !min || min < 1)
      return setError("Box och minsta order är minst 1 pack.");
    if (lead.trim() !== "" && leadValue === null) return setError(leadError(lead));
    setError(null);
    start(async () => {
      const res = await saveSupplierItem({
        id: item?.id,
        supplierId: supplier,
        titleId,
        packSize: pack,
        minOrderQty: min,
        leadTimeDays: leadValue,
        unitCostOre: priceOre,
      });
      if (!res.ok) return setError(res.error);
      toast({ title: item ? "Artikeln är sparad" : "Artikeln är tillagd" });
      onClose();
      router.refresh();
    });
  };

  return (
    <Modal
      open
      onClose={onClose}
      eyebrow="Artikel"
      title={item ? `Ändra ${item.title}` : "Ny artikel"}
    >
      <form onSubmit={submit} noValidate className="flex flex-col gap-5">
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <Select
            label="Leverantör"
            value={supplier}
            onChange={(e) => setSupplier(e.target.value)}
            options={suppliers.map((s) => ({ value: s.id, label: s.name }))}
          />
          <Select
            label="Titel"
            value={titleId}
            onChange={(e) => setTitleId(e.target.value)}
            options={titleOptions.map((t) => ({ value: t.id, label: t.name }))}
          />
          <Input
            label="Pris per pack"
            inputMode="decimal"
            suffix="kr"
            value={price}
            onChange={(e) => setPrice(e.target.value)}
            error={price !== "" && priceOre === null ? "T.ex. 45,50" : undefined}
          />
          <Input
            label="Ledtid"
            inputMode="numeric"
            suffix="dagar"
            value={lead}
            onChange={(e) => setLead(e.target.value)}
            hint="Tomt = leverantörens."
          />
          <Input
            label="Pack per box"
            inputMode="numeric"
            value={packSize}
            onChange={(e) => setPackSize(e.target.value)}
          />
          <Input
            label="Minsta order"
            inputMode="numeric"
            suffix="pack"
            value={minQty}
            onChange={(e) => setMinQty(e.target.value)}
          />
        </div>
        <FormError message={error} />
        <FormButtons onClose={onClose} pending={pending} label={item ? "Spara" : "Lägg till"} />
      </form>
    </Modal>
  );
}

function DeleteItemDialog({ item, onClose }: { item: ItemRow; onClose: () => void }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const submit = () =>
    start(async () => {
      const res = await deleteSupplierItem({ id: item.id });
      if (!res.ok) return setError(res.error);
      toast({ title: "Artikeln är borttagen", meta: item.title });
      onClose();
      router.refresh();
    });
  return (
    <Modal
      open
      onClose={onClose}
      size="sm"
      eyebrow={item.supplierName}
      title={`Ta bort ${item.title}?`}
      description="Gamla inköpsorder påverkas inte. Titeln föreslås inte längre från leverantören."
      footer={
        <>
          <Button onClick={onClose} disabled={pending}>
            Behåll
          </Button>
          <Button variant="danger-confirm" onClick={submit} loading={pending}>
            Ta bort
          </Button>
        </>
      }
    >
      <FormError message={error} />
    </Modal>
  );
}
