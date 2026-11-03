"use client";

import Link from "next/link";
import { useMemo, useRef, useState, useTransition, type FormEvent } from "react";

import { FormError } from "@/app/logga-in/form-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { cn } from "@/lib/cn";
import { contractHtml, type ContractParty } from "@/reports/contract-pdf";

import { createStoreGuide } from "../../_nya-automater/actions";
import { setContractStatus } from "../../avtal/actions";
import { SignOnSite } from "../../avtal/_components/sign-on-site";
import { TermsFields } from "../../avtal/_components/terms-fields";
import {
  checkTerms,
  DEFAULT_TERMS,
  guideTerms,
  previewHtml,
  termsPayload,
  type TermsDraft,
} from "../../avtal/_lib/terms";
import { finishStoreGuide } from "./actions";

export interface GuideMachine {
  /** source_machines.id */
  readonly id: string;
  readonly title: string;
  readonly code: string;
  readonly detail: string;
}

/** En plats från pipelinen (Expansion → Starta Ny butik). */
export interface GuideLead {
  readonly id: string;
  readonly name: string;
  readonly address: string;
  readonly city: string;
  readonly shareBp: number | null;
  readonly rentOre: number | null;
}

type MachineChoice = { kind: "awish"; id: string } | { kind: "new" } | { kind: "none" };

const STEPS = ["Butik", "Villkor", "Automat", "Kontrakt", "Klart"] as const;

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
        "flex min-h-14 w-full items-center gap-3 rounded-md border px-4 py-3 text-left transition-[border-color,background-color,transform] duration-fast active:scale-[0.99]",
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

function leadTerms(lead: GuideLead | null): TermsDraft {
  if (!lead || (lead.shareBp === null && lead.rentOre === null)) return DEFAULT_TERMS;
  return {
    ...DEFAULT_TERMS,
    preset: null,
    share: lead.shareBp === null ? "" : String(lead.shareBp / 100).replace(".", ","),
    rent: lead.rentOre === null ? "" : String(lead.rentOre / 100).replace(".", ","),
  };
}

/**
 * Guiden ett steg i taget, med stora knappar och förval: 50/50 vinst och automaten som
 * Awish hittat. Butiken och automaten sparas i steget Kontrakt, och guiden slutar alltid
 * med kontraktet (PDF klar att skriva ut eller signera på plats).
 */
export function StoreGuide({
  found,
  preselected,
  newCode,
  lead,
  operator,
  today,
}: {
  found: readonly GuideMachine[];
  preselected: string | null;
  newCode: string;
  lead: GuideLead | null;
  operator: ContractParty;
  today: string;
}) {
  const toast = useToast();
  const [step, setStep] = useState(0);
  const [name, setName] = useState(lead?.name ?? "");
  const [address, setAddress] = useState(lead?.address ?? "");
  const [city, setCity] = useState(lead?.city ?? "");
  const [terms, setTerms] = useState<TermsDraft>(() => leadTerms(lead));
  const [termsError, setTermsError] = useState<{
    message: string;
    field: "share" | "rent" | "special";
  }>();
  const [machine, setMachine] = useState<MachineChoice>(
    preselected
      ? { kind: "awish", id: preselected }
      : found[0]
        ? { kind: "awish", id: found[0].id }
        : { kind: "new" },
  );
  const [error, setError] = useState<string>();
  const [fieldError, setFieldError] = useState<string>();
  const [store, setStore] = useState<{ storeId: string; code: string | null } | null>(null);
  const [contract, setContract] = useState<{ id: string; pdf: boolean } | null>(null);
  const [signed, setSigned] = useState(false);
  const [pending, startTransition] = useTransition();
  const nameRef = useRef<HTMLInputElement>(null);

  const checked = useMemo(() => checkTerms(terms), [terms]);
  const preview = useMemo(() => {
    if (step !== 3 || !checked.ok) return "";
    return contractHtml({
      operator,
      store: { name: name.trim() || "Butiken", address: address.trim() || null },
      validFrom: today,
      ...checked.terms,
      specialTerms: checked.specialTerms,
      reference: "UTKAST",
    });
  }, [step, checked, operator, name, address, today]);

  /** Butik och automat (en gång), sedan kontraktet. Vid fel kan steget göras om. */
  const save = () =>
    startTransition(async () => {
      setError(undefined);
      let saved = store;
      if (!saved) {
        const result = await createStoreGuide({
          store: { name, address, city },
          terms: guideTerms(terms),
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
        saved = { storeId: result.data!.storeId, code: result.data!.machineCode };
        setStore(saved);
      }
      const res = await finishStoreGuide({
        storeId: saved.storeId,
        leadId: lead?.id ?? null,
        terms: termsPayload(terms),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      setContract({ id: res.data.contractId, pdf: res.data.pdf });
      setStep(4);
    });

  const markSigned = () =>
    startTransition(async () => {
      if (!contract) return;
      const res = await setContractStatus({ id: contract.id, status: "signed" });
      if (!res.ok) return setError(res.error);
      setSigned(true);
      toast({ title: "Signerat", tone: "ok" });
    });

  const next = (e: FormEvent) => {
    e.preventDefault();
    setFieldError(undefined);
    if (step === 0 && name.trim() === "") {
      setFieldError("Skriv butikens namn.");
      nameRef.current?.focus();
      return;
    }
    if (step === 1 && !checked.ok) {
      setTermsError({ message: checked.message, field: checked.field });
      return;
    }
    if (step < 3) {
      setStep(step + 1);
      return;
    }
    save();
  };

  return (
    <div className="flex flex-col gap-8">
      <ol aria-label="Steg" className="grid grid-cols-5 gap-2">
        {STEPS.map((label, i) => (
          <li key={label} className="flex min-w-0 flex-col gap-2">
            <span className="h-1 overflow-hidden rounded-xs bg-line">
              <span
                className="block h-full origin-left bg-fg transition-transform duration-500 ease-out"
                style={{ transform: `scaleX(${i <= step ? 1 : 0})` }}
              />
            </span>
            <span
              aria-current={i === step ? "step" : undefined}
              className={cn("label truncate", i <= step ? "text-fg" : "text-subtle")}
            >
              {label}
            </span>
          </li>
        ))}
      </ol>

      {step === 4 && store && contract ? (
        <div key="klart" className="rise flex flex-col gap-6">
          <div className="flex items-center gap-4">
            <span className="grid size-12 shrink-0 place-items-center rounded-full bg-up text-bg">
              <Icon name="check" size={20} />
            </span>
            <div className="flex min-w-0 flex-col">
              <p className="text-xl font-medium text-fg">Klart! {name.trim()} är tillagd.</p>
              <p className="text-base text-muted">
                {store.code ? `${store.code} står där. ` : ""}
                {signed ? "Kontraktet är signerat." : checked.ok ? `${checked.plain}.` : null}
              </p>
            </div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <a
              href={contract.pdf ? `/avtal/${contract.id}/fil` : `/avtal/${contract.id}/mall`}
              target={contract.pdf ? undefined : "_blank"}
              rel="noreferrer"
              className="inline-flex h-11 items-center justify-center gap-2 rounded-sm border border-line-strong bg-surface px-5 text-base font-medium text-fg hover:bg-hover"
            >
              <Icon name="download" size={16} />
              {contract.pdf ? "Ladda ner kontrakt" : "Skriv ut kontrakt"}
            </a>
            {!signed ? (
              <>
                <SignOnSite contractId={contract.id} storeName={name.trim()} large />
                <Button
                  variant="ghost"
                  loading={pending}
                  onClick={markSigned}
                  className="h-11 px-5 text-base"
                >
                  Markera som signerat
                </Button>
              </>
            ) : null}
            <Link
              href={`/butiker/${store.storeId}`}
              className="inline-flex h-11 items-center justify-center rounded-sm border border-line-strong bg-surface px-5 text-base font-medium text-fg hover:bg-hover"
            >
              Öppna butiken
            </Link>
          </div>
          <FormError message={error} />
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
                hint="För rutten."
              />
              <Input label="Ort" value={city} onChange={(e) => setCity(e.target.value)} />
            </>
          ) : null}

          {step === 1 ? (
            <TermsFields
              value={terms}
              onChange={(t) => {
                setTerms(t);
                setTermsError(undefined);
              }}
              error={termsError}
            />
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

          {step === 3 && checked.ok ? (
            <>
              <p className="text-lg font-medium text-fg">{checked.plain}</p>
              <iframe
                title="Kontraktet"
                srcDoc={previewHtml(preview)}
                sandbox=""
                className="bg-white h-[46dvh] w-full rounded-sm border border-line"
              />
            </>
          ) : null}

          <FormError message={error} />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            {step > 0 && !store ? (
              <Button type="button" onClick={() => setStep(step - 1)} disabled={pending}>
                Tillbaka
              </Button>
            ) : (
              <span />
            )}
            <Button type="submit" variant="primary" loading={pending} className="h-11 px-6">
              {step === 3 ? "Skapa kontrakt" : "Nästa"}
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}
