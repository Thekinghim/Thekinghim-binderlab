"use client";

import { useEffect, useMemo, useRef, useState, useTransition, type FormEvent } from "react";

import { createScopedStore, useScopedStore } from "@/app/fyll-pa/_lib/scoped-store";
import { FormError } from "@/app/logga-in/form-error";
import { useUnsavedWarning } from "@/components/pwa/unsaved-input";
import { Input } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { useToast } from "@/components/ui/toast";
import { Button as V2Button, ButtonLink } from "@/components/v2/button";
import { useUrlStep } from "@/components/v2/use-url-step";
import { useHydrated } from "@/lib/use-hydrated";
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

/** Det man har fyllt i, och vad som redan är sparat (butiken, kontraktet). */
interface GuideDraft {
  readonly name: string;
  readonly address: string;
  readonly city: string;
  readonly terms: TermsDraft;
  readonly machine: MachineChoice;
  readonly store: { storeId: string; code: string | null } | null;
  readonly contract: { id: string; pdf: boolean } | null;
  readonly signed: boolean;
}

/**
 * Utkastet ligger i flikens sessionStorage: ett svep bakåt, ett byte av flik eller en
 * omladdning tappar inte det man har skrivit. Glöms efter ett dygn och när fliken stängs.
 */
const draftStore = createScopedStore<GuideDraft>({
  key: "binderlab:ny-butik",
  maxAgeMs: 24 * 60 * 60_000,
});

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
  owner,
}: {
  found: readonly GuideMachine[];
  preselected: string | null;
  newCode: string;
  lead: GuideLead | null;
  operator: ContractParty;
  today: string;
  /** Organisation och användare: utkastet är personens eget (inte nästa inloggads). */
  owner: string;
}) {
  const toast = useToast();
  // Steget i adressen (?steg=2 … 5; Butik utan steg): svepet bakåt backar ett steg.
  const url = useUrlStep(STEPS.length);
  const step = url.step ?? 0;
  const toUrl = (s: number) => (s === 0 ? null : s);
  const hydrated = useHydrated();
  const scope = `${owner}|${lead?.id ?? ""}|${preselected ?? ""}`;
  const [saved, setDraft] = useScopedStore(draftStore, scope);
  const fresh = useMemo<GuideDraft>(
    () => ({
      name: lead?.name ?? "",
      address: lead?.address ?? "",
      city: lead?.city ?? "",
      terms: leadTerms(lead),
      machine: preselected
        ? { kind: "awish", id: preselected }
        : found[0]
          ? { kind: "awish", id: found[0].id }
          : { kind: "new" },
      store: null,
      contract: null,
      signed: false,
    }),
    [lead, preselected, found],
  );
  const draft = saved ?? fresh;
  const { name, address, city, terms, machine, store, contract, signed } = draft;
  const update = (patch: Partial<GuideDraft>) => setDraft({ ...draft, ...patch });
  const [termsError, setTermsError] = useState<{
    message: string;
    field: "share" | "rent" | "special";
  }>();
  const [error, setError] = useState<string>();
  const [fieldError, setFieldError] = useState<string>();
  const [pending, startTransition] = useTransition();
  const nameRef = useRef<HTMLInputElement>(null);
  // Kontraktet är just sparat och Klart är på väg in i adressen.
  const finishing = useRef(false);
  // Klart har visats: ett steg bakåt därifrån lämnar guiden (butiken finns redan).
  const shownDone = useRef(false);

  const checked = useMemo(() => checkTerms(terms), [terms]);
  // Längsta steg som går att visa med det som är ifyllt (sidan kan öppnas mitt i guiden).
  const reachable = contract && store ? 4 : name.trim() === "" ? 0 : checked.ok ? 3 : 1;
  const dirty =
    !contract &&
    (name !== fresh.name ||
      address !== fresh.address ||
      city !== fresh.city ||
      JSON.stringify(terms) !== JSON.stringify(fresh.terms));
  useUnsavedWarning(dirty);

  useEffect(() => {
    if (!hydrated) return;
    if (finishing.current) {
      // Klart står i adressen: härifrån lämnar ett steg bakåt guiden. (Det behövs ingen
      // ny rendering efter den här för att det ska gälla.)
      if (step === 4) {
        finishing.current = false;
        shownDone.current = true;
      }
      return;
    }
    if (contract) {
      if (step === 4) {
        shownDone.current = true;
        return;
      }
      // Bakåt från Klart, eller en färdig guide från förut: börja om på en tom guide.
      setDraft(null);
      if (shownDone.current) {
        shownDone.current = false;
        url.leave();
      }
      return;
    }
    if (step > reachable) url.replace(toUrl(reachable));
  });
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
      let savedStore = store;
      if (!savedStore) {
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
        savedStore = { storeId: result.data!.storeId, code: result.data!.machineCode };
        update({ store: savedStore });
      }
      const res = await finishStoreGuide({
        storeId: savedStore.storeId,
        leadId: lead?.id ?? null,
        terms: termsPayload(terms),
      });
      if (!res.ok) {
        setError(res.error);
        return;
      }
      // Utkastet först, sedan steget: Klart visas aldrig utan kontrakt.
      finishing.current = true;
      setDraft({
        ...draft,
        store: savedStore,
        contract: { id: res.data.contractId, pdf: res.data.pdf },
      });
      // Klart ersätter Kontrakt i historiken: ett steg bakåt lämnar guiden.
      url.replace(4);
    });

  const markSigned = () =>
    startTransition(async () => {
      if (!contract) return;
      const res = await setContractStatus({ id: contract.id, status: "signed" });
      if (!res.ok) return setError(res.error);
      update({ signed: true });
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
      url.push(step + 1);
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
                onChange={(e) => update({ name: e.target.value })}
                error={fieldError}
                autoFocus
                required
              />
              <Input
                label="Adress"
                value={address}
                onChange={(e) => update({ address: e.target.value })}
                hint="För rutten."
              />
              <Input label="Ort" value={city} onChange={(e) => update({ city: e.target.value })} />
            </>
          ) : null}

          {step === 1 ? (
            <TermsFields
              value={terms}
              onChange={(t) => {
                update({ terms: t });
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
                  onSelect={() => update({ machine: { kind: "awish", id: m.id } })}
                  title={`${m.title} (blir ${m.code})`}
                  hint={`Hittad i Awish · ${m.detail}`}
                />
              ))}
              <Choice
                checked={machine.kind === "new"}
                onSelect={() => update({ machine: { kind: "new" } })}
                title={`Ny automat (${newCode})`}
                hint="Kopplas när den syns i Awish."
              />
              <Choice
                checked={machine.kind === "none"}
                onSelect={() => update({ machine: { kind: "none" } })}
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
                onClick={() => url.back(toUrl(step - 1))}
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
