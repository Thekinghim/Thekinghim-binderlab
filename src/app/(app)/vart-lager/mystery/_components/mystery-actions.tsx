"use client";

import { useState, useTransition } from "react";

import { useToast } from "@/components/ui/toast";
import { useT } from "@/i18n/client";

import { undoMysteryPack } from "../actions";
import type { CalcFees, Recipe } from "../_lib/model";
import { ContentsCard } from "./contents-card";
import { RecipeEditor } from "./recipe-editor";

/** Ångra en packning (inom 30 minuter). */
export function UndoPackButton({ packingId }: { packingId: string }) {
  const toast = useToast();
  const t = useT();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await undoMysteryPack({ packingId }).catch(() => ({
            ok: false as const,
            error: t.common.offlineRetry,
          }));
          toast(
            res.ok
              ? { title: t.mystery.undone, tone: "neutral" }
              : {
                  title: t.mystery.undoFailed,
                  description: t.serverError(res.error),
                  tone: "critical",
                },
          );
        })
      }
      className="inline-flex h-11 shrink-0 items-center rounded-sm border border-line-strong px-3 text-sm font-medium text-fg hover:bg-hover disabled:border-dashed disabled:text-disabled"
    >
      {pending ? t.common.undoing : t.common.undo}
    </button>
  );
}

/** Det kalkylen behöver medan innehållet ändras: priserna på delarna, priset och avgifterna. */
export interface CalcContext {
  /** Dagens inköpspris per titel (öre). */
  readonly prices: Readonly<Record<string, number>>;
  readonly salePriceOre: number | null;
  readonly fees: CalcFees;
}

/**
 * Innehållet (etiketten) med "Ändra innehåll" för ägare och admin. Med `calc` visar
 * redigeraren kalkylen live medan antalen ändras ("vad händer om").
 */
export function ContentsSection({
  titleId,
  recipe,
  choices,
  canEdit,
  calc,
}: {
  titleId: string;
  recipe: Recipe | null;
  choices: ReadonlyArray<{ id: string; name: string }>;
  canEdit: boolean;
  calc?: CalcContext | null;
}) {
  const t = useT();
  const [editing, setEditing] = useState(recipe === null);
  if (canEdit && (editing || recipe === null)) {
    return (
      <RecipeEditor
        titleId={titleId}
        recipe={recipe}
        choices={choices}
        calc={calc ?? null}
        onDone={() => setEditing(false)}
      />
    );
  }
  if (!recipe) {
    return <p className="text-base text-muted">{t.mystery.noContentsOwner}</p>;
  }
  return (
    <div className="flex flex-col gap-3">
      <ContentsCard recipe={recipe} />
      {canEdit ? (
        <button
          type="button"
          onClick={() => setEditing(true)}
          className="inline-flex h-11 w-fit items-center gap-2 rounded-sm border border-line-strong px-4 text-base text-fg hover:bg-hover"
        >
          {t.mystery.editContents}
        </button>
      ) : null}
    </div>
  );
}
