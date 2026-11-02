"use client";

import { useRouter } from "next/navigation";
import { useId, useState, useTransition, type FormEvent } from "react";

import { FormError } from "@/app/logga-in/form-error";
import { Button, IconButton } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { isIsoDate } from "@/domain";

import { saveOwnerShares } from "../_actions/settings";
import { bpToInput, formatBp, parsePercentInput, SETTINGS_MESSAGES } from "../_lib/model";

interface Line {
  key: number;
  name: string;
  share: string;
  memberUserId: string | null;
}

/** Ny fördelning av ägarandelar från ett datum. Visas bara för ägaren. */
export function OwnerSharesForm({
  initial,
  members,
  today,
}: {
  initial: ReadonlyArray<{ holderName: string; shareBp: number; memberUserId: string | null }>;
  members: ReadonlyArray<{ userId: string; name: string }>;
  today: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const listId = useId();
  const [lines, setLines] = useState<Line[]>(() =>
    (initial.length > 0
      ? initial
      : [
          {
            holderName: members[0]?.name ?? "",
            shareBp: 10_000,
            memberUserId: members[0]?.userId ?? null,
          },
        ]
    ).map((s, i) => ({
      key: i,
      name: s.holderName,
      share: bpToInput(s.shareBp),
      memberUserId: s.memberUserId,
    })),
  );
  const [validFrom, setValidFrom] = useState(today);
  const [error, setError] = useState<string>();
  const [pending, startTransition] = useTransition();

  const parsed = lines.map((l) => parsePercentInput(l.share, 10_000));
  const sum = parsed.reduce((n, p) => n + (p.ok ? p.bp : 0), 0);
  const allOk = parsed.every((p) => p.ok) && lines.every((l) => l.name.trim() !== "");

  const update = (key: number, patch: Partial<Line>) => {
    setError(undefined);
    setLines((ls) =>
      ls.map((l) => {
        if (l.key !== key) return l;
        const next = { ...l, ...patch };
        const name = patch.name;
        if (name !== undefined) {
          next.memberUserId = members.find((m) => m.name === name.trim())?.userId ?? null;
        }
        return next;
      }),
    );
  };

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!allOk) {
      setError(SETTINGS_MESSAGES.sharesInvalid);
      return;
    }
    if (sum !== 10_000) {
      setError(SETTINGS_MESSAGES.sharesSum(sum));
      return;
    }
    if (!isIsoDate(validFrom)) {
      setError("Ange från vilket datum fördelningen gäller.");
      return;
    }
    startTransition(async () => {
      const result = await saveOwnerShares({
        validFrom,
        shares: lines.map((l, i) => ({
          holderName: l.name.trim(),
          shareBp: (parsed[i] as { ok: true; bp: number }).bp,
          memberUserId: l.memberUserId,
        })),
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      toast({
        title: "Ägarandelarna sparade",
        description: lines
          .map((l, i) => `${l.name.trim()} ${formatBp((parsed[i] as { bp: number }).bp)}`)
          .join(", "),
        tone: "ok",
      });
      router.refresh();
    });
  };

  return (
    <form
      onSubmit={submit}
      noValidate
      className="flex flex-col gap-5"
      aria-label="Ny fördelning av ägarandelar"
    >
      <datalist id={listId}>
        {members.map((m) => (
          <option key={m.userId} value={m.name} />
        ))}
      </datalist>
      <ul className="flex flex-col gap-3">
        {lines.map((l, i) => (
          <li key={l.key} className="grid grid-cols-[minmax(0,1fr)_7rem_auto] items-end gap-3">
            <Input
              label={`Ägare ${i + 1}`}
              name={`holder-${i}`}
              list={listId}
              autoComplete="off"
              value={l.name}
              onChange={(e) => update(l.key, { name: e.target.value })}
            />
            <Input
              label="Andel"
              name={`share-${i}`}
              inputMode="decimal"
              autoComplete="off"
              suffix="%"
              className="tnum text-right"
              value={l.share}
              onChange={(e) => update(l.key, { share: e.target.value })}
              aria-invalid={!parsed[i]?.ok || undefined}
            />
            <IconButton
              icon="close"
              label={`Ta bort ${l.name.trim() || `ägare ${i + 1}`}`}
              variant="ghost"
              disabled={lines.length === 1}
              onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))}
            />
          </li>
        ))}
      </ul>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <Button
          type="button"
          size="sm"
          iconLeft="plus"
          onClick={() =>
            setLines((ls) => [
              ...ls,
              {
                key: Math.max(0, ...ls.map((x) => x.key)) + 1,
                name: "",
                share: "0",
                memberUserId: null,
              },
            ])
          }
        >
          Lägg till ägare
        </Button>
        <p className="meta tnum text-muted" aria-live="polite">
          Summa{" "}
          <span className={sum === 10_000 ? "text-fg" : "text-signal-fg"}>{formatBp(sum)}</span>
          {sum === 10_000 ? "" : " av 100 %"}
        </p>
      </div>
      <Input
        label="Gäller från"
        name="sharesValidFrom"
        type="date"
        value={validFrom}
        onChange={(e) => {
          setValidFrom(e.target.value);
          setError(undefined);
        }}
        hint="Tidigare fördelningar finns kvar och gäller fram till det här datumet."
        wrapperClassName="sm:max-w-[calc(50%-8px)]"
      />
      <FormError message={error} />
      <div className="flex justify-end border-t border-line pt-4">
        <Button type="submit" variant="primary" loading={pending}>
          Spara ägarandelar
        </Button>
      </div>
    </form>
  );
}
