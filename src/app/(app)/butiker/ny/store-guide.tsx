"use client";

import { useMemo, useRef, useState, useTransition, type FormEvent } from "react";

import { FormError } from "@/app/logga-in/form-error";
import { Input } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { Button as V2Button, ButtonLink } from "@/components/v2/button";
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
        "flex min-h-14 w-full items-center gap-3 rounded-v2 border bg-v2-panel px-4 py-3 text-left transition-[border-color,background-color,transform] duration-150 active:scale-[0.99]",
        checked
          ? "border-v2-ink bg-v2-hover shadow-[inset_0_0_0_1px_var(--v2-ink)]"
          : "border-v2-line3 hover:bg-v2-hover",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "grid size-5 shrink-0 place-items-center rounded-full border",
          checked ? "text-white border-v2-ink bg-v2-ink" : "border-v2-line3",
        )}
      >
        {checked ? <Icon name="check" size={12} /> : null}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-v2-md font-[550] text-v2-ink">{title}</span>
        {hint ? <span className="text-v2-sm text-v2-mute">{hint}</span> : null}
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
    <div className="flex flex-col gap-6">
      <ol aria-label="Steg" className="grid grid-cols-5 gap-2">
        {STEPS.map((label, i) => (
          <li key={label} className="flex min-w-0 flex-col gap-2">
            <span className="h-1 overflow-hidden rounded-full bg-v2-line">
              <span
                className="block h-full origin-left bg-v2-ink transition-transform duration-300 ease-out"
                style={{ transform: `scaleX(${i <= step ? 1 : 0})` }}
              />
            </span>
            <span
              aria-current={i === step ? "step" : undefined}
              className={cn(
                "truncate text-v2-sm font-[550]",
                i <= step ? "text-v2-ink" : "text-v2-faint",
              )}
            >
              {label}
            </span>
          </li>
        ))}
      </ol>

      {step === 4 && store && contract ? (
        <div key="klart" className="v2-enter flex flex-col gap-6">
          <div className="flex items-center gap-4">
            <span className="text-white grid size-11 shrink-0 place-items-center rounded-full bg-v2-profit">
              <Icon name="check" size={20} />
            </span>
            <div className="flex min-w-0 flex-col">
              <p className="text-v2-lg font-[650] text-v2-ink">Klart! {name.trim()} är tillagd.</p>
              <p className="text-v2-md text-v2-mute">
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
              className="v2-btn lg"
            >
              <Icon name="download" size={16} />
              {contract.pdf ? "Ladda ner kontrakt" : "Skriv ut kontrakt"}
            </a>
            {!signed ? (
              <>
                <SignOnSite contractId={contract.id} storeName={name.trim()} large />
                <V2Button variant="plain" size="lg" pending={pending} onClick={markSigned}>
                  Markera som signerat
                </V2Button>
              </>
            ) : null}
            <ButtonLink href={`/butiker/${store.storeId}`} size="lg">
              Öppna butiken
            </ButtonLink>
          </div>
          <FormError message={error} />
        </div>
      ) : (
        <form key={step} onSubmit={next} noValidate className="v2-enter flex flex-col gap-5">
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
              <p className="text-v2-lg font-[550] text-v2-ink">{checked.plain}</p>
              <iframe
                title="Kontraktet"
                srcDoc={previewHtml(preview)}
                sandbox=""
                className="bg-white h-[46dvh] w-full rounded-v2 border border-v2-line"
              />
            </>
          ) : null}

          <FormError message={error} />
          <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
            {step > 0 && !store ? (
              <V2Button
                type="button"
                size="lg"
                onClick={() => setStep(step - 1)}
                disabled={pending}
              >
                Tillbaka
              </V2Button>
            ) : (
              <span />
            )}
            <V2Button type="submit" variant="act" size="lg" pending={pending} className="px-6">
              {step === 3 ? "Skapa kontrakt" : "Nästa"}
            </V2Button>
          </div>
        </form>
      )}
    </div>
  );
}
