"use client";

/**
 * Klientdelar för Ekonomi → Bokföring: VMB på/av, markera som skickad, kvitton (dra och
 * släpp, foto på mobilen) och kontoplanen.
 */

import { useRouter } from "next/navigation";
import { useRef, useState, useTransition, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { useToast } from "@/components/ui/toast";
import { parseAmountOre } from "@/import/amount";
import { cn } from "@/lib/cn";
import type { AccountPlan } from "@/server/bokforing/plan";

import {
  archiveReceipt,
  saveBokforingSettings,
  setBokforingVmb,
  setMonthSent,
  uploadReceipts,
} from "../bokforing-actions";
import { FormError } from "./bits";

const MB = 1024 * 1024;
/** Når förfrågan aldrig servern (nätet, plattformens storleksgräns) kastar anropet. */
const unreachable = (what: string) => ({
  ok: false as const,
  error: `${what} kom inte fram. Försök igen.`,
});
const ACCEPT =
  "application/pdf,image/jpeg,image/png,image/heic,image/heif,.pdf,.jpg,.jpeg,.png,.heic,.heif";
const OK_EXT = /\.(pdf|jpe?g|png|heic|heif)$/i;
const OK_TYPES = new Set([
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/heic",
  "image/heif",
]);
/** Namnet eller webbläsarens typ räcker här; servern avgör av innehållet. */
const acceptable = (f: File) => OK_EXT.test(f.name) || OK_TYPES.has(f.type);

/**
 * "VMB i bokföringen" (standard av). Av: paketet bokförs utan VMB-moms. Skickade månader
 * behåller sitt val. Läsaren ser läget utan att kunna ändra.
 */
export function VmbBookkeepingSwitch({ on, canEdit }: { on: boolean; canEdit: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-describedby="bokforing-vmb-hint"
        disabled={!canEdit || pending}
        onClick={() =>
          start(async () => {
            const res = await setBokforingVmb({ enabled: !on }).catch(() =>
              unreachable("Ändringen"),
            );
            if (res.ok) {
              router.refresh();
              toast({ title: on ? "VMB av" : "VMB på", tone: "ok" });
            } else {
              toast({ title: "Inte ändrad", description: res.error, tone: "critical" });
            }
          })
        }
        className={cn(
          "label flex h-8 items-center gap-2 rounded-sm border border-line-strong px-2.5 transition-colors disabled:cursor-not-allowed max-md:min-h-11",
          on ? "bg-hover font-medium text-fg" : "text-muted hover:text-fg",
          pending && "opacity-60",
        )}
      >
        <span
          aria-hidden
          className={cn(
            "inline-block size-2 rounded-xs border border-current",
            on ? "bg-current" : "bg-transparent",
          )}
        />
        VMB i bokföringen<span aria-hidden>: {on ? "på" : "av"}</span>
      </button>
      <span id="bokforing-vmb-hint" className="text-sm text-subtle">
        {on ? "Paketet bokförs med VMB-moms." : "Paketet bokförs utan VMB."}
      </span>
    </div>
  );
}

/** Markera som skickad / ångra. */
export function SentToggle({ month, sent }: { month: string; sent: boolean }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant={sent ? "ghost" : "secondary"}
      loading={pending}
      onClick={() =>
        start(async () => {
          const res = await setMonthSent({ month, sent: !sent }).catch(() =>
            unreachable("Ändringen"),
          );
          if (res.ok) {
            router.refresh();
            toast({ title: sent ? "Markeringen ångrad" : "Markerad som skickad", tone: "ok" });
          } else {
            toast({ title: "Inte ändrad", description: res.error, tone: "critical" });
          }
        })
      }
    >
      {sent ? "Ångra skickad" : "Markera som skickad"}
    </Button>
  );
}

/**
 * Kvitton: dra och släpp eller välj (kamera på mobilen). Laddas upp en i taget. `maxBytes` är
 * gränsen i miljön (10 MB, lägre där plattformen begränsar förfrågans storlek).
 */
export function ReceiptDrop({ month, maxBytes }: { month: string; maxBytes: number }) {
  const maxText = `${Math.floor(maxBytes / MB)} MB`;
  const router = useRouter();
  const toast = useToast();
  const input = useRef<HTMLInputElement>(null);
  const [over, setOver] = useState(false);
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();

  const send = (files: File[]) => {
    const bad = files.find((f) => f.size > maxBytes || !acceptable(f));
    if (bad) {
      setError(
        bad.size > maxBytes
          ? `${bad.name} är för stor (högst ${maxText}).`
          : `${bad.name}: bara PDF, JPG, PNG eller HEIC.`,
      );
      return;
    }
    if (files.length === 0) return;
    setError(undefined);
    start(async () => {
      let saved = 0;
      let duplicates = 0;
      for (const f of files) {
        const form = new FormData();
        form.set("month", month);
        form.append("file", f);
        // Når förfrågan aldrig appen (t.ex. plattformens storleksgräns) kastar anropet.
        const res = await uploadReceipts(form).catch(() => ({
          ok: false as const,
          error: `${f.name} kom inte fram. Försök igen, eller spara bilden mindre.`,
        }));
        if (!res.ok) {
          setError(res.error);
          break;
        }
        saved += res.data.saved;
        duplicates += res.data.duplicates;
      }
      if (input.current) input.current.value = "";
      if (saved + duplicates > 0) {
        router.refresh();
        toast({
          title: saved === 1 ? "Kvittot sparat" : `${saved} kvitton sparade`,
          description: duplicates > 0 ? `${duplicates} fanns redan.` : undefined,
          tone: "ok",
        });
      }
    });
  };

  return (
    <div className="flex flex-col gap-2">
      <label
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={(e) => {
          e.preventDefault();
          setOver(false);
          send(Array.from(e.dataTransfer.files));
        }}
        aria-busy={pending || undefined}
        className={cn(
          "flex min-h-16 cursor-pointer items-center justify-center rounded-sm border border-dashed px-4 py-3 text-center text-sm transition-colors",
          over ? "border-fg bg-hover text-fg" : "border-line-control text-muted hover:text-fg",
          pending && "opacity-60",
        )}
      >
        <input
          ref={input}
          type="file"
          multiple
          accept={ACCEPT}
          className="sr-only"
          onChange={(e) => send(Array.from(e.target.files ?? []))}
        />
        {pending
          ? "Laddar upp…"
          : `Släpp kvitton här eller tryck för att välja (PDF/bild, ${maxText})`}
      </label>
      <FormError message={error} />
    </div>
  );
}

export function ArchiveReceiptButton({ id }: { id: string }) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  return (
    <Button
      size="sm"
      variant="ghost"
      loading={pending}
      aria-label="Ta bort kvittot"
      onClick={() =>
        start(async () => {
          const res = await archiveReceipt({ id }).catch(() => unreachable("Ändringen"));
          if (res.ok) router.refresh();
          else toast({ title: "Inte borttaget", description: res.error, tone: "critical" });
        })
      }
    >
      Ta bort
    </Button>
  );
}

export interface PlanRow {
  readonly key: string;
  readonly use: string;
  readonly account: string;
  readonly proposal: string;
  readonly name: string;
}

/** Kontoplanen och inställningarna. Läsaren ser samma tabell utan att kunna ändra. */
export function PlanForm({
  rows,
  series,
  orgNumber,
  purchaseBasis,
  openingCarryOre,
  canEdit,
}: {
  rows: readonly PlanRow[];
  series: string;
  orgNumber: string | null;
  purchaseBasis: string;
  openingCarryOre: number;
  canEdit: boolean;
}) {
  const router = useRouter();
  const toast = useToast();
  const [error, setError] = useState<string>();
  const [pending, start] = useTransition();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    const carryText = String(f.get("carry") ?? "").trim();
    let carry = 0;
    if (carryText !== "") {
      const p = parseAmountOre(carryText);
      if (!p.ok) {
        setError(`Underskottet: ${p.message}`);
        return;
      }
      carry = p.ore;
    }
    const plan = Object.fromEntries(rows.map((r) => [r.key, String(f.get(`acc-${r.key}`) ?? "")]));
    setError(undefined);
    start(async () => {
      const res = await saveBokforingSettings({
        plan: plan as unknown as AccountPlan,
        series: String(f.get("series") ?? ""),
        orgNumber: String(f.get("orgNumber") ?? ""),
        purchaseBasis: String(f.get("basis")) as "received_purchases" | "cost_of_goods",
        openingCarryOre: carry,
      }).catch(() => unreachable("Kontoplanen"));
      if (!res.ok) {
        setError(res.error);
        return;
      }
      router.refresh();
      toast({ title: "Kontoplanen sparad", tone: "ok" });
    });
  };
  return (
    <form onSubmit={submit} className="flex flex-col gap-4" noValidate>
      <div className="overflow-x-auto">
        <table className="w-full min-w-[480px] text-sm">
          <thead>
            <tr className="label text-left text-muted">
              <th className="py-1.5 pr-3 font-normal">Används till</th>
              <th className="w-28 py-1.5 pr-3 font-normal">Konto</th>
              <th className="py-1.5 font-normal">Förslag (BAS)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.key} className="border-t border-line">
                <td className="py-1.5 pr-3 text-fg">{r.use}</td>
                <td className="py-1 pr-3">
                  <input
                    name={`acc-${r.key}`}
                    defaultValue={r.account}
                    inputMode="numeric"
                    maxLength={4}
                    aria-label={`Konto för ${r.use}`}
                    disabled={!canEdit}
                    className={cn(
                      "tnum h-8 w-20 rounded-sm border bg-bg px-2 text-fg disabled:border-dashed disabled:bg-transparent max-md:h-11",
                      r.account === r.proposal ? "border-line-control" : "border-fg",
                    )}
                  />
                </td>
                <td className="py-1.5 text-muted">
                  <span className="tnum">{r.proposal}</span> {r.name}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Input
          label="Verifikationsserie"
          name="series"
          defaultValue={series}
          maxLength={6}
          disabled={!canEdit}
        />
        <Input
          label="Organisationsnummer"
          name="orgNumber"
          defaultValue={orgNumber ?? ""}
          placeholder="NNNNNN-NNNN"
          inputMode="numeric"
          disabled={!canEdit}
        />
        <Select
          label="Inköp"
          name="basis"
          defaultValue={purchaseBasis}
          disabled={!canEdit}
          options={[
            { value: "received_purchases", label: "Mottagna inköp i månaden" },
            { value: "cost_of_goods", label: "Inköpsvärde sålda pack" },
          ]}
        />
        <Input
          label="Ingående underskott"
          name="carry"
          defaultValue={openingCarryOre ? String(openingCarryOre / 100).replace(".", ",") : ""}
          placeholder="0"
          suffix="kr"
          inputMode="decimal"
          disabled={!canEdit}
        />
      </div>
      <FormError message={error} />
      {canEdit ? (
        <div>
          <Button type="submit" loading={pending}>
            Spara kontoplan
          </Button>
        </div>
      ) : null}
    </form>
  );
}
