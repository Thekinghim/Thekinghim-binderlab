"use client";

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Panel } from "@/components/ui/frame";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";

import {
  applySlotChange,
  createNewProduct,
  loadSlotChoices,
  previewNewProduct,
  previewSlotChange,
} from "../actions";

type Machine = { id: string; code: string | null; name: string };
type Slot = {
  id: number;
  channelName: string | null;
  goodId: number | null;
  goodName: string | null;
  status: boolean;
  currentInventory: number;
  capacity: number | null;
};
type Good = { id: number; name: string; priceOre: number | null };
type Preview = {
  lines: string[];
  warnings: string[];
  blocking: string | null;
  fingerprint: string;
  /** Ny produkt: allt finns redan. Fack: inget ändras. */
  idle: boolean;
  /** Fack: fråga som måste bekräftas. */
  confirm: string | null;
};

/** Största bild som skickas oförändrad; större bilder krymps i webbläsaren först. */
const SHRINK_OVER = 1.5 * 1024 * 1024;
const MAX_IMAGE = 4 * 1024 * 1024;

function kr(ore: number | null): string {
  if (ore === null) return "inget pris";
  const whole = Math.trunc(ore / 100).toLocaleString("sv-SE");
  const rest = ore % 100;
  return rest === 0 ? `${whole} kr` : `${whole},${String(rest).padStart(2, "0")} kr`;
}

/** Krymper en stor bild till högst 1600 px (jpg) så att uppladdningen går fort i mobilen. */
async function shrinkImage(file: File): Promise<File> {
  if (file.size <= SHRINK_OVER || typeof createImageBitmap !== "function") return file;
  try {
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext("2d")?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, "image/jpeg", 0.85),
    );
    if (!blob) return file;
    return new File([blob], file.name.replace(/\.\w+$/, "") + ".jpg", { type: "image/jpeg" });
  } catch {
    return file;
  }
}

function PreviewBox({ preview, children }: { preview: Preview; children?: React.ReactNode }) {
  return (
    <div role="status" className="flex flex-col gap-3 rounded-md border border-line-strong p-4">
      <p className="label text-subtle">Det här händer</p>
      <ul className="flex flex-col gap-1 text-sm text-fg">
        {preview.lines.map((l, i) => (
          <li key={i}>{l}</li>
        ))}
      </ul>
      {preview.warnings.length > 0 ? (
        <ul className="flex flex-col gap-1 text-sm text-muted">
          {preview.warnings.map((w, i) => (
            <li key={i}>Obs! {w}</li>
          ))}
        </ul>
      ) : null}
      {preview.blocking ? <p className="text-sm text-signal-fg">{preview.blocking}</p> : null}
      {children}
    </div>
  );
}

function OwnProductSwitch({ on, onChange }: { on: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="flex items-center justify-between gap-4 rounded-md border border-line-strong px-4 py-3">
      <span className="flex flex-col">
        <span className="text-base text-fg">Egen produkt</span>
        <span className="meta text-subtle">{on ? "Vi packar den själva" : "Köps in"}</span>
      </span>
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label="Egen produkt"
        onClick={() => onChange(!on)}
        className={cn(
          "relative inline-flex h-8 w-14 shrink-0 items-center rounded-full border transition-colors duration-fast ease-instrument",
          on ? "border-up bg-up" : "border-line-control bg-raised",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "inline-block size-6 rounded-full bg-fg transition-transform duration-fast ease-instrument",
            on ? "translate-x-7 bg-bg" : "translate-x-1",
          )}
        />
      </button>
    </div>
  );
}

function NewProductForm({
  onCreated,
}: {
  onCreated: (good: { id: number; name: string }) => void;
}) {
  const toast = useToast();
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<"preview" | "send" | null>(null);
  const [name, setName] = useState("");
  const [salePrice, setSalePrice] = useState("");
  const [purchasePrice, setPurchasePrice] = useState("");
  const [ownProduct, setOwnProduct] = useState(false);
  const [image, setImage] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<Preview | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  // Varje ändring gör förhandsvisningen ogiltig: den ska visa exakt det som skickas.
  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPreview(null);
      setError(null);
    };

  const form = (fingerprint?: string) => {
    const fd = new FormData();
    fd.set("input", JSON.stringify({ name, salePrice, purchasePrice, ownProduct }));
    if (image) fd.set("image", image);
    if (fingerprint) fd.set("fingerprint", fingerprint);
    return fd;
  };

  const run = (kind: "preview" | "send", fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    start(async () => {
      try {
        await fn();
      } finally {
        setBusy(null);
      }
    });
  };

  const doPreview = () =>
    run("preview", async () => {
      const r = await previewNewProduct(form());
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setPreview({
        lines: r.data.lines,
        warnings: r.data.warnings,
        blocking: r.data.blocking,
        fingerprint: r.data.fingerprint,
        idle: r.data.nothingToDo,
        confirm: null,
      });
    });

  const send = () =>
    run("send", async () => {
      if (!preview) return;
      const r = await createNewProduct(form(preview.fingerprint));
      if (!r.ok) {
        setError(r.error);
        setPreview(null);
        return;
      }
      toast({ title: r.data.message, tone: "ok" });
      onCreated({ id: r.data.goodId, name: name.trim().replace(/\s+/g, " ") });
      setPreview(null);
      setName("");
      setSalePrice("");
      setPurchasePrice("");
      setOwnProduct(false);
      setImage(null);
      if (fileRef.current) fileRef.current.value = "";
      router.refresh();
    });

  return (
    <Panel className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-medium">Ny produkt</h2>
        <p className="text-sm text-muted">
          Skapas i Awish och i Binderlab. Försäljningen kopplas av sig själv.
        </p>
      </div>
      <form
        className="grid gap-4 md:grid-cols-2"
        onSubmit={(e) => {
          e.preventDefault();
          doPreview();
        }}
      >
        <Input
          label="Namn"
          name="name"
          required
          maxLength={100}
          autoComplete="off"
          value={name}
          onChange={(e) => edit(setName)(e.target.value)}
          wrapperClassName="md:col-span-2"
        />
        <Input
          label="Försäljningspris"
          name="salePrice"
          required
          inputMode="decimal"
          suffix="kr"
          hint="Det kunden betalar i automaten."
          value={salePrice}
          onChange={(e) => edit(setSalePrice)(e.target.value)}
        />
        <Input
          label="Inköpspris"
          name="purchasePrice"
          required
          inputMode="decimal"
          suffix="kr"
          hint="Bara i Binderlab. Syns aldrig i Awish."
          value={purchasePrice}
          onChange={(e) => edit(setPurchasePrice)(e.target.value)}
        />
        <div className="md:col-span-2">
          <OwnProductSwitch on={ownProduct} onChange={edit(setOwnProduct)} />
        </div>
        <Input
          ref={fileRef}
          label="Bild"
          name="image"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hint="jpg, png eller webp. Awish visar den på automaten."
          className="h-auto py-1.5 text-sm"
          wrapperClassName="md:col-span-2"
          onChange={async (e) => {
            const file = e.target.files?.[0] ?? null;
            const small = file ? await shrinkImage(file) : null;
            if (small && small.size > MAX_IMAGE) {
              edit(setImage)(null);
              setError("Bilden är för stor (högst 4 MB).");
              e.target.value = "";
              return;
            }
            edit(setImage)(small);
          }}
        />
        <div className="flex flex-wrap gap-2 md:col-span-2">
          <Button
            type="submit"
            variant={preview ? "secondary" : "primary"}
            loading={busy === "preview"}
            disabled={pending}
          >
            Förhandsgranska
          </Button>
        </div>
      </form>
      {error ? (
        <p role="alert" className="text-sm text-signal-fg">
          {error}
        </p>
      ) : null}
      {preview ? (
        <PreviewBox preview={preview}>
          {!preview.blocking && !preview.idle ? (
            <div>
              <Button
                type="button"
                variant="primary"
                loading={busy === "send"}
                disabled={pending}
                onClick={send}
              >
                Skicka till Awish
              </Button>
            </div>
          ) : null}
        </PreviewBox>
      ) : null}
    </Panel>
  );
}

function slotOption(s: Slot): string {
  const name = s.channelName ? `Fack ${s.channelName}` : `Fack ${s.id}`;
  if (s.goodId === null) {
    return s.currentInventory > 0
      ? `${name} · utan vara · ${s.currentInventory} st`
      : `${name} · tomt`;
  }
  const cap = s.capacity ? ` av ${s.capacity}` : "";
  return `${name} · ${s.goodName ?? `vara ${s.goodId}`} · ${s.currentInventory}${cap} st`;
}

function SlotForm({
  machines,
  initialMachineId,
  onMachine,
  preferGood,
}: {
  machines: Machine[];
  initialMachineId: string;
  onMachine: (id: string) => void;
  preferGood: { id: number; name: string } | null;
}) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<"load" | "preview" | "send" | null>(null);
  const [machineId, setMachineId] = useState(initialMachineId);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [goods, setGoods] = useState<Good[]>([]);
  const [productId, setProductId] = useState("");
  const [goodId, setGoodId] = useState(preferGood ? String(preferGood.id) : "");
  const [count, setCount] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Vald automat från början (en enda automat, eller samma som före en ny produkt): läs
  // facken och varorna i Awish när formuläret visas.
  useEffect(() => {
    if (!initialMachineId) return;
    let alive = true;
    void loadSlotChoices(initialMachineId).then((r) => {
      if (!alive) return;
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setSlots(r.data.slots);
      setGoods(r.data.goods);
    });
    return () => {
      alive = false;
    };
  }, [initialMachineId]);

  const run = (kind: "load" | "preview" | "send", fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(kind);
    start(async () => {
      try {
        await fn();
      } finally {
        setBusy(null);
      }
    });
  };

  const load = (id: string) =>
    run("load", async () => {
      setSlots(null);
      setPreview(null);
      setError(null);
      if (!id) return;
      const r = await loadSlotChoices(id);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setSlots(r.data.slots);
      setGoods(r.data.goods);
    });

  const reset =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPreview(null);
      setConfirmed(false);
      setError(null);
    };

  const input = () => ({ machineId, productId, goodId, count });

  const doPreview = () =>
    run("preview", async () => {
      const r = await previewSlotChange(input());
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setConfirmed(false);
      setPreview({
        lines: r.data.lines,
        warnings: r.data.warnings,
        blocking: r.data.blocking,
        fingerprint: r.data.fingerprint,
        idle: r.data.unchanged,
        confirm: r.data.confirm,
      });
    });

  const send = () =>
    run("send", async () => {
      if (!preview) return;
      const r = await applySlotChange({ ...input(), fingerprint: preview.fingerprint, confirmed });
      if (!r.ok) {
        setError(r.error);
        setPreview(null);
        return;
      }
      toast({ title: r.data.message, tone: "ok" });
      setPreview(null);
      setCount("");
      const again = await loadSlotChoices(machineId);
      if (again.ok) {
        setSlots(again.data.slots);
        setGoods(again.data.goods);
      }
    });

  const slot = slots?.find((s) => String(s.id) === productId) ?? null;

  return (
    <Panel className="flex flex-col gap-4" id="fack">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-medium">Lägg i fack</h2>
        <p className="text-sm text-muted">
          Välj automat, fack och vara. Du ser ändringen innan den skickas.
        </p>
      </div>
      {machines.length === 0 ? (
        <p className="text-sm text-muted">Ingen automat är kopplad till Awish.</p>
      ) : (
        <form
          className="grid gap-4 md:grid-cols-2"
          onSubmit={(e) => {
            e.preventDefault();
            doPreview();
          }}
        >
          <Select
            label="Automat"
            name="machine"
            value={machineId}
            options={[
              ...(machines.length > 1 ? [{ value: "", label: "Välj automat" }] : []),
              ...machines.map((m) => ({
                value: m.id,
                label: m.code ? `${m.code} · ${m.name}` : m.name,
              })),
            ]}
            onChange={(e) => {
              reset(setMachineId)(e.target.value);
              onMachine(e.target.value);
              setProductId("");
              load(e.target.value);
            }}
          />
          <Select
            label="Fack"
            name="slot"
            value={productId}
            disabled={!slots || slots.length === 0}
            options={[
              {
                value: "",
                label:
                  busy === "load"
                    ? "Läser Awish…"
                    : slots && slots.length === 0
                      ? "Inga fack i Awish"
                      : "Välj fack",
              },
              ...(slots ?? []).map((s) => ({ value: String(s.id), label: slotOption(s) })),
            ]}
            onChange={(e) => reset(setProductId)(e.target.value)}
          />
          <Select
            label="Vara"
            name="good"
            value={goodId}
            disabled={goods.length === 0}
            options={[
              { value: "", label: "Välj vara" },
              ...goods.map((g) => ({
                value: String(g.id),
                label: `${g.name} · ${kr(g.priceOre)}`,
              })),
            ]}
            onChange={(e) => reset(setGoodId)(e.target.value)}
          />
          <Input
            label="Antal (valfritt)"
            name="count"
            type="number"
            inputMode="numeric"
            min={0}
            max={slot?.capacity ?? 999}
            suffix="st"
            hint={
              slot
                ? `Tomt = ${String(slot.goodId) === goodId ? `behåll ${slot.currentInventory}` : "0"}.${slot.capacity ? ` Rymmer ${slot.capacity}.` : ""}`
                : "Tomt = behåll antalet (0 vid ny vara)."
            }
            value={count}
            onChange={(e) => reset(setCount)(e.target.value)}
          />
          <div className="flex flex-wrap gap-2 md:col-span-2">
            <Button
              type="submit"
              variant={preview ? "secondary" : "primary"}
              loading={busy === "preview"}
              disabled={pending || !machineId || !productId || !goodId}
            >
              Förhandsgranska
            </Button>
          </div>
        </form>
      )}
      {error ? (
        <p role="alert" className="text-sm text-signal-fg">
          {error}
        </p>
      ) : null}
      {preview ? (
        <PreviewBox preview={preview}>
          {preview.confirm && !preview.blocking && !preview.idle ? (
            <label className="flex min-h-11 items-center gap-3 text-sm text-fg">
              <input
                type="checkbox"
                className="size-5 shrink-0 accent-current"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              <span>{preview.confirm}</span>
            </label>
          ) : null}
          {!preview.blocking && !preview.idle ? (
            <div>
              <Button
                type="button"
                variant="primary"
                loading={busy === "send"}
                disabled={pending || (preview.confirm !== null && !confirmed)}
                onClick={send}
              >
                Skicka till Awish
              </Button>
            </div>
          ) : null}
        </PreviewBox>
      ) : null}
    </Panel>
  );
}

/** "Ny produkt" och "Lägg i fack". En ny vara väljs direkt i fackformuläret. */
export function NewProductPanels({ machines }: { machines: Machine[] }) {
  const [created, setCreated] = useState<{ id: number; name: string } | null>(null);
  const [machineId, setMachineId] = useState(machines.length === 1 ? machines[0]!.id : "");
  return (
    <div className="grid gap-8 lg:grid-cols-2 lg:items-start">
      <NewProductForm onCreated={setCreated} />
      {/* Ny vara: fackformuläret börjar om med varan vald och facken lästa på nytt. */}
      <SlotForm
        key={created?.id ?? 0}
        machines={machines}
        initialMachineId={machineId}
        onMachine={setMachineId}
        preferGood={created}
      />
    </div>
  );
}
