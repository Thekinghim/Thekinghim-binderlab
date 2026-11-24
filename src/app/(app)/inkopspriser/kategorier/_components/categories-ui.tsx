"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Modal } from "@/components/ui/modal";
import { Field, Input, Select } from "@/components/v2/field";

import {
  PreviewDialog,
  usePreviewFlow,
} from "../../../installningar/awish/_components/preview-dialog";
import {
  applyBatchCategory,
  applyCategory,
  categorySlots,
  previewBatchCategory,
  previewCategory,
} from "../actions";

function useCategoryFlow(onDone?: () => void) {
  return usePreviewFlow<Record<string, unknown>>({
    preview: (p) => previewCategory(p),
    apply: (p) => applyCategory(p),
    onDone,
  });
}

function CategoryFields({
  title,
  setTitle,
  priority,
  setPriority,
  visible,
  setVisible,
  allowUnchanged,
}: {
  title: string;
  setTitle: (v: string) => void;
  priority: string;
  setPriority: (v: string) => void;
  visible: string;
  setVisible: (v: string) => void;
  allowUnchanged: boolean;
}) {
  return (
    <div className="flex flex-col gap-3">
      <Field label="Namn">
        {(p) => (
          <Input {...p} value={title} maxLength={40} onChange={(e) => setTitle(e.target.value)} />
        )}
      </Field>
      <Field label="Ordning" hint="Lägre tal först. Frivilligt.">
        {(p) => (
          <Input
            {...p}
            type="number"
            inputMode="numeric"
            min={0}
            max={9999}
            value={priority}
            onChange={(e) => setPriority(e.target.value)}
          />
        )}
      </Field>
      <Field label="Visa på skärmen">
        {(p) => (
          <Select {...p} value={visible} onChange={(e) => setVisible(e.target.value)}>
            {allowUnchanged ? <option value="">Som nu</option> : null}
            <option value="ja">Ja</option>
            <option value="nej">Nej</option>
          </Select>
        )}
      </Field>
    </div>
  );
}

/** "Ny kategori". */
export function NewCategory() {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [priority, setPriority] = useState("");
  const [visible, setVisible] = useState("ja");
  const flow = useCategoryFlow(() => {
    setOpen(false);
    setTitle("");
    setPriority("");
  });
  return (
    <>
      <Button variant="primary" size="sm" iconLeft="plus" onClick={() => setOpen(true)}>
        Ny kategori
      </Button>
      <Modal
        open={open && !flow.preview}
        onClose={() => setOpen(false)}
        size="sm"
        title="Ny kategori"
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Avbryt
            </Button>
            <Button
              variant="primary"
              loading={flow.pending}
              disabled={title.trim() === ""}
              onClick={() => flow.open({ action: "create", title, priority, isVisible: visible })}
            >
              Förhandsgranska
            </Button>
          </>
        }
      >
        <CategoryFields
          title={title}
          setTitle={setTitle}
          priority={priority}
          setPriority={setPriority}
          visible={visible}
          setVisible={setVisible}
          allowUnchanged={false}
        />
      </Modal>
      <PreviewDialog flow={flow} title="Skapa kategorin i Awish?" confirmLabel="Skapa" />
    </>
  );
}

/** "Ändra" och "Ta bort" på en kategori. */
export function CategoryActions({ id, title: current }: { id: string; title: string }) {
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState(current);
  const [priority, setPriority] = useState("");
  const [visible, setVisible] = useState("");
  const edit = useCategoryFlow(() => setOpen(false));
  const remove = useCategoryFlow();
  return (
    <div className="flex flex-wrap justify-end gap-2">
      <Button
        variant="secondary"
        size="sm"
        onClick={() => {
          setTitle(current);
          setPriority("");
          setVisible("");
          setOpen(true);
        }}
      >
        Ändra
      </Button>
      <Button
        variant="danger"
        size="sm"
        loading={remove.pending && !remove.preview}
        onClick={() => remove.open({ action: "delete", id })}
      >
        Ta bort
      </Button>
      <Modal
        open={open && !edit.preview}
        onClose={() => setOpen(false)}
        size="sm"
        title={`Ändra ${current}`}
        footer={
          <>
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Avbryt
            </Button>
            <Button
              variant="primary"
              loading={edit.pending}
              onClick={() =>
                edit.open({
                  action: "update",
                  id,
                  title: title.trim() === current ? "" : title,
                  priority,
                  isVisible: visible,
                })
              }
            >
              Förhandsgranska
            </Button>
          </>
        }
      >
        <CategoryFields
          title={title}
          setTitle={setTitle}
          priority={priority}
          setPriority={setPriority}
          visible={visible}
          setVisible={setVisible}
          allowUnchanged
        />
      </Modal>
      <PreviewDialog flow={edit} title="Spara i Awish?" confirmLabel="Spara" />
      <PreviewDialog flow={remove} title="Ta bort kategorin?" confirmLabel="Ta bort" danger />
    </div>
  );
}

/** "Kategori per fack": automat → fack → kategori (BatchUpdateProducts). */
export function SlotCategory({
  machines,
  categories,
}: {
  machines: { id: string; label: string }[];
  categories: { id: string; title: string }[];
}) {
  const [machineId, setMachineId] = useState("");
  const [slots, setSlots] = useState<{ id: string; label: string }[] | null>(null);
  const [picked, setPicked] = useState<string[]>([]);
  const [categoryId, setCategoryId] = useState(categories[0]?.id ?? "");
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const flow = usePreviewFlow<Record<string, unknown>>({
    preview: (p) => previewBatchCategory(p),
    apply: (p) => applyBatchCategory(p),
    onDone: () => setPicked([]),
  });

  const pickMachine = (id: string) => {
    setMachineId(id);
    setSlots(null);
    setPicked([]);
    setError(null);
    if (!id) return;
    startLoading(async () => {
      const r = await categorySlots(id).catch(() => ({
        ok: false as const,
        error: "Ingen kontakt med servern. Försök igen.",
      }));
      if (r.ok) setSlots(r.data);
      else setError(r.error);
    });
  };

  const toggle = (id: string) =>
    setPicked((old) => (old.includes(id) ? old.filter((x) => x !== id) : [...old, id]));

  if (machines.length === 0) {
    return <p className="st-p">Ingen automat är kopplad till Awish.</p>;
  }
  if (categories.length === 0) {
    return <p className="st-p">Skapa en kategori först.</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <Field label="Automat">
        {(p) => (
          <Select {...p} value={machineId} onChange={(e) => pickMachine(e.target.value)}>
            <option value="">Välj automat</option>
            {machines.map((m) => (
              <option key={m.id} value={m.id}>
                {m.label}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {loading ? <p className="st-p">Läser facken…</p> : null}
      {error ? (
        <p className="text-v2-sm text-v2-crit-text" role="alert">
          {error}
        </p>
      ) : null}
      {slots ? (
        <fieldset className="flex flex-col gap-1">
          <legend className="mb-1 text-v2-sm font-[550]">Fack</legend>
          {slots.length === 0 ? <p className="st-p">Inga fack.</p> : null}
          {slots.map((s) => (
            <label key={s.id} className="flex min-h-9 items-center gap-2 text-v2-md">
              <input
                type="checkbox"
                checked={picked.includes(s.id)}
                onChange={() => toggle(s.id)}
              />
              <span className="min-w-0 break-words">{s.label}</span>
            </label>
          ))}
        </fieldset>
      ) : null}
      {slots && slots.length > 0 ? (
        <>
          <Field label="Kategori">
            {(p) => (
              <Select {...p} value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
                {categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <div>
            <Button
              variant="primary"
              disabled={picked.length === 0 || !categoryId}
              loading={flow.pending && !flow.preview}
              onClick={() => flow.open({ machineId, productIds: picked, categoryId })}
            >
              Förhandsgranska
            </Button>
          </div>
        </>
      ) : null}
      <PreviewDialog flow={flow} title="Byt kategori i facken?" confirmLabel="Skicka till Awish" />
    </div>
  );
}
