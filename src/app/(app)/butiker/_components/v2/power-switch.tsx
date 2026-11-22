"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button } from "@/components/v2/button";
import { toastUndo, toastV2 } from "@/components/v2/toast";

import { setStorePowerHours } from "../../actions";

const DEFAULT_HOURS = { on: "10:00", off: "21:00" } as const;

type Hours = { on: string; off: string };

/**
 * "Strömmen till automaten" i V2: brytaren "Stäng av på natten" och tiderna. Samma action
 * som butikens sida (setStorePowerHours, ägare och admin). Av sparas direkt med Ångra i
 * notisen; På sparas när tiderna är valda. Läsaren ser läget men kan inte ändra.
 */
export function PowerSwitch({
  storeId,
  storeName,
  initial,
  canEdit,
}: {
  storeId: string;
  storeName: string;
  initial: Hours | null;
  canEdit: boolean;
}) {
  const router = useRouter();
  const [saved, setSaved] = useState<Hours | null>(initial);
  const [on, setOn] = useState(initial !== null);
  const [hours, setHours] = useState<Hours>(initial ?? DEFAULT_HOURS);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const dirty = on
    ? saved === null || saved.on !== hours.on || saved.off !== hours.off
    : saved !== null;

  function save(next: Hours | null, before: Hours | null) {
    setError(null);
    start(async () => {
      const res = await setStorePowerHours({ storeId, hours: next });
      if (!res.ok) {
        setError(res.error);
        setOn(before !== null);
        toastV2("Sparades inte", { detail: res.error, tone: "critical" });
        return;
      }
      setSaved(next);
      router.refresh();
      toastUndo(
        next ? `Strömmen av ${next.off}–${next.on}` : "Strömmen är alltid på",
        next ? `${storeName}. Ingen offline-varning medan strömmen är av.` : storeName,
        () => {
          void setStorePowerHours({ storeId, hours: before }).then((undo) => {
            if (!undo.ok) {
              toastV2("Kunde inte ångra", { detail: undo.error, tone: "critical" });
              return;
            }
            setSaved(before);
            setOn(before !== null);
            if (before) setHours(before);
            router.refresh();
          });
        },
      );
    });
  }

  function toggle() {
    if (!canEdit || pending) return;
    const next = !on;
    setOn(next);
    if (!next && saved !== null) save(null, saved);
  }

  return (
    <div>
      <button
        type="button"
        role="switch"
        className="g4-switch"
        aria-checked={on}
        aria-disabled={!canEdit || pending}
        aria-label={`Stäng av strömmen på natten, ${storeName}`}
        onClick={toggle}
      >
        <span>
          <b>Stäng av på natten</b>
          <small>
            {saved
              ? `Av ${saved.off}–${saved.on}. Ingen offline-varning då.`
              : "Av: strömmen är alltid på."}
          </small>
        </span>
        <span className="tg" aria-hidden="true" />
      </button>
      {on && canEdit ? (
        <form
          className="g4-times"
          onSubmit={(e) => {
            e.preventDefault();
            save(hours, saved);
          }}
        >
          <label className="g4-field">
            Strömmen av
            <input
              type="time"
              required
              disabled={pending}
              value={hours.off}
              onChange={(e) => setHours((h) => ({ ...h, off: e.target.value }))}
            />
          </label>
          <label className="g4-field">
            Strömmen på
            <input
              type="time"
              required
              disabled={pending}
              value={hours.on}
              onChange={(e) => setHours((h) => ({ ...h, on: e.target.value }))}
            />
          </label>
          {dirty ? (
            <Button type="submit" variant="act" size="lg" pending={pending}>
              Spara tiderna
            </Button>
          ) : null}
        </form>
      ) : null}
      {error ? <p className="g4-err mt-2">{error}</p> : null}
    </div>
  );
}
