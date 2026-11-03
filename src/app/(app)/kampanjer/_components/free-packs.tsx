"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";

import { Button, IconButton } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Modal } from "@/components/ui/modal";
import { QrCode } from "@/components/ui/qr-code";
import { Segmented } from "@/components/ui/segmented";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { formatInt, formatSek } from "@/lib/format";
import type { FreePackChoice, CreatedFreePacks } from "@/server/free-packs/service";

import { createFreePacks, loadFreePackChoices } from "../actions";
import { dayLabel } from "../_lib/display";

type Reason = "compensation" | "giveaway" | "staff" | "other";

const REASONS: { value: Reason; label: string; hint: string }[] = [
  { value: "compensation", label: "Kompensation", hint: "Något fastnade" },
  { value: "giveaway", label: "Giveaway", hint: "Sociala medier" },
  { value: "staff", label: "Butikspersonal", hint: "Belöning" },
  { value: "other", label: "Annat", hint: "" },
];

export interface FreePackMachine {
  machineId: string;
  code: string;
  name: string;
}

const kr = (ore: number) => formatSek(ore / 100);

const BIG =
  "flex min-h-14 w-full flex-col items-start justify-center rounded-md border px-4 py-3 text-left transition-colors duration-fast";

/** Texten att skicka (samma som shareText på servern). */
function messageFor(r: CreatedFreePacks, today: string): string {
  const many = r.codes.length > 1;
  return [
    `${many ? "Här är dina koder" : "Här är din kod"} för ${many ? `${r.codes.length} gratis pack` : "ett gratis pack"} ${r.goodName} i automaten ${r.machine.name}:`,
    ...r.codes,
    `Ange koden på automatens skärm. Gäller till och med ${dayLabel(r.expiresOn, today)}.`,
  ].join("\n");
}

/**
 * "Ge bort ett pack": ett steg i taget (automat → titel → antal och varför → bekräfta),
 * sedan koderna stora med QR och knappar för att kopiera eller dela. Koderna skapas i Awish
 * först efter "Ja, skapa".
 */
export function FreePackGiver({
  machines,
  today,
  initialMachineId,
  initialReason,
}: {
  machines: FreePackMachine[];
  today: string;
  initialMachineId: string | null;
  initialReason: Reason | null;
}) {
  const known = machines.find((m) => m.machineId === initialMachineId) ?? null;
  const [open, setOpen] = useState(known !== null);
  return (
    <>
      <Button
        variant="primary"
        iconLeft="plus"
        disabled={machines.length === 0}
        onClick={() => setOpen(true)}
      >
        Ge bort ett pack
      </Button>
      {open ? (
        <GiverDialog
          machines={machines}
          today={today}
          initialMachine={known}
          initialReason={initialReason}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </>
  );
}

type Step = "machine" | "title" | "details" | "confirm" | "done";

function GiverDialog({
  machines,
  today,
  initialMachine,
  initialReason,
  onClose,
}: {
  machines: FreePackMachine[];
  today: string;
  initialMachine: FreePackMachine | null;
  initialReason: Reason | null;
  onClose: () => void;
}) {
  const router = useRouter();
  const toast = useToast();
  const [pending, start] = useTransition();
  const [step, setStep] = useState<Step>(initialMachine ? "title" : "machine");
  const [machine, setMachine] = useState<FreePackMachine | null>(initialMachine);
  const [choices, setChoices] = useState<FreePackChoice[] | null>(null);
  const [choice, setChoice] = useState<FreePackChoice | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [days, setDays] = useState<"7" | "14" | "30">("14");
  const [reason, setReason] = useState<Reason | null>(initialReason);
  const [recipient, setRecipient] = useState("");
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CreatedFreePacks | null>(null);

  useEffect(() => {
    if (!machine || step !== "title") return;
    let alive = true;
    loadFreePackChoices(machine.machineId).then((r) => {
      if (!alive) return;
      if (r.ok) setChoices(r.data);
      else setError(r.error);
    });
    return () => {
      alive = false;
    };
  }, [machine, step]);

  const create = () =>
    start(async () => {
      if (!machine || !choice || !reason) return;
      setError(null);
      const r = await createFreePacks({
        machineId: machine.machineId,
        productId: choice.productId,
        quantity,
        days: Number(days),
        reason,
        recipient,
        note,
      });
      if (!r.ok) {
        setError(r.error);
        setStep("details");
        router.refresh();
        return;
      }
      setResult(r.data);
      setStep("done");
      router.refresh();
    });

  const name = choice?.titleName ?? choice?.goodName ?? "";
  const cost = choice?.unitCostOre === null || !choice ? null : choice.unitCostOre * quantity;

  const titles: Record<Step, string> = {
    machine: "Vilken automat?",
    title: "Vilket pack?",
    details: "Hur många och varför?",
    confirm: "Skapa koder?",
    done: result && result.codes.length > 1 ? "Klart! Här är koderna." : "Klart! Här är koden.",
  };

  const back: Partial<Record<Step, Step>> = {
    title: "machine",
    details: "title",
    confirm: "details",
  };

  return (
    <Modal
      open
      onClose={pending ? () => {} : onClose}
      eyebrow="Ge bort ett pack"
      title={titles[step]}
      footer={
        step === "done" ? (
          <Button variant="primary" onClick={onClose}>
            Klar
          </Button>
        ) : (
          <>
            {back[step] ? (
              <Button variant="ghost" disabled={pending} onClick={() => setStep(back[step]!)}>
                Tillbaka
              </Button>
            ) : (
              <Button variant="ghost" onClick={onClose}>
                Avbryt
              </Button>
            )}
            {step === "details" ? (
              <Button variant="primary" disabled={!reason} onClick={() => setStep("confirm")}>
                Fortsätt
              </Button>
            ) : step === "confirm" ? (
              <Button variant="primary" loading={pending} onClick={create}>
                Ja, skapa
              </Button>
            ) : null}
          </>
        )
      }
    >
      {step === "machine" ? (
        <div className="grid gap-2 sm:grid-cols-2">
          {machines.map((m) => (
            <button
              key={m.machineId}
              type="button"
              className={cn(BIG, "border-line-strong hover:bg-hover")}
              onClick={() => {
                setMachine(m);
                setChoice(null);
                setChoices(null);
                setError(null);
                setStep("title");
              }}
            >
              <span className="text-base font-medium">{m.code}</span>
              <span className="text-sm text-muted">{m.name}</span>
            </button>
          ))}
        </div>
      ) : null}

      {step === "title" ? (
        <div className="flex flex-col gap-2">
          <p className="text-sm text-muted">
            {machine?.code} · {machine?.name}
          </p>
          {error ? <p className="text-sm text-signal-fg">{error}</p> : null}
          {choices === null && !error ? (
            <p className="text-base text-muted" aria-live="polite">
              Hämtar automatens pack…
            </p>
          ) : null}
          {choices?.length === 0 ? <p className="text-base text-muted">Automaten är tom.</p> : null}
          {choices?.map((c) => {
            const empty = c.inMachine < 1;
            return (
              <button
                key={c.productId}
                type="button"
                disabled={empty}
                className={cn(
                  BIG,
                  empty
                    ? "cursor-not-allowed border-dashed border-line-strong text-disabled"
                    : "border-line-strong hover:bg-hover",
                )}
                onClick={() => {
                  setChoice(c);
                  setQuantity(1);
                  setStep("details");
                }}
              >
                <span className="text-base font-medium">{c.titleName ?? c.goodName}</span>
                <span className="text-sm text-muted">
                  {empty ? "Slut" : `${formatInt(c.inMachine)} i automaten`}
                  {c.unitCostOre !== null ? ` · ${kr(c.unitCostOre)} st` : ""}
                </span>
              </button>
            );
          })}
        </div>
      ) : null}

      {step === "details" && choice ? (
        <div className="flex flex-col gap-5">
          <p className="text-base font-medium">{name}</p>
          <div className="flex flex-col gap-2">
            <span className="label text-muted">Antal</span>
            <div className="flex items-center gap-3">
              <IconButton
                variant="secondary"
                label="En färre"
                icon="minus"
                disabled={quantity <= 1}
                onClick={() => setQuantity((q) => Math.max(1, q - 1))}
              />
              <span className="tnum min-w-10 text-center text-2xl font-medium" aria-live="polite">
                {quantity}
              </span>
              <IconButton
                variant="secondary"
                label="En till"
                icon="plus"
                disabled={quantity >= Math.min(20, choice.inMachine)}
                onClick={() => setQuantity((q) => Math.min(20, q + 1))}
              />
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="label text-muted">Varför</span>
            <div className="grid grid-cols-2 gap-2">
              {REASONS.map((r) => (
                <button
                  key={r.value}
                  type="button"
                  aria-pressed={reason === r.value}
                  onClick={() => setReason(r.value)}
                  className={cn(
                    BIG,
                    reason === r.value ? "border-fg bg-hover" : "border-line-strong hover:bg-hover",
                  )}
                >
                  <span className="text-base font-medium">{r.label}</span>
                  {r.hint ? <span className="text-xs text-muted">{r.hint}</span> : null}
                </button>
              ))}
            </div>
          </div>
          <div className="flex flex-col gap-2">
            <span className="label text-muted">Gäller</span>
            <Segmented
              label="Gäller"
              value={days}
              onChange={setDays}
              options={[
                { value: "7", label: "7 dagar" },
                { value: "14", label: "14 dagar" },
                { value: "30", label: "30 dagar" },
              ]}
            />
          </div>
          <Input
            label="Till (valfritt)"
            value={recipient}
            maxLength={80}
            placeholder="Namn eller @konto"
            onChange={(e) => setRecipient(e.target.value)}
          />
          <Input
            label="Anteckning (valfritt)"
            value={note}
            maxLength={200}
            onChange={(e) => setNote(e.target.value)}
          />
          {error ? <p className="text-sm text-signal-fg">{error}</p> : null}
        </div>
      ) : null}

      {step === "confirm" && choice && machine && reason ? (
        <div className="flex flex-col gap-3">
          <p className="text-xl font-medium">
            {quantity} × {name}
          </p>
          <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-base">
            <dt className="text-muted">Automat</dt>
            <dd>
              {machine.code} · {machine.name}
            </dd>
            <dt className="text-muted">Varför</dt>
            <dd>{REASONS.find((r) => r.value === reason)?.label}</dd>
            <dt className="text-muted">Gäller</dt>
            <dd>{days} dagar</dd>
            <dt className="text-muted">Kostar</dt>
            <dd>{cost === null ? "Inget inköpspris" : kr(cost)}</dd>
          </dl>
          {error ? <p className="text-sm text-signal-fg">{error}</p> : null}
        </div>
      ) : null}

      {step === "done" && result ? (
        <CodesView
          codes={result.codes}
          message={messageFor(result, today)}
          onCopied={() => toast({ title: "Kopierat", tone: "ok" })}
        />
      ) : null}
    </Modal>
  );
}

/** Koderna stora, med QR och knappar för att kopiera eller dela texten. */
export function CodesView({
  codes,
  message,
  onCopied,
}: {
  codes: string[];
  message: string;
  onCopied?: () => void;
}) {
  const [index, setIndex] = useState(0);
  if (codes.length === 0) {
    return (
      <p className="text-base text-muted">
        Koderna skapades men kunde inte läsas. Se Awish under hämtkoder.
      </p>
    );
  }
  const code = codes[Math.min(index, codes.length - 1)]!;
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";
  return (
    <div className="flex flex-col items-center gap-4">
      <QrCode value={code} label={`QR-kod för koden ${code}`} className="h-48 w-48 rounded-sm" />
      <p className="tnum text-center font-mono text-4xl font-medium tracking-[0.15em] break-all select-all">
        {code}
      </p>
      {codes.length > 1 ? (
        <div className="flex items-center gap-3">
          <IconButton
            variant="secondary"
            size="sm"
            icon="chevronLeft"
            label="Förra koden"
            disabled={index === 0}
            onClick={() => setIndex((i) => i - 1)}
          />
          <span className="tnum text-sm text-muted">
            {index + 1} av {codes.length}
          </span>
          <IconButton
            variant="secondary"
            size="sm"
            icon="chevronRight"
            label="Nästa kod"
            disabled={index >= codes.length - 1}
            onClick={() => setIndex((i) => i + 1)}
          />
        </div>
      ) : null}
      <div className="flex w-full flex-wrap justify-center gap-2">
        <Button
          variant="secondary"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(message);
              onCopied?.();
            } catch {
              // Kopiering nekad (t.ex. utan https): texten går att markera.
            }
          }}
        >
          Kopiera {codes.length > 1 ? "koderna" : "koden"}
        </Button>
        {canShare ? (
          <Button
            variant="secondary"
            onClick={() => navigator.share({ text: message }).catch(() => {})}
          >
            Dela
          </Button>
        ) : null}
      </div>
    </div>
  );
}

/** "Visa koder" i listan (ägare och admin). */
export function ShowCodesButton({ codes, message }: { codes: string[]; message: string }) {
  const [open, setOpen] = useState(false);
  const toast = useToast();
  return (
    <>
      <Button variant="ghost" size="sm" onClick={() => setOpen(true)}>
        {codes.length > 1 ? "Visa koder" : "Visa kod"}
      </Button>
      {open ? (
        <Modal
          open
          onClose={() => setOpen(false)}
          title={codes.length > 1 ? "Koderna" : "Koden"}
          footer={
            <Button variant="primary" onClick={() => setOpen(false)}>
              Klar
            </Button>
          }
        >
          <CodesView
            codes={codes}
            message={message}
            onCopied={() => toast({ title: "Kopierat", tone: "ok" })}
          />
        </Modal>
      ) : null}
    </>
  );
}
