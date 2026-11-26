"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState, useTransition, type FormEvent } from "react";

import { createScopedStore, useScopedStore } from "@/app/fyll-pa/_lib/scoped-store";
import { Button } from "@/components/ui/button";
import { Input, Select } from "@/components/ui/field";
import { Icon } from "@/components/ui/icon";
import { Modal } from "@/components/ui/modal";
import { useToast } from "@/components/ui/toast";
import { useUnsavedWarning } from "@/components/pwa/unsaved-input";
import { useUrlStep } from "@/components/v2/use-url-step";
import { cn } from "@/lib/cn";
import { contractHtml, type ContractParty } from "@/reports/contract-pdf";

import { FormError } from "../../ekonomi/_components/bits";
import { createContract, setContractStatus } from "../actions";
import {
  checkTerms,
  DEFAULT_TERMS,
  previewHtml,
  termsPayload,
  type TermsDraft,
} from "../_lib/terms";
import { firstSaleLabelFor, startHint } from "../_lib/model";
import { SignOnSite } from "./sign-on-site";
import { TermsFields } from "./terms-fields";

export interface CreateContractOption {
  readonly value: string;
  readonly label: string;
  /**
   * Föreslagen startdag: början på butikens villkor, annars första försäljningen, så att
   * kontraktet täcker allt automaten har sålt (suggestContractStart).
   */
  readonly suggestedFrom?: string | null;
  /** Butikens första försäljning, eller null. */
  readonly firstSale?: string | null;
  /** Butikens uppgifter i kontraktet (förhandsvisningen). */
  readonly party?: ContractParty;
}

const STEPS = ["Butik", "Villkor", "Kolla", "Klart"] as const;

type TermsError = { message: string; field: "share" | "rent" | "special" };

/** Det man har valt och skrivit. Ligger i flikens sessionStorage tills kontraktet är skapat. */
interface ContractDraft {
  readonly target: string;
  readonly validFrom: string;
  readonly terms: TermsDraft;
}

const draftStore = createScopedStore<ContractDraft>({
  key: "binderlab:nytt-kontrakt",
  maxAgeMs: 24 * 60 * 60_000,
});

/**
 * Skapa kontrakt i ett flöde: butik → villkor (snabbval) → se kontraktet (PDF:en som
 * förhandsvisning) → klart (ladda ner, signera på plats eller markera som signerat).
 * Kontraktet, villkoren och PDF:en sparas på servern i steg 3.
 *
 * Rutan och steget står i adressen (?steg=1 … 4): svepet bakåt backar ett steg, och från
 * första steget stänger det rutan, i stället för att lämna sidan och tappa villkoren.
 */
export function CreateContract({
  options,
  operator,
  today,
  initialTarget,
  autoOpen = false,
  orgNumberMissing,
  operatorGaps = [],
  firstContract = false,
  variant = "primary",
  large = false,
  label = "Skapa kontrakt",
}: {
  options: readonly CreateContractOption[];
  operator: ContractParty;
  today: string;
  /** Förvald butik ("store:{id}" eller "lead:{id}"). */
  initialTarget?: string;
  autoOpen?: boolean;
  orgNumberMissing: boolean;
  /** Våra rader som blir tomma i kontraktet (Inställningar → Företaget). */
  operatorGaps?: readonly string[];
  /** Inget kontrakt från mallen finns ännu: påminn en gång om att låta någon läsa mallen. */
  firstContract?: boolean;
  variant?: "primary" | "secondary";
  /** Stor knapp (sidans huvudåtgärd). */
  large?: boolean;
  label?: string;
}) {
  const router = useRouter();
  const toast = useToast();
  const first = initialTarget && options.some((o) => o.value === initialTarget);
  const url = useUrlStep(STEPS.length);
  const open = url.step !== null;
  const step = url.step ?? 0;
  const startOf = (value: string) => options.find((o) => o.value === value)?.suggestedFrom ?? today;
  const firstTarget = first ? initialTarget! : (options[0]?.value ?? "");
  const [saved, setDraft] = useScopedStore(draftStore, initialTarget ?? "");
  // Ett sparat utkast för en butik som inte längre går att välja glöms.
  const draft: ContractDraft =
    saved && options.some((o) => o.value === saved.target)
      ? saved
      : { target: firstTarget, validFrom: startOf(firstTarget), terms: DEFAULT_TERMS };
  const { target, validFrom, terms } = draft;
  const update = (patch: Partial<ContractDraft>) => setDraft({ ...draft, ...patch });
  const [termsError, setTermsError] = useState<TermsError>();
  const [confirm, setConfirm] = useState<string>();
  const [error, setError] = useState<string>();
  const [done, setDone] = useState<{
    id: string;
    storeName: string;
    pdf: boolean;
    /** Villkoren i klartext (utkastet är tömt när kontraktet är skapat). */
    plain: string | null;
  } | null>(null);
  const [signed, setSigned] = useState(false);
  const [pending, startTransition] = useTransition();

  const option = options.find((o) => o.value === target);
  const checked = useMemo(() => checkTerms(terms), [terms]);
  const firstSaleLabel = firstSaleLabelFor(option?.firstSale ?? null, validFrom, today);
  const preview = useMemo(() => {
    if (step !== 2 || !checked.ok || !option) return "";
    return contractHtml({
      operator,
      store: option.party ?? { name: option.label },
      validFrom: validFrom || today,
      ...checked.terms,
      specialTerms: checked.specialTerms,
      reference: "UTKAST",
    });
  }, [step, checked, option, operator, validFrom, today]);

  const reset = () => {
    setConfirm(undefined);
    setError(undefined);
    setTermsError(undefined);
    setDone(null);
    setSigned(false);
  };

  const close = () => {
    if (url.step !== null) url.back(null);
    if (done) router.refresh();
  };

  // ?skapa= öppnar rutan direkt (Att göra, butikssidan), utan ett extra steg i historiken.
  const { replace } = url;
  const openedAt = useRef(url.step);
  useEffect(() => {
    if (autoOpen && first && openedAt.current === null) replace(0);
  }, [autoOpen, first, replace]);

  // Klart (steg 4) utan kontrakt (sidan laddades om): tillbaka till Kolla.
  useEffect(() => {
    if (step === 3 && !done && !pending) replace(2);
  }, [step, done, pending, replace]);

  useUnsavedWarning(open && !done && JSON.stringify(terms) !== JSON.stringify(DEFAULT_TERMS));

  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setError(undefined);
    if (step === 0) {
      if (!target) return setError("Välj en butik.");
      if (!validFrom) return setError("Ange startdag.");
      return url.push(1);
    }
    if (step === 1) {
      if (!checked.ok) return setTermsError({ message: checked.message, field: checked.field });
      setTermsError(undefined);
      return url.push(2);
    }
    startTransition(async () => {
      const res = await createContract({
        target,
        validFrom,
        confirmHistory: Boolean(confirm),
        terms: termsPayload(terms),
      });
      if (!res.ok) {
        if (res.needsConfirm) setConfirm(res.error);
        else setError(res.error);
        return;
      }
      setDone({ ...res.data, plain: checked.ok ? checked.plain : null });
      setDraft(null);
      // Klart ersätter Kolla i historiken: bakåt därifrån skapar inte kontraktet igen.
      url.replace(3);
      toast({ title: `Klart! Kontrakt med ${res.data.storeName}.`, tone: "ok" });
    });
  };

  const markSigned = () =>
    startTransition(async () => {
      if (!done) return;
      const res = await setContractStatus({ id: done.id, status: "signed" });
      if (!res.ok) return setError(res.error);
      setSigned(true);
      toast({ title: "Signerat", tone: "ok" });
    });

  const big = "h-11 px-5 text-v2-md";

  if (options.length === 0) {
    return (
      <Link href="/butiker/ny" className="v2-btn act touch">
        <span aria-hidden>+</span>
        Ny butik
      </Link>
    );
  }

  return (
    <>
      <Button
        variant={variant}
        iconLeft="plus"
        className={large ? big : undefined}
        onClick={() => {
          reset();
          url.push(0);
        }}
      >
        {label}
      </Button>
      <Modal open={open} onClose={close} eyebrow="Kontrakt" title="Skapa kontrakt">
        <ol aria-label="Steg" className="mb-6 grid grid-cols-4 gap-2">
          {STEPS.map((s, i) => (
            <li key={s} className="flex min-w-0 flex-col gap-1.5">
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
                {s}
              </span>
            </li>
          ))}
        </ol>

        {step === 3 && done ? (
          <div className="v2-enter flex flex-col gap-6">
            <div className="flex items-center gap-4">
              <span className="text-white grid size-11 shrink-0 place-items-center rounded-full bg-v2-profit">
                <Icon name="check" size={20} />
              </span>
              <div className="flex min-w-0 flex-col">
                <p className="text-v2-lg font-[650] text-v2-ink">
                  Klart! Kontrakt med {done.storeName}.
                </p>
                <p className="text-v2-md text-v2-mute">{signed ? "Signerat." : done.plain}</p>
              </div>
            </div>
            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <a
                href={done.pdf ? `/avtal/${done.id}/fil` : `/avtal/${done.id}/mall`}
                target={done.pdf ? undefined : "_blank"}
                rel="noreferrer"
                className="v2-btn lg"
              >
                <Icon name="download" size={16} />
                {done.pdf ? "Ladda ner PDF" : "Skriv ut"}
              </a>
              {!signed ? (
                <>
                  <SignOnSite contractId={done.id} storeName={done.storeName} large />
                  <Button variant="ghost" loading={pending} onClick={markSigned} className={big}>
                    Markera som signerat
                  </Button>
                </>
              ) : null}
            </div>
            <FormError message={error} />
            <div className="flex justify-end">
              <Button type="button" onClick={close}>
                Stäng
              </Button>
            </div>
          </div>
        ) : (
          <form key={step} onSubmit={submit} noValidate className="v2-enter flex flex-col gap-5">
            {step === 0 ? (
              <>
                <Select
                  label="Butik"
                  value={target}
                  options={[...options]}
                  onChange={(e) => {
                    update({ target: e.target.value, validFrom: startOf(e.target.value) });
                    setConfirm(undefined);
                  }}
                />
                <Input
                  label="Gäller från"
                  type="date"
                  value={validFrom}
                  onChange={(e) => {
                    update({ validFrom: e.target.value });
                    setConfirm(undefined);
                  }}
                  hint={startHint(option?.firstSale ?? null, validFrom, today)}
                />
                {firstSaleLabel && option?.firstSale ? (
                  <button
                    type="button"
                    data-use-first-sale
                    onClick={() => {
                      update({ validFrom: option.firstSale ?? validFrom });
                      setConfirm(undefined);
                    }}
                    className="-mt-2 w-fit rounded-v2-sm text-v2-sm font-[550] text-v2-ink underline underline-offset-4 max-md:min-h-11"
                  >
                    {firstSaleLabel}
                  </button>
                ) : null}
                <Link
                  href="/butiker/ny"
                  className="w-fit rounded-v2-sm text-v2-sm text-v2-mute underline-offset-4 hover:text-v2-ink hover:underline max-md:tap"
                >
                  Ny butik{" "}→
                </Link>
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

            {step === 2 && checked.ok ? (
              <>
                <p className="text-v2-lg font-[550] text-v2-ink">{checked.plain}</p>
                <iframe
                  title="Kontraktet"
                  srcDoc={previewHtml(preview)}
                  sandbox=""
                  className="bg-white h-[46dvh] w-full rounded-v2 border border-v2-line"
                />
                {operatorGaps.length > 0 || orgNumberMissing ? (
                  <p className="text-v2-sm text-v2-crit-text">
                    Era uppgifter saknas i kontraktet (
                    {(operatorGaps.length > 0 ? operatorGaps : ["org.nr"]).join(", ")}).{" "}
                    <Link
                      href="/installningar#foretaget"
                      className="font-[550] underline underline-offset-2"
                    >
                      Fyll i dem
                    </Link>
                  </p>
                ) : null}
                {firstContract ? (
                  <p className="text-v2-sm text-v2-mute">Låt Talenom läsa mallen en gång.</p>
                ) : null}
                {confirm ? (
                  <p role="status" className="text-v2-sm text-v2-ink">
                    {confirm}
                  </p>
                ) : null}
              </>
            ) : null}

            <FormError message={error} />
            <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-between">
              {step > 0 ? (
                <Button type="button" onClick={() => url.back(step - 1)} disabled={pending}>
                  Tillbaka
                </Button>
              ) : (
                <Button type="button" onClick={close}>
                  Avbryt
                </Button>
              )}
              <Button type="submit" variant="primary" loading={pending} className="h-11 px-6">
                {step < 2 ? "Nästa" : confirm ? "Skapa ändå" : "Skapa kontrakt"}
              </Button>
            </div>
          </form>
        )}
      </Modal>
    </>
  );
}
