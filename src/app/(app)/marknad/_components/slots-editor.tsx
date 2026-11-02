"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";

import { Button, IconButton } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { formatInt } from "@/lib/format";

import { saveSlots } from "../actions";
import type { Option } from "../_lib/types";

export interface SlotLine {
  readonly titleId: string;
  readonly slots: number;
}

/** Knapp och dialog för fackfördelningen i en automat. */
export function SlotsEditorButton({
  machineId,
  machineCode,
  titles,
  current,
  prefill,
  prefillNote,
  today,
  capacity,
  label,
}: {
  machineId: string;
  machineCode: string;
  titles: readonly Option[];
  /** Fackfördelningen i dag (tom om ingen finns). */
  current: readonly SlotLine[];
  /** Förifyllning när fackfördelning saknas. */
  prefill: readonly SlotLine[];
  prefillNote: string | null;
  today: string;
  capacity: number;
  label: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const start = current.length > 0 ? current : prefill;
  const [lines, setLines] = useState<{ titleId: string; slots: string }[]>(
    start.map((l) => ({ titleId: l.titleId, slots: String(l.slots) })),
  );
  const [validFrom, setValidFrom] = useState(today);
  const total = lines.reduce((s, l) => s + (Number(l.slots) || 0), 0);
  const used = new Set(lines.map((l) => l.titleId));

  function reset() {
    setLines(start.map((l) => ({ titleId: l.titleId, slots: String(l.slots) })));
    setValidFrom(today);
    setError(null);
  }

  function submit() {
    setError(null);
    startTransition(async () => {
      const result = await saveSlots({
        machineId,
        validFrom,
        lines: lines.filter((l) => l.titleId).map((l) => ({ titleId: l.titleId, slots: l.slots })),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      toast({ title: "Fackfördelningen sparad", meta: machineCode, tone: "ok" });
      router.refresh();
    });
  }

  return (
    <>
      <Button
        type="button"
        size="sm"
        variant={current.length > 0 ? "ghost" : "secondary"}
        onClick={() => {
          reset();
          setOpen(true);
        }}
      >
        {label}
      </Button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        eyebrow={`Fack / ${machineCode}`}
        title="Fackfördelning"
        description={
          current.length === 0 && prefillNote
            ? prefillNote
            : "Den nya fördelningen gäller från och med dagen nedan. Tidigare perioder sparas."
        }
      >
        <form
          className="flex flex-col gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            submit();
          }}
        >
          <ul className="flex flex-col gap-3">
            {lines.map((line, i) => (
              <li key={i} className="flex items-end gap-2">
                <Select
                  label={`Titel ${i + 1}`}
                  wrapperClassName="flex-1"
                  value={line.titleId}
                  onChange={(e) =>
                    setLines((ls) =>
                      ls.map((l, j) => (j === i ? { ...l, titleId: e.target.value } : l)),
                    )
                  }
                  options={[
                    { value: "", label: "Välj titel" },
                    ...titles.filter((t) => t.value === line.titleId || !used.has(t.value)),
                  ]}
                />
                <Input
                  label="Fack"
                  type="number"
                  min={1}
                  max={100}
                  wrapperClassName="w-20"
                  value={line.slots}
                  onChange={(e) =>
                    setLines((ls) =>
                      ls.map((l, j) => (j === i ? { ...l, slots: e.target.value } : l)),
                    )
                  }
                />
                <IconButton
                  type="button"
                  icon="close"
                  label={`Ta bort titel ${i + 1}`}
                  onClick={() => setLines((ls) => ls.filter((_, j) => j !== i))}
                />
              </li>
            ))}
          </ul>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Button
              type="button"
              size="sm"
              iconLeft="plus"
              onClick={() => setLines((ls) => [...ls, { titleId: "", slots: "1" }])}
            >
              Lägg till titel
            </Button>
            <p className="meta tnum text-subtle" aria-live="polite">
              {formatInt(total)} av {formatInt(capacity)} fack
            </p>
          </div>
          <Input
            label="Gäller från och med"
            type="date"
            value={validFrom}
            onChange={(e) => setValidFrom(e.target.value)}
            required
          />
          {error ? (
            <p role="alert" className="text-sm text-signal-fg">
              {error}
            </p>
          ) : null}
          <div className="flex flex-col-reverse gap-2 border-t border-line pt-4 sm:flex-row sm:justify-end">
            <Button type="button" onClick={() => setOpen(false)}>
              Avbryt
            </Button>
            <Button type="submit" variant="primary" loading={pending}>
              Spara fack
            </Button>
          </div>
        </form>
      </Modal>
    </>
  );
}
