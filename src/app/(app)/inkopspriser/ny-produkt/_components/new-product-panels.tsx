"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Panel } from "@/components/ui/frame";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";

import { pickPreselectedGood } from "../_lib/fack";
import { squareImage } from "../_lib/square-file";
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
export type Preview = {
  lines: string[];
  warnings: string[];
  blocking: string | null;
  fingerprint: string;
  /** Ny produkt: allt finns redan. Fack: inget ändras. */
  idle: boolean;
  /** Fack: fråga som måste bekräftas. */
  confirm: string | null;
};

const MAX_IMAGE = 4 * 1024 * 1024;

function kr(ore: number | null): string {
  if (ore === null) return "inget pris";
  const whole = Math.trunc(ore / 100).toLocaleString("sv-SE");
  const rest = ore % 100;
  return rest === 0 ? `${whole} kr` : `${whole},${String(rest).padStart(2, "0")} kr`;
}

export function PreviewBox({
  preview,
  children,
}: {
  preview: Preview;
  children?: React.ReactNode;
}) {
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
          "relative inline-flex h-8 w-14 shrink-0 items-center rounded-full border transition-colors duration-fast ease-instrument max-md:before:absolute max-md:before:inset-x-0 max-md:before:-inset-y-1.5 max-md:before:content-['']",
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
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  useEffect(
    () => () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    },
    [imageUrl],
  );
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
      setImageUrl(null);
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
          hint="jpg, png eller webp. Läggs i en kvadrat så den inte sträcks ut."
          className="h-auto py-1.5 text-sm"
          wrapperClassName="md:col-span-2"
          onChange={async (e) => {
            const file = e.target.files?.[0] ?? null;
            const small = file ? await squareImage(file) : null;
            if (small && small.size > MAX_IMAGE) {
              edit(setImage)(null);
              setImageUrl(null);
              setError("Bilden är för stor (högst 4 MB).");
              e.target.value = "";
              return;
            }
            edit(setImage)(small);
            setImageUrl(small ? URL.createObjectURL(small) : null);
          }}
        />
        {imageUrl ? (
          <div className="flex items-center gap-3 md:col-span-2">
            {/* eslint-disable-next-line @next/next/no-img-element -- lokal förhandsvisning (blob:) */}
            <img
              src={imageUrl}
              alt="Bilden som skickas till Awish"
              width={96}
              height={96}
              className="size-24 rounded-sm border border-line bg-[repeating-conic-gradient(var(--color-line)_0_25%,transparent_0_50%)] bg-[length:12px_12px] object-contain"
            />
            <p className="text-sm text-subtle">Så här ser bilden ut i Awish.</p>
          </div>
        ) : null}
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

type Choices = {
  slots: Slot[];
  goods: Good[];
  title: { titleName: string | null; goodId: number | null } | null;
};

/** Vad som ska vara valt från början: en vara (?vara=) eller titelns vara (?titel=). */
export type SlotPreselect = { goodId: number | null; titleId: string | null };

function SlotForm({
  machines,
  initialMachineId,
  preselect,
}: {
  machines: Machine[];
  initialMachineId: string;
  preselect: SlotPreselect;
}) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<"load" | "preview" | "send" | null>(null);
  const [machineId, setMachineId] = useState(initialMachineId);
  const [slots, setSlots] = useState<Slot[] | null>(null);
  const [goods, setGoods] = useState<Good[]>([]);
  const [productId, setProductId] = useState("");
  const [goodId, setGoodId] = useState("");
  const [count, setCount] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // Förvalet från adressen används en gång, när varorna i Awish först har lästs. En vara som
  // inte finns i Awish (gammal länk, fel id) väljs inte.
  const wanted = useRef<SlotPreselect | null>(
    preselect.goodId !== null || preselect.titleId !== null ? preselect : null,
  );

  const show = (data: Choices) => {
    setSlots(data.slots);
    setGoods(data.goods);
    const want = wanted.current;
    if (!want) return;
    wanted.current = null;
    const pick = pickPreselectedGood(want, data.goods, data.title);
    if (pick.goodId) setGoodId(pick.goodId);
    setNotice(pick.notice);
  };

  const read = (id: string) =>
    loadSlotChoices(id, wanted.current?.goodId === null ? wanted.current.titleId : undefined);

  // Vald automat från början (en enda automat, eller den valda i Inköpspriser): läs facken
  // och varorna i Awish när formuläret visas.
  useEffect(() => {
    if (!initialMachineId) return;
    let alive = true;
    void read(initialMachineId).then((r) => {
      if (!alive) return;
      if (!r.ok) {
        setError(r.error);
        return;
      }
      show(r.data);
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
      const r = await read(id);
      if (!r.ok) {
        setError(r.error);
        return;
      }
      show(r.data);
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
      if (again.ok) show(again.data);
    });

  const slot = slots?.find((s) => String(s.id) === productId) ?? null;
  const good = goods.find((g) => String(g.id) === goodId) ?? null;

  return (
    <Panel className="flex flex-col gap-4" id="fack">
      <div className="flex flex-col gap-1">
        <h2 className="text-lg font-medium">Lägg i fack</h2>
        <p className="text-sm text-muted">
          {good
            ? `Var ska ${good.name} ligga? Välj fack. Du ser ändringen innan den skickas.`
            : "Välj automat, fack och vara. Du ser ändringen innan den skickas."}
        </p>
      </div>
      {notice ? <p className="text-sm text-muted">{notice}</p> : null}
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
            className="max-md:h-11"
            options={[
              ...(machines.length > 1 ? [{ value: "", label: "Välj automat" }] : []),
              ...machines.map((m) => ({
                value: m.id,
                label: m.code ? `${m.code} · ${m.name}` : m.name,
              })),
            ]}
            onChange={(e) => {
              reset(setMachineId)(e.target.value);
              setProductId("");
              load(e.target.value);
            }}
          />
          <Select
            label="Fack"
            name="slot"
            value={productId}
            disabled={!slots || slots.length === 0}
            className="max-md:h-11"
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
            className="max-md:h-11"
            options={[
              { value: "", label: "Välj vara" },
              ...goods.map((g) => ({
                value: String(g.id),
                label: `${g.name} · ${kr(g.priceOre)}`,
              })),
            ]}
            onChange={(e) => {
              reset(setGoodId)(e.target.value);
              setNotice(null);
            }}
          />
          <Input
            label="Antal (valfritt)"
            name="count"
            type="number"
            inputMode="numeric"
            min={0}
            max={slot?.capacity ?? 999}
            suffix="st"
            className="max-md:h-11"
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
              className="max-md:h-11"
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
                className="max-md:h-11"
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

/** Fliken "Lägg i fack": fackformuläret, ev. med en vara (eller titelns vara) förvald. */
export function SlotPanel({
  machines,
  initialMachineId,
  preselect,
}: {
  machines: Machine[];
  initialMachineId: string;
  preselect: SlotPreselect;
}) {
  return (
    <div className="max-w-2xl">
      {/* Ny vara i adressen: formuläret börjar om med den varan vald. */}
      <SlotForm
        key={`${preselect.goodId ?? ""}-${preselect.titleId ?? ""}`}
        machines={machines}
        initialMachineId={initialMachineId}
        preselect={preselect}
      />
    </div>
  );
}

/** Fliken "Ny produkt". Efter en ny vara: en länk som lägger den i ett fack. */
export function NewProductPanels() {
  const [created, setCreated] = useState<{ id: number; name: string } | null>(null);
  return (
    <div className="flex max-w-2xl flex-col gap-4">
      {created ? (
        <div
          role="status"
          className="flex flex-col gap-3 rounded-md border border-line-strong p-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <p className="text-sm text-fg">{created.name} finns nu i Awish.</p>
          <Link
            href={`/inkopspriser/ny-produkt?flik=fack&vara=${created.id}`}
            className="inline-flex h-11 w-fit items-center rounded-sm border border-inverse bg-inverse px-3.5 text-base font-medium text-on-inverse hover:border-inverse-hover hover:bg-inverse-hover md:h-9"
          >
            Lägg den i ett fack →
          </Link>
        </div>
      ) : null}
      <NewProductForm onCreated={setCreated} />
    </div>
  );
}
