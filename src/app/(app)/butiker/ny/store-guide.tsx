"use client";

import Link from "next/link";
import { useRef, useState, useTransition, type FormEvent } from "react";

import { FormError } from "@/app/logga-in/form-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/cn";

import { createStoreGuide } from "../../_nya-automater/actions";

export interface GuideMachine {
  /** source_machines.id */
  readonly id: string;
  readonly title: string;
  readonly code: string;
  readonly detail: string;
}

type Preset = "split" | "sales" | "rent";
type MachineChoice = { kind: "awish"; id: string } | { kind: "new" } | { kind: "none" };

const STEPS = ["Butik", "Villkor", "Automat", "Klart"] as const;

const PRESETS: ReadonlyArray<{ value: Preset; label: string; hint: string }> = [
  { value: "split", label: "50/50 vinst", hint: "Butiken får en andel av vinsten." },
  { value: "sales", label: "Procent av omsättning", hint: "En andel av försäljningen exkl. moms." },
  { value: "rent", label: "Fast hyra", hint: "Samma belopp varje månad." },
];

/** En stor valknapp (radio) i guiden. */
function Choice({
  checked,
  onSelect,
  title,
  hint,
}: {
  checked: boolean;
  onSelect: () => void;
  title: string;
  hint?: string;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={checked}
      onClick={onSelect}
      className={cn(
        "flex min-h-14 w-full items-center gap-3 rounded-md border px-4 py-3 text-left transition-[border-color,background-color] duration-fast",
        checked ? "border-fg bg-hover" : "border-line-control hover:bg-hover",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-full border",
          checked ? "border-fg bg-fg text-bg" : "border-line-control",
        )}
      >
        {checked ? <Icon name="check" size={12} /> : null}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-base font-medium text-fg">{title}</span>
        {hint ? <span className="text-sm text-muted">{hint}</span> : null}
      </span>
    </button>
  );
}

/**
 * Guiden ett steg i taget, med stora knappar och förval: 50/50 vinst och automaten som
 * Awish hittat (om den kom från Att göra). Allt sparas först i sista steget, i ett anrop.
 */
export function StoreGuide({
  found,
  preselected,
  newCode,
}: {
  found: readonly GuideMachine[];
  preselected: string | null;
  newCode: string;
}) {
  const [step, setStep] = useState(0);
  const [name, setName] = useState("");
  const [address, setAddress] = useState("");
  const [city, setCity] = useState("");
  const [preset, setPreset] = useState<Preset>("split");
  const [share, setShare] = useState("50");
  const [rent, setRent] = useState("");
  const [machine, setMachine] = useState<MachineChoice>(
    preselected
      ? { kind: "awish", id: preselected }
      : found[0]
        ? { kind: "awish", id: found[0].id }
        : { kind: "new" },
  );
  const [error, setError] = useState<string>();
  const [fieldError, setFieldError] = useState<string>();
  const [done, setDone] = useState<{ storeId: string; code: string | null } | null>(null);
  const [pending, startTransition] = useTransition();
  const nameRef = useRef<HTMLInputElement>(null);

  const pick = (p: Preset) => {
    setPreset(p);
    setFieldError(undefined);
    if (p === "split") setShare("50");
    if (p === "sales") setShare("");
  };

  const next = (e: FormEvent) => {
    e.preventDefault();
    setFieldError(undefined);
    if (step === 0 && name.trim() === "") {
      setFieldError("Skriv butikens namn.");
      nameRef.current?.focus();
      return;
    }
    if (step === 1 && preset === "sales" && share.trim() === "") {
      setFieldError("Skriv butikens andel i procent.");
      return;
    }
    if (step === 1 && preset === "rent" && rent.trim() === "") {
      setFieldError("Skriv hyran per månad.");
      return;
    }
    if (step < 2) {
      setStep(step + 1);
      return;
    }
    setError(undefined);
    startTransition(async () => {
      const result = await createStoreGuide({
        store: { name, address, city },
        terms: {
          preset,
          share: preset === "rent" ? "" : share,
          rent: preset === "rent" ? rent : "",
        },
        machine:
          machine.kind === "awish"
            ? { kind: "awish", sourceMachineId: machine.id }
            : machine.kind === "new"
              ? { kind: "new" }
              : null,
      });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setDone({ storeId: result.data!.storeId, code: result.data!.machineCode });
      setStep(3);
    });
  };

  const termsText =
    preset === "split"
      ? `${share || "50"} % av vinsten`
      : preset === "sales"
        ? `${share} % av omsättningen`
        : `${rent} kr/mån`;

  return (
    <div className="flex flex-col gap-8">
      <ol aria-label="Steg" className="grid grid-cols-4 gap-2">
        {STEPS.map((label, i) => (
          <li key={label} className="flex flex-col gap-2">
            <span className="h-1 overflow-hidden rounded-xs bg-line">
              <span
                className="block h-full origin-left bg-fg transition-transform duration-500 ease-out"
                style={{ transform: `scaleX(${i <= step ? 1 : 0})` }}
              />
            </span>
            <span
              aria-current={i === step ? "step" : undefined}
              className={cn("label", i <= step ? "text-fg" : "text-subtle")}
            >
              {label}
            </span>
          </li>
        ))}
      </ol>

      {step === 3 && done ? (
        <div key="klart" className="rise flex flex-col gap-6">
          <div className="flex items-center gap-4">
            <span className="grid size-12 place-items-center rounded-full bg-fg text-bg">
              <Icon name="check" size={20} />
            </span>
            <div className="flex flex-col">
              <p className="text-xl font-medium text-fg">Klart! {name.trim()} är tillagd.</p>
              <p className="text-base text-muted">
                {done.code ? `${done.code} står där. ` : ""}
                {termsText}.
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row">
            <Link
              href={`/avtal?skapa=store:${done.storeId}`}
              className="inline-flex h-11 items-center justify-center rounded-sm border border-inverse bg-inverse px-5 text-base font-medium text-on-inverse hover:bg-inverse-hover"
            >
              Skapa kontrakt
            </Link>
            <Link
              href={`/butiker/${done.storeId}`}
              className="inline-flex h-11 items-center justify-center rounded-sm border border-line-strong bg-surface px-5 text-base font-medium text-fg hover:bg-hover"
            >
              Öppna butiken
            </Link>
          </div>
        </div>
      ) : (
        <form key={step} onSubmit={next} noValidate className="rise flex flex-col gap-6">
          {step === 0 ? (
            <>
              <Input
                ref={nameRef}
                label="Butikens namn"
                value={name}
                onChange={(e) => setName(e.target.value)}
                error={fieldError}
                autoFocus
                required
              />
              <Input
                label="Adress"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                hint="För rutten och kartan."
              />
              <Input label="Ort" value={city} onChange={(e) => setCity(e.target.value)} />
            </>
          ) : null}

          {step === 1 ? (
            <>
              <div role="radiogroup" aria-label="Villkor" className="flex flex-col gap-2">
                {PRESETS.map((p) => (
                  <Choice
                    key={p.value}
                    checked={preset === p.value}
                    onSelect={() => pick(p.value)}
                    title={p.label}
                    hint={p.hint}
                  />
                ))}
              </div>
              {preset === "rent" ? (
                <Input
                  label="Hyra per månad"
                  inputMode="decimal"
                  suffix="kr"
                  value={rent}
                  onChange={(e) => setRent(e.target.value)}
                  error={fieldError}
                  autoFocus
                />
              ) : (
                <Input
                  label="Butikens andel"
                  inputMode="decimal"
                  suffix="%"
                  value={share}
                  onChange={(e) => setShare(e.target.value)}
                  error={fieldError}
                />
              )}
            </>
          ) : null}

          {step === 2 ? (
            <div role="radiogroup" aria-label="Automat" className="flex flex-col gap-2">
              {found.map((m) => (
                <Choice
                  key={m.id}
                  checked={machine.kind === "awish" && machine.id === m.id}
                  onSelect={() => setMachine({ kind: "awish", id: m.id })}
                  title={`${m.title} (blir ${m.code})`}
                  hint={`Hittad i Awish · ${m.detail}`}
                />
              ))}
              <Choice
                checked={machine.kind === "new"}
                onSelect={() => setMachine({ kind: "new" })}
                title={`Ny automat (${newCode})`}
                hint="Kopplas när den syns i Awish."
              />
              <Choice
                checked={machine.kind === "none"}
                onSelect={() => setMachine({ kind: "none" })}
                title="Ingen automat än"
              />
            </div>
          ) : null}

          <FormError message={error} />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            {step > 0 ? (
              <Button type="button" onClick={() => setStep(step - 1)} disabled={pending}>
                Tillbaka
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" variant="primary" loading={pending} className="h-11 px-6">
              {step === 2 ? "Klar" : "Nästa"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
