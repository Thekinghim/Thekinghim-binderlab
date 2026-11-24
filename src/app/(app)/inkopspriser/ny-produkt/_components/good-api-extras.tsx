"use client";

import Link from "next/link";
import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/field";

import {
  PreviewDialog,
  usePreviewFlow,
} from "../../../installningar/awish/_components/preview-dialog";
import {
  deleteGood,
  goodCategories,
  previewDeleteGood,
  previewGoodCategory,
  setGoodCategory,
} from "../goods-api-actions";

/**
 * Under "Redigera vara": kategori (flik på automatens skärm) och "Ta bort vara". Båda via
 * Awishs API med förhandsvisning och bekräftelse. Kategorierna läses först när man trycker.
 */
export function GoodApiExtras({
  goodId,
  goodName,
  onDeleted,
}: {
  goodId: number;
  goodName: string;
  onDeleted: () => void;
}) {
  const [categories, setCategories] = useState<{ id: string; title: string }[] | null>(null);
  const [categoryId, setCategoryId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const category = usePreviewFlow<Record<string, unknown>>({
    preview: (p) => previewGoodCategory(p),
    apply: (p) => setGoodCategory(p),
  });
  const remove = usePreviewFlow<Record<string, unknown>>({
    preview: (p) => previewDeleteGood(p),
    apply: (p) => deleteGood(p),
    onDone: onDeleted,
  });

  const loadCategories = () =>
    startLoading(async () => {
      setError(null);
      const r = await goodCategories().catch(() => ({
        ok: false as const,
        error: "Ingen kontakt med servern. Försök igen.",
      }));
      if (!r.ok) {
        setError(r.error);
        return;
      }
      setCategories(r.data);
      setCategoryId(r.data[0]?.id ?? "");
    });

  return (
    <div className="flex flex-col gap-3 border-t border-line pt-4">
      <h3 className="text-v2-sm font-[650] text-v2-ink">Mer i Awish</h3>
      {categories === null ? (
        <div>
          <Button type="button" variant="secondary" loading={loading} onClick={loadCategories}>
            Byt kategori
          </Button>
        </div>
      ) : categories.length === 0 ? (
        <p className="text-sm text-muted">
          Inga kategorier i Awish.{" "}
          <Link href="/inkopspriser/kategorier" className="underline underline-offset-4">
            Skapa en
          </Link>
          .
        </p>
      ) : (
        <div className="flex flex-wrap items-end gap-2">
          <Select
            label="Kategori"
            value={categoryId}
            options={categories.map((c) => ({ value: c.id, label: c.title }))}
            onChange={(e) => setCategoryId(e.target.value)}
            className="max-md:h-11"
          />
          <Button
            type="button"
            variant="secondary"
            disabled={!categoryId}
            loading={category.pending && !category.preview}
            onClick={() => category.open({ goodId, goodName, categoryId })}
            className="max-md:h-11"
          >
            Förhandsgranska
          </Button>
        </div>
      )}
      {error ? (
        <p role="alert" className="text-sm text-signal-fg">
          {error}
        </p>
      ) : null}
      <div>
        <Button
          type="button"
          variant="danger"
          loading={remove.pending && !remove.preview}
          onClick={() => remove.open({ goodId, goodName })}
          className="max-md:h-11"
        >
          Ta bort vara
        </Button>
      </div>
      <PreviewDialog flow={category} title="Byt kategori?" confirmLabel="Spara i Awish" />
      <PreviewDialog flow={remove} title="Ta bort varan?" confirmLabel="Ta bort" danger />
    </div>
  );
}
