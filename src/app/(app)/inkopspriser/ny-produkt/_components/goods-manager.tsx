"use client";

import Link from "next/link";
import { useEffect, useMemo, useRef, useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Panel } from "@/components/ui/frame";
import { MobileTopList } from "@/components/ui/mobile-top-list";
import { StatusTag } from "@/components/ui/status-tag";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import {
  filterGoodRows,
  GOODS_FILTERS,
  goodsFilterCounts,
  withEditedGood,
  type GoodFlagKind,
  type GoodRow,
  type GoodsFilter,
} from "@/server/awish/goods-overview";

import { linkGoodToTitle, previewEditGood, saveEditGood } from "../actions";
import { squareImage } from "../_lib/square-file";
import { PreviewBox, type Preview } from "./new-product-panels";

const MAX_IMAGE = 4 * 1024 * 1024;

type Scope = { storeId: string | null; machineId: string | null };
type Title = { id: string; name: string };

function kr(ore: number | null): string {
  if (ore === null) return "–";
  const sign = ore < 0 ? "−" : "";
  const abs = Math.abs(ore);
  const whole = Math.trunc(abs / 100).toLocaleString("sv-SE");
  const rest = abs % 100;
  return rest === 0 ? `${sign}${whole} kr` : `${sign}${whole},${String(rest).padStart(2, "0")} kr`;
}

/** Priset i fältet: "150" eller "79,50". */
function priceField(ore: number | null): string {
  if (ore === null) return "";
  const rest = ore % 100;
  return rest === 0
    ? String(Math.trunc(ore / 100))
    : `${Math.trunc(ore / 100)},${String(rest).padStart(2, "0")}`;
}

/** Kronor som användaren skriver → öre (samma regel som servern), eller null. */
function parseKr(raw: string): number | null {
  const s = raw.replace(/\s|kr/gi, "").replace(",", ".");
  if (!/^\d{1,7}(\.\d{1,2})?$/.test(s)) return null;
  const [whole, frac = ""] = s.split(".");
  return Number(whole) * 100 + Number(frac.padEnd(2, "0"));
}

const cleanName = (s: string) => s.normalize("NFC").replace(/\s+/g, " ").trim();

const SERIOUS: readonly GoodFlagKind[] = ["duplicate", "unlinked", "no-purchase"];

function Thumb({
  src,
  name,
  size = "md",
}: {
  src: string | null;
  name: string;
  size?: "md" | "lg";
}) {
  const [broken, setBroken] = useState(false);
  const box = size === "lg" ? "size-24" : "size-14";
  if (!src || broken) {
    return (
      <span
        aria-hidden
        className={cn(
          box,
          "label flex shrink-0 items-center justify-center rounded-sm border border-dashed border-line-strong text-center text-subtle",
        )}
      >
        Ingen bild
      </span>
    );
  }
  return (
    // eslint-disable-next-line @next/next/no-img-element -- Awishs bild via Binderlabs bildväg (eller lokal blob:)
    <img
      src={src}
      alt={`Bild på ${name}`}
      loading="lazy"
      onError={() => setBroken(true)}
      className={cn(
        box,
        "shrink-0 rounded-sm border border-line bg-[repeating-conic-gradient(var(--color-line)_0_25%,transparent_0_50%)] bg-[length:12px_12px] object-contain",
      )}
    />
  );
}

function slotText(r: GoodRow): string {
  if (r.slots.length === 0) return "Inte i något fack";
  const parts = r.slots.map((s) => `${s.machine} fack ${s.slot}: ${s.count} st`);
  return parts.join(" · ");
}

function GoodLine({
  row,
  titles,
  selected,
  pending,
  showShare,
  onEdit,
  onLinked,
}: {
  row: GoodRow;
  titles: Title[];
  selected: boolean;
  pending: boolean;
  showShare: boolean;
  onEdit: () => void;
  onLinked: (goodId: number, title: Title) => void;
}) {
  const toast = useToast();
  const [linking, setLinking] = useState(false);
  const [target, setTarget] = useState("");
  const [busy, startLink] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const kinds = new Set(row.flags.map((f) => f.kind));
  const noSlot = kinds.has("no-slot");
  const slotLink = (
    <Link
      href={`/inkopspriser/ny-produkt?flik=fack&vara=${row.id}`}
      className={cn(
        "inline-flex h-9 items-center justify-center rounded-sm border px-3.5 text-base font-medium whitespace-nowrap transition-colors max-md:h-11",
        noSlot
          ? "border-inverse bg-inverse text-on-inverse hover:border-inverse-hover hover:bg-inverse-hover"
          : "border-line-strong bg-surface text-fg hover:border-line-control hover:bg-hover",
      )}
    >
      Lägg i fack<span className="sr-only">: {row.name}</span>
    </Link>
  );

  const link = () =>
    startLink(async () => {
      setError(null);
      const r = await linkGoodToTitle({ goodId: row.id, titleId: target || null });
      if (!r.ok) {
        setError(r.error);
        return;
      }
      toast({ title: r.data.message, tone: "ok" });
      setLinking(false);
      onLinked(row.id, { id: r.data.titleId, name: r.data.titleName });
    });

  return (
    <li
      className={cn(
        "flex gap-3 border-b border-line py-4",
        selected && "-mx-2 rounded-sm bg-hover/40 px-2",
      )}
      aria-current={selected ? "true" : undefined}
    >
      <Thumb src={row.image} name={row.name} />
      <div className="flex min-w-0 flex-1 flex-col gap-1.5">
        <div className="flex items-baseline justify-between gap-3">
          <p className="min-w-0 font-medium break-words text-fg">{row.name}</p>
          <p className="tnum shrink-0 text-fg">{kr(row.priceOre)}</p>
        </div>
        {row.titleId ? (
          <p className="meta text-muted">
            Sålt <span className="tnum text-fg">{row.sold30} st</span>
            {row.sold30 > 0 ? <> · {kr(row.revenue30Ore)}</> : null} på 30 d
            {row.titleName && row.titleName !== row.name ? <> · titel {row.titleName}</> : null}
          </p>
        ) : null}
        <p className="meta break-words text-muted">
          {slotText(row)}
          {row.packsInSlots > 0 && row.slots.length > 1 ? (
            <> · totalt {row.packsInSlots} st</>
          ) : null}
        </p>
        {row.titleId ? (
          <p className="meta text-muted">
            Vårt lager <span className="tnum">{row.warehouse ?? 0} st</span>
            {row.purchaseOre !== null ? <> · inköp {kr(row.purchaseOre)}</> : null}
            {row.leftOre !== null ? (
              <>
                {" "}
                · kvar per order <span className="tnum text-fg">{kr(row.leftOre)}</span>
              </>
            ) : null}
            {showShare && row.shareLeftOre !== null ? <> · vår del {kr(row.shareLeftOre)}</> : null}
          </p>
        ) : null}
        {row.flags.length > 0 ? (
          <ul className="flex flex-wrap gap-1.5" aria-label="Behöver åtgärd">
            {row.flags.map((f) => (
              <li key={f.kind}>
                <StatusTag status={SERIOUS.includes(f.kind) ? "critical" : "warning"}>
                  {f.label}
                </StatusTag>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="mt-1 flex flex-wrap items-center gap-2">
          {/* Inte i något fack: Lägg i fack är det viktigaste, först och fylld. */}
          {noSlot ? slotLink : null}
          <Button
            type="button"
            variant={selected && !noSlot ? "primary" : "secondary"}
            onClick={onEdit}
            disabled={pending}
            className="max-md:h-11"
          >
            {pending ? "Sparar…" : "Redigera"}
          </Button>
          {noSlot ? null : slotLink}
          {kinds.has("no-purchase") && row.titleId ? (
            <Link
              href={`/inkopspriser?titel=${row.titleId}#titel`}
              className="inline-flex h-9 items-center rounded-sm px-2 text-sm text-muted underline underline-offset-4 hover:text-fg max-md:h-11"
            >
              Sätt inköpspris
            </Link>
          ) : null}
          {kinds.has("unlinked") ? (
            <Button
              type="button"
              variant="ghost"
              aria-expanded={linking}
              onClick={() => setLinking((v) => !v)}
              className="max-md:h-11"
            >
              Koppla
            </Button>
          ) : null}
        </div>
        {linking ? (
          <div className="flex flex-col gap-2 rounded-sm border border-line-strong p-3">
            <Select
              label="Koppla till"
              value={target}
              className="max-md:h-11"
              options={[
                { value: "", label: `Ny titel: ${row.name}` },
                ...titles.map((t) => ({ value: t.id, label: t.name })),
              ]}
              onChange={(e) => setTarget(e.target.value)}
            />
            <p className="meta text-subtle">Försäljningen av varan räknas sedan på titeln.</p>
            <div>
              <Button
                type="button"
                variant="primary"
                loading={busy}
                onClick={link}
                className="max-md:h-11"
              >
                Koppla
              </Button>
            </div>
            {error ? (
              <p role="alert" className="text-sm text-signal-fg">
                {error}
              </p>
            ) : null}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function EditPanel({
  row,
  scope,
  onClose,
  onOptimistic,
  onSaved,
  onFailed,
}: {
  row: GoodRow | null;
  scope: Scope;
  onClose: () => void;
  onOptimistic: (next: { name: string; priceOre: number | null; image: string | null }) => void;
  onSaved: (good: {
    id: number;
    name: string;
    priceOre: number | null;
    image: string | null;
  }) => void;
  onFailed: () => void;
}) {
  const toast = useToast();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<"preview" | "send" | null>(null);
  const [name, setName] = useState(row?.name ?? "");
  const [price, setPrice] = useState(priceField(row?.priceOre ?? null));
  const [image, setImage] = useState<File | null>(null);
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<(Preview & { effect: string[] }) | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(
    () => () => {
      if (imageUrl) URL.revokeObjectURL(imageUrl);
    },
    [imageUrl],
  );

  if (!row) {
    return (
      // Mobilen: ingen tom ruta överst; redigeraren visas när en vara väljs.
      <Panel className="flex flex-col gap-2 max-lg:hidden">
        <h2 className="text-lg font-medium">Redigera vara</h2>
        <p className="text-sm text-muted">Tryck Redigera på en vara i listan.</p>
      </Panel>
    );
  }

  const edit =
    <T,>(set: (v: T) => void) =>
    (v: T) => {
      set(v);
      setPreview(null);
      setError(null);
    };

  const form = (fingerprint?: string) => {
    const fd = new FormData();
    fd.set("input", JSON.stringify({ goodId: row.id, name, salePrice: price, scope }));
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
      const r = await previewEditGood(form());
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
        effect: r.data.effect,
      });
    });

  const send = () =>
    run("send", async () => {
      if (!preview) return;
      onOptimistic({
        name: cleanName(name),
        priceOre: parseKr(price) ?? row.priceOre,
        image: imageUrl ?? row.image,
      });
      const r = await saveEditGood(form(preview.fingerprint));
      if (!r.ok) {
        onFailed();
        setError(r.error);
        setPreview(null);
        return;
      }
      onSaved(r.data.good);
      toast({
        title: r.data.message,
        tone: r.data.status === "saved" || r.data.status === "nothing" ? "ok" : "critical",
      });
      setPreview(null);
      setName(r.data.good.name);
      setPrice(priceField(r.data.good.priceOre));
      setImage(null);
      setImageUrl(null);
      if (fileRef.current) fileRef.current.value = "";
    });

  return (
    <Panel className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <Thumb src={row.image} name={row.name} />
          <div className="flex min-w-0 flex-col">
            <h2 className="text-lg font-medium">Redigera vara</h2>
            <p className="meta break-words text-subtle">
              {row.name} · id {row.id}
            </p>
          </div>
        </div>
        <Button type="button" variant="ghost" onClick={onClose} className="max-md:h-11">
          Stäng
        </Button>
      </div>
      <form
        className="grid gap-4"
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
          className="max-md:h-11"
          onChange={(e) => edit(setName)(e.target.value)}
        />
        <Input
          label="Försäljningspris"
          name="salePrice"
          required
          inputMode="decimal"
          suffix="kr"
          hint="Det kunden betalar i automaten."
          value={price}
          className="max-md:h-11"
          onChange={(e) => edit(setPrice)(e.target.value)}
        />
        <Input
          ref={fileRef}
          label="Ny bild (valfritt)"
          name="image"
          type="file"
          accept="image/jpeg,image/png,image/webp"
          hint="Läggs i en kvadrat så den inte sträcks ut."
          className="h-auto py-1.5 text-sm max-md:min-h-11"
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
          <div className="flex items-center gap-3">
            <Thumb src={imageUrl} name={name} size="lg" />
            <p className="text-sm text-subtle">Så här ser den nya bilden ut i Awish.</p>
          </div>
        ) : null}
        <div className="flex flex-wrap items-center gap-3">
          <Button
            type="submit"
            variant={preview ? "secondary" : "primary"}
            loading={busy === "preview"}
            disabled={pending}
            className="max-md:h-11"
          >
            Förhandsgranska
          </Button>
          {row.titleId ? (
            <Link
              href={`/inkopspriser?titel=${row.titleId}#titel`}
              className="inline-flex h-9 items-center text-sm text-muted underline underline-offset-4 hover:text-fg max-md:h-11"
            >
              Inköpspris och Egen produkt →
            </Link>
          ) : null}
        </div>
      </form>
      {error ? (
        <p role="alert" className="text-sm text-signal-fg">
          {error}
        </p>
      ) : null}
      {preview ? (
        <PreviewBox preview={preview}>
          {preview.effect.length > 0 && !preview.blocking ? (
            <ul className="flex flex-col gap-1 border-t border-line pt-3 text-sm text-fg">
              {preview.effect.map((l, i) => (
                <li key={i} className={i > 0 ? "text-muted" : undefined}>
                  {l}
                </li>
              ))}
            </ul>
          ) : null}
          {!preview.blocking && !preview.idle ? (
            <div>
              <Button
                type="button"
                variant="primary"
                loading={busy === "send"}
                disabled={pending}
                onClick={send}
                className="max-md:h-11"
              >
                Spara i Awish
              </Button>
            </div>
          ) : null}
        </PreviewBox>
      ) : null}
    </Panel>
  );
}

/** "Varor i Awish": sök, filter, listan och redigeraren. */
export function GoodsManager({
  rows: initialRows,
  titles,
  showShare,
  notices,
  scope,
  preselect,
}: {
  rows: GoodRow[];
  titles: Title[];
  showShare: boolean;
  notices: string[];
  scope: Scope;
  preselect: { titleId: string | null; goodId: number | null };
}) {
  // Nya rader från servern (efter en sparad ändring) ersätter de optimistiska.
  const [base, setBase] = useState(initialRows);
  const [rows, setRows] = useState(initialRows);
  if (base !== initialRows) {
    setBase(initialRows);
    setRows(initialRows);
  }
  const initial = useMemo(() => {
    if (preselect.goodId !== null && initialRows.some((r) => r.id === preselect.goodId)) {
      return { selected: preselect.goodId, query: "", notice: null as string | null };
    }
    if (preselect.titleId) {
      const hits = initialRows.filter((r) => r.titleId === preselect.titleId);
      const title = titles.find((t) => t.id === preselect.titleId)?.name ?? "titeln";
      if (hits.length === 1) return { selected: hits[0]!.id, query: "", notice: null };
      if (hits.length > 1) return { selected: null, query: title, notice: null };
      return {
        selected: null,
        query: "",
        notice: `Ingen vara i Awish heter som ${title}. Byt namn på varan här, eller koppla den.`,
      };
    }
    return { selected: null, query: "", notice: null };
    // Bara vid första visningen.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const [query, setQuery] = useState(initial.query);
  const [filter, setFilter] = useState<GoodsFilter>("alla");
  const [selectedId, setSelectedId] = useState<number | null>(initial.selected);
  const [pendingId, setPendingId] = useState<number | null>(null);
  // Raderna före en optimistisk ändring (tillbaka om Awish nekar).
  const beforeSave = useRef<GoodRow[] | null>(null);
  const editorRef = useRef<HTMLDivElement>(null);

  const counts = goodsFilterCounts(rows);
  const visible = filterGoodRows(rows, filter, query);
  const selected = rows.find((r) => r.id === selectedId) ?? null;

  useEffect(() => {
    if (initial.selected !== null) {
      editorRef.current?.scrollIntoView({ block: "start" });
    }
  }, [initial.selected]);

  const select = (id: number) => {
    setSelectedId(id);
    // Mobilen: redigeraren ligger överst; rulla dit.
    if (typeof window !== "undefined" && window.matchMedia("(max-width: 1023px)").matches) {
      requestAnimationFrame(() => editorRef.current?.scrollIntoView({ block: "start" }));
    }
  };

  return (
    <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_400px] lg:items-start">
      <div
        ref={editorRef}
        className={cn(
          "scroll-mt-24 lg:sticky lg:top-24 lg:order-last",
          !selected && "max-lg:hidden",
        )}
      >
        <EditPanel
          key={selected ? `${selected.id}` : "ingen"}
          row={selected}
          scope={scope}
          onClose={() => setSelectedId(null)}
          onOptimistic={(next) => {
            if (!selected) return;
            beforeSave.current = rows;
            setPendingId(selected.id);
            setRows((cur) => withEditedGood(cur, selected.id, next));
          }}
          onSaved={(good) => {
            setPendingId(null);
            beforeSave.current = null;
            setRows((cur) => withEditedGood(cur, good.id, good));
          }}
          onFailed={() => {
            setPendingId(null);
            const prev = beforeSave.current;
            if (prev) setRows(prev);
            beforeSave.current = null;
          }}
        />
      </div>
      <section aria-labelledby="varor-rubrik" className="flex min-w-0 flex-col gap-4">
        <h2 id="varor-rubrik" className="sr-only">
          Varor
        </h2>
        <Input
          label="Sök vara"
          type="search"
          name="q"
          autoComplete="off"
          placeholder="Namn, titel eller id"
          value={query}
          className="max-md:h-11"
          onChange={(e) => setQuery(e.target.value)}
        />
        <div role="group" aria-label="Visa" className="flex flex-wrap gap-2">
          {GOODS_FILTERS.map((f) => (
            <button
              key={f.value}
              type="button"
              aria-pressed={filter === f.value}
              onClick={() => setFilter(f.value)}
              className={cn(
                "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-sm transition-colors max-md:h-11",
                filter === f.value
                  ? "border-inverse bg-inverse text-on-inverse"
                  : "border-line-strong text-muted hover:text-fg",
              )}
            >
              {f.label}
              <span className="tnum opacity-80">{counts[f.value]}</span>
            </button>
          ))}
        </div>
        {initial.notice ? <p className="text-sm text-muted">{initial.notice}</p> : null}
        {notices.map((n) => (
          <p key={n} className="text-sm text-muted">
            {n}
          </p>
        ))}
        {visible.length === 0 ? (
          <p className="text-sm text-muted">
            {rows.length === 0 ? "Inga varor i Awish ännu." : "Inga varor matchar."}
          </p>
        ) : (
          <MobileTopList total={visible.length} noun="varor" ariaLabel="Varor i Awish">
            {visible.map((r) => (
              <GoodLine
                key={r.id}
                row={r}
                titles={titles}
                selected={r.id === selectedId}
                pending={r.id === pendingId}
                showShare={showShare}
                onEdit={() => select(r.id)}
                onLinked={(goodId, title) =>
                  setRows((cur) =>
                    cur.map((x) =>
                      x.id === goodId
                        ? {
                            ...x,
                            titleId: title.id,
                            titleName: title.name,
                            flags: x.flags.filter((f) => f.kind !== "unlinked"),
                          }
                        : x,
                    ),
                  )
                }
              />
            ))}
          </MobileTopList>
        )}
      </section>
    </div>
  );
}
