"use client";

import { useState, useTransition } from "react";

import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";

import { setMysteryCost, undoMysteryPack } from "../actions";
import type { Recipe } from "../_lib/model";
import { ContentsCard } from "./contents-card";
import { RecipeEditor } from "./recipe-editor";

/** "Sätt inköpspris till 76,07 kr": ett inköpspris från i dag (ägare, admin). */
export function SetCostButton({
  titleId,
  unitCostOre,
  label,
}: {
  titleId: string;
  unitCostOre: number;
  label: string;
}) {
  const toast = useToast();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await setMysteryCost({ titleId, unitCostOre });
          toast(
            res.ok
              ? { title: "Inköpspriset är satt från i dag.", tone: "ok" }
              : { title: "Sparades inte", description: res.error, tone: "critical" },
          );
        })
      }
      className={cn(
        "flex h-12 items-center justify-center gap-2 rounded-md border px-4 text-base font-medium",
        pending
          ? "border-dashed border-line-strong text-disabled"
          : "border-inverse bg-inverse text-on-inverse active:bg-inverse-hover",
      )}
    >
      <Icon name="check" size={16} />
      {pending ? "Sparar…" : label}
    </button>
  );
}

/** Ångra en packning (inom 30 minuter). */
export function UndoPackButton({ packingId }: { packingId: string }) {
  const toast = useToast();
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const res = await undoMysteryPack({ packingId });
          toast(
            res.ok
              ? { title: "Ångrat. Delarna är tillbaka.", tone: "neutral" }
              : { title: "Kunde inte ångra", description: res.error, tone: "critical" },
          );
        })
      }
      className="inline-flex h-11 shrink-0 items-center rounded-sm border border-line-strong px-3 text-sm font-medium text-fg hover:bg-hover disabled:border-dashed disabled:text-disabled"
    >
      {pending ? "Ångrar…" : "Ångra"}
    </button>
  );
}

/** Innehållet (etiketten) med "Ändra innehåll" för ägare och admin. */
export function ContentsSection({
  titleId,
  recipe,
  choices,
  canEdit,
}: {
  titleId: string;
  recipe: Recipe | null;
  choices: ReadonlyArray<{ id: string; name: string }>;
  canEdit: boolean;
}) {
  const [editing, setEditing] = useState(recipe === null);
  if (canEdit && (editing || recipe === null)) {
    return (
      <RecipeEditor
        titleId={titleId}
        recipe={recipe}
        choices={choices}
        onDone={() => setEditing(false)}
      />
    );
  }
  if (!recipe) {
    return <p className="text-base text-muted">Inget innehåll än. Ägaren lägger in det.</p>;
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
          Ändra innehåll
        </button>
      ) : null}
    </div>
  );
}
